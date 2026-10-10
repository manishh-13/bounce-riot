import { describe, it, expect } from 'vitest';
import { createDynamoStore } from './dynamo-store.mjs';
import { createHarness } from './test-helpers.mjs';

// Evaluates exactly the condition expressions the store issues and, like DynamoDB, rejects unused or undefined placeholders.
function fakeDoc(now) {
  const items = new Map();
  const calls = [];
  const fail = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  function checkPlaceholders(p) {
    const text = [p.ConditionExpression, p.UpdateExpression].filter(Boolean).join(' ');
    for (const k of Object.keys(p.ExpressionAttributeNames ?? {})) if (!text.includes(k)) throw new Error(`unused name ${k}`);
    for (const k of Object.keys(p.ExpressionAttributeValues ?? {})) if (!text.includes(k)) throw new Error(`unused value ${k}`);
    for (const k of text.match(/#\w+/g) ?? []) if (!(k in (p.ExpressionAttributeNames ?? {}))) throw new Error(`undefined name ${k}`);
    for (const k of text.match(/:\w+/g) ?? []) if (!(k in (p.ExpressionAttributeValues ?? {}))) throw new Error(`undefined value ${k}`);
  }
  function condition(p, item) {
    const v = p.ExpressionAttributeValues ?? {};
    switch (p.ConditionExpression) {
      case undefined: return true;
      case 'attribute_not_exists(#pk) OR #exp <= :now': return !item || item.exp <= v[':now'];
      case '#ver = :ver': return !!item && item.ver === v[':ver'];
      case 'attribute_not_exists(#pk)': return !item;
      case '#room = :room AND #role = :role': return !!item && item.room === v[':room'] && item.role === v[':role'];
      case 'attribute_not_exists(#n) OR #n < :limit': return !item || item.n === undefined || item.n < v[':limit'];
      default: throw new Error(`unexpected condition ${p.ConditionExpression}`);
    }
  }
  const tick = () => new Promise((r) => setImmediate(r));
  const doc = {
    async get(p) {
      calls.push(['get', p]);
      await tick();
      expect(p.ConsistentRead).toBe(true);
      const item = items.get(p.Key.pk);
      return { Item: item ? structuredClone(item) : undefined };
    },
    async put(p) {
      calls.push(['put', p]);
      checkPlaceholders(p);
      await tick();
      if (!condition(p, items.get(p.Item.pk))) throw fail();
      items.set(p.Item.pk, structuredClone(p.Item));
    },
    async update(p) {
      calls.push(['update', p]);
      checkPlaceholders(p);
      await tick();
      const item = items.get(p.Key.pk);
      if (!condition(p, item)) throw fail();
      expect(p.UpdateExpression).toBe('ADD #n :one SET #ttl = :ttl');
      const next = { ...(item ?? { pk: p.Key.pk }) };
      next.n = (next.n ?? 0) + p.ExpressionAttributeValues[':one'];
      next.ttl = p.ExpressionAttributeValues[':ttl'];
      items.set(p.Key.pk, next);
    },
    async delete(p) {
      calls.push(['delete', p]);
      checkPlaceholders(p);
      await tick();
      if (!condition(p, items.get(p.Key.pk))) throw fail();
      items.delete(p.Key.pk);
    },
  };
  return { doc, items, calls };
}

function dynamoHarness() {
  let fake;
  const h = createHarness({
    store: (now) => {
      fake = fakeDoc(now);
      return createDynamoStore({ doc: fake.doc, table: 'rooms', now });
    },
  });
  return { h, fake };
}

describe('DynamoDB store', () => {
  it('runs the room lifecycle with TTL attributes and hashed tokens only', async () => {
    const { h, fake } = dynamoHarness();
    const created = await h.create();
    const joined = await h.join('p0', created.room);
    expect(joined).toMatchObject({ type: 'joined', slot: 0 });
    const room = fake.items.get(`R#${created.room}`);
    expect(room.ttl).toBe(Math.ceil(room.exp / 1000));
    expect(room.exp - h.now()).toBe(2 * 60 * 60 * 1000);
    const conn = fake.items.get('C#p0');
    expect(conn).toMatchObject({ room: created.room, role: 'player', pid: joined.id });
    expect(Number.isInteger(conn.ttl)).toBe(true);
    const all = JSON.stringify([...fake.items.values()]);
    expect(all).not.toContain(created.token);
    expect(all).not.toContain(joined.token);
    await h.send('host', { action: 'close' });
    expect(fake.items.has(`R#${created.room}`)).toBe(false);
    expect(fake.items.has('C#p0')).toBe(false);
  });

  it('forwards relay messages with reads only', async () => {
    const { h, fake } = dynamoHarness();
    const created = await h.create();
    await h.join('p0', created.room);
    fake.calls.length = 0;
    for (let i = 0; i < 10; i++) await h.send('p0', { action: 'relay', to: 'host', data: { seq: i } });
    expect(h.ofType('host', 'relay')).toHaveLength(10);
    expect(fake.calls.every(([op]) => op === 'get')).toBe(true);
    expect(fake.calls).toHaveLength(20);
  });

  it('serializes concurrent joins with conditional writes', async () => {
    const { h, fake } = dynamoHarness();
    const { room } = await h.create();
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`);
    await Promise.all(ids.map((id) => h.send(id, { action: 'join', room, name: id })));
    expect(ids.filter((id) => h.said(id).some((m) => m.type === 'joined'))).toHaveLength(8);
    expect(fake.items.get(`R#${room}`).data.players).toHaveLength(8);
    expect(new Set(fake.items.get(`R#${room}`).data.players.map((p) => p.slot)).size).toBe(8);
  });

  it('reuses an expired code and keeps resume races single-winner', async () => {
    const { h, fake } = dynamoHarness();
    const store = createDynamoStore({ doc: fake.doc, table: 'rooms', now: h.now });
    const room = { code: 'ABCDEF', hostTokenHash: 'x', hostConn: 'h', hostOnline: true, players: [], createdAt: h.now(), expiresAt: h.now() + 1000 };
    expect(await store.createRoom({ ...room })).toBe(true);
    expect(await store.createRoom({ ...room })).toBe(false);
    const a = await store.getRoom('ABCDEF');
    const b = await store.getRoom('ABCDEF');
    expect(await store.updateRoom(a, a.ver)).toBe(true);
    expect(await store.updateRoom(b, b.ver)).toBe(false);
    h.advance(1000);
    expect(await store.createRoom({ ...room, expiresAt: h.now() + 1000 })).toBe(true);
  });

  it('counts rate windows with a conditional counter', async () => {
    const { h, fake } = dynamoHarness();
    const store = createDynamoStore({ doc: fake.doc, table: 'rooms', now: h.now });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.hit('create:ip', 3, 60_000));
    expect(results).toEqual([true, true, true, false]);
    h.advance(60_000);
    expect(await store.hit('create:ip', 3, 60_000)).toBe(true);
  });

  it('surfaces non-conditional DynamoDB errors', async () => {
    const store = createDynamoStore({
      doc: { put: async () => { throw Object.assign(new Error('x'), { name: 'ThrottlingException' }); } },
      table: 't',
    });
    await expect(store.putConn({ id: 'a', room: 'R', role: 'host', expiresAt: 1 })).rejects.toThrow('x');
  });
});
