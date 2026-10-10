import { describe, it, expect } from 'vitest';
import { LIMITS, ROOM_ALPHABET, newRoomCode, sanitizeName, originAllowed, parseOriginPolicy, cleanSignalData, tokenMatches, hashToken } from './hub.mjs';
import { createHarness } from './test-helpers.mjs';

const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{6}$`);

async function roomWith(h, n) {
  const created = await h.create();
  const players = [];
  for (let i = 0; i < n; i++) players.push(await h.join(`p${i}`, created.room));
  return { created, players };
}

describe('helpers', () => {
  it('room codes are 6 non-ambiguous characters with no obvious repetition', () => {
    expect(ROOM_ALPHABET).not.toMatch(/[IO01L]/);
    const codes = new Set(Array.from({ length: 500 }, newRoomCode));
    for (const c of codes) expect(c).toMatch(CODE_RE);
    expect(codes.size).toBe(500);
  });

  it('sanitizes names to 16 visible characters', () => {
    expect(sanitizeName('  Zed <b>\u0000\u202E  Hi ')).toBe('Zed b Hi');
    expect(sanitizeName('ＡＢＣ')).toBe('ABC');
    expect(Array.from(sanitizeName('x'.repeat(100)))).toHaveLength(16);
    expect(sanitizeName('😀'.repeat(20))).toBe('😀'.repeat(16));
    expect(sanitizeName(42)).toBe('');
  });

  it('checks browser origins against the allowlist', () => {
    const prod = parseOriginPolicy('https://manishh-13.github.io,http://localhost:4381');
    expect(originAllowed('https://manishh-13.github.io', prod)).toBe(true);
    expect(originAllowed('http://localhost:4381', prod)).toBe(true);
    expect(originAllowed('http://localhost:9999', prod)).toBe(false);
    expect(originAllowed('https://evil.example', prod)).toBe(false);
    expect(originAllowed('https://manishh-13.github.io.evil.example', prod)).toBe(false);
    expect(originAllowed(undefined, prod)).toBe(false);
    const dev = parseOriginPolicy('local-dev', { allowMissing: true });
    expect(originAllowed(undefined, dev)).toBe(true);
    for (const o of ['http://192.168.1.4:4381', 'http://10.0.0.2:4381', 'http://172.20.1.1', 'http://127.0.0.1:4381', 'http://localhost']) {
      expect(originAllowed(o, dev), o).toBe(true);
    }
    for (const o of ['http://8.8.8.8:4381', 'http://172.32.0.1', 'http://localhost.evil.example', 'null', 'file://']) {
      expect(originAllowed(o, dev), o).toBe(false);
    }
  });

  it('accepts only well-formed signal data and strips extra fields', () => {
    expect(cleanSignalData({ description: { type: 'offer', sdp: 'v=0', extra: 1 } })).toEqual({ description: { type: 'offer', sdp: 'v=0' } });
    expect(cleanSignalData({ candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, junk: true } })).toEqual({ candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
    expect(cleanSignalData({ candidate: null })).toEqual({ candidate: null });
    expect(cleanSignalData({})).toBeNull();
    expect(cleanSignalData({ description: { type: 'evil', sdp: '' } })).toBeNull();
    expect(cleanSignalData({ description: { type: 'offer', sdp: 'x'.repeat(15_001) } })).toBeNull();
    expect(cleanSignalData({ candidate: { candidate: 'c' }, from: 'host' })).toBeNull();
    expect(cleanSignalData([{ candidate: null }])).toBeNull();
  });

  it('compares token hashes and rejects malformed tokens', () => {
    const token = 'A'.repeat(43);
    expect(tokenMatches(hashToken(token), token)).toBe(true);
    expect(tokenMatches(hashToken(token), 'B'.repeat(43))).toBe(false);
    expect(tokenMatches(hashToken(token), token + '=')).toBe(false);
  });
});

describe('create and join', () => {
  it('creates a room and stores only a token hash', async () => {
    const h = createHarness();
    const created = await h.create();
    expect(created).toMatchObject({ type: 'created', roster: [], hostOnline: true, version: 1 });
    expect(created.room).toMatch(CODE_RE);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = JSON.stringify(await h.store.getRoom(created.room));
    expect(stored).not.toContain(created.token);
    expect(stored).toContain(hashToken(created.token));
  });

  it('assigns server ids and slots, ignoring client-supplied identity fields', async () => {
    const h = createHarness();
    const { room } = await h.create();
    const joined = await h.join('a', room, { name: ' <Ann> ', id: 'host', slot: 5, role: 'host', from: 'host' });
    expect(joined).toMatchObject({ type: 'joined', room, slot: 0, hostOnline: true });
    expect(joined.id).toMatch(/^p[0-9a-f]{12}$/);
    expect(joined.roster).toEqual([{ id: joined.id, name: 'Ann', slot: 0, connected: true }]);
    expect(h.last('host')).toMatchObject({ type: 'roster', roster: joined.roster, hostOnline: true });
    const second = await h.join('b', room, { name: '' });
    expect(second).toMatchObject({ slot: 1 });
    expect(second.roster[1].name).toBe('Player 2');
  });

  it('accepts lower-case codes and rejects unknown or malformed ones', async () => {
    const h = createHarness();
    const { room } = await h.create();
    expect(await h.join('a', room.toLowerCase())).toMatchObject({ type: 'joined', room });
    expect(await h.join('b', 'ZZZZZZ')).toMatchObject({ type: 'error', code: 'room-not-found' });
    expect(await h.join('c', 'abc')).toMatchObject({ type: 'error', code: 'bad-request' });
  });

  it('binds one room per connection', async () => {
    const h = createHarness();
    const { room } = await h.create();
    await h.send('host', { action: 'create' });
    expect(h.last('host')).toMatchObject({ code: 'already-in-room' });
    await h.join('a', room);
    expect(await h.join('a', room)).toMatchObject({ code: 'already-in-room' });
  });

  it('caps rooms at 8 players', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 8);
    expect(players.map((p) => p.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await h.join('late', created.room)).toMatchObject({ type: 'error', code: 'room-full' });
  });

  it('never seats more than 8 under concurrent joins', async () => {
    const h = createHarness();
    const { room } = await h.create();
    const ids = Array.from({ length: 14 }, (_, i) => `c${i}`);
    await Promise.all(ids.map((id) => h.send(id, { action: 'join', room, name: id })));
    const joined = ids.map((id) => h.said(id).find((m) => m.type === 'joined')).filter(Boolean);
    const full = ids.filter((id) => h.errors(id).includes('room-full'));
    expect(joined).toHaveLength(8);
    expect(full).toHaveLength(6);
    expect(new Set(joined.map((m) => m.slot)).size).toBe(8);
    const stored = await h.store.getRoom(room);
    expect(stored.players).toHaveLength(8);
    for (const id of full) expect(await h.store.getConn(id)).toBeNull();
    expect(ids.flatMap((id) => h.errors(id)).filter((c) => c !== 'room-full')).toEqual([]);
  });

  it('roster versions increase with every membership write', async () => {
    const h = createHarness();
    const { room, version } = await h.create();
    const a = await h.join('a', room);
    const b = await h.join('b', room);
    expect(a.version).toBeGreaterThan(version);
    expect(b.version).toBeGreaterThan(a.version);
    const versions = h.ofType('host', 'roster').map((m) => m.version);
    expect(versions).toEqual([...versions].sort((x, y) => x - y));
  });

  it('a newcomer may reclaim the seat of a long-offline phone in a full room', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 8);
    await h.hub.disconnect({ connectionId: 'p3' });
    expect(await h.join('n1', created.room)).toMatchObject({ code: 'room-full' });
    h.advance(LIMITS.reclaimOfflineMs);
    const n2 = await h.join('n2', created.room);
    expect(n2).toMatchObject({ type: 'joined', slot: 3 });
    expect(await h.join('p3b', created.room, { token: players[3].token })).toMatchObject({ code: 'invalid-token' });
  });

  it('limits room creation per IP', async () => {
    const h = createHarness();
    for (let i = 0; i < LIMITS.ip.create.limit; i++) await h.send(`h${i}`, { action: 'create' }, '198.51.100.1');
    await h.send('hx', { action: 'create' }, '198.51.100.1');
    expect(h.last('hx')).toMatchObject({ code: 'rate-limited' });
    await h.send('hy', { action: 'create' }, '198.51.100.2');
    expect(h.last('hy')).toMatchObject({ type: 'created' });
    h.advance(LIMITS.ip.create.windowMs);
    await h.send('hz', { action: 'create' }, '198.51.100.1');
    expect(h.last('hz')).toMatchObject({ type: 'created' });
  });

  it('limits join attempts per connection to slow code guessing', async () => {
    const h = createHarness();
    for (let i = 0; i < 12; i++) await h.send('g', { action: 'join', room: 'ZZZZZZ', name: 'g' });
    expect(h.errors('g').slice(0, LIMITS.rate.control.burst).every((c) => c === 'room-not-found')).toBe(true);
    expect(h.errors('g')).toContain('rate-limited');
  });
});

describe('tokens and reconnection', () => {
  it('an invalid or foreign token never takes a seat', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 1);
    const other = await h.create('host2');
    const theirs = await h.join('q', other.room);
    for (const token of ['A'.repeat(43), theirs.token, created.token, 'short', 123]) {
      const id = `x${String(token).slice(0, 3)}`;
      expect(await h.join(id, created.room, { token })).toMatchObject({ type: 'error', code: 'invalid-token' });
      expect(await h.store.getConn(id)).toBeNull();
    }
    const room = await h.store.getRoom(created.room);
    expect(room.players.map((p) => p.id)).toEqual([players[0].id]);
  });

  it('a dropped phone keeps its seat and resumes it with its token', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 0);
    const a = await h.join('a', created.room, { name: 'Ann' });
    await h.join('b', created.room, { name: 'Bob' });
    await h.hub.disconnect({ connectionId: 'a' });
    expect(h.last('host').roster.find((p) => p.id === a.id).connected).toBe(false);
    expect(h.last('b').roster.find((p) => p.id === a.id).connected).toBe(false);
    const back = await h.join('a2', created.room, { token: a.token, name: 'Imposter' });
    expect(back).toMatchObject({ type: 'joined', id: a.id, slot: a.slot, token: a.token });
    expect(back.roster.find((p) => p.id === a.id)).toEqual({ id: a.id, name: 'Ann', slot: 0, connected: true });
  });

  it('when two connections resume one seat at once, only the winner can act', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 0);
    const a = await h.join('a', created.room);
    await Promise.all([h.send('r1', { action: 'join', room: created.room, token: a.token }), h.send('r2', { action: 'join', room: created.room, token: a.token })]);
    const room = await h.store.getRoom(created.room);
    const holder = room.players[0].conn;
    expect(['r1', 'r2']).toContain(holder);
    const loser = holder === 'r1' ? 'r2' : 'r1';
    expect(room.players).toHaveLength(1);
    for (const stale of [loser, 'a']) {
      h.clear(stale);
      await h.send(stale, { action: 'relay', to: 'host', data: { kind: 'input' } });
      expect(h.errors(stale)).toEqual(['not-in-room']);
    }
    h.clear('host');
    await h.send(holder, { action: 'relay', to: 'host', data: { kind: 'input' } });
    expect(h.last('host')).toEqual({ type: 'relay', from: a.id, data: { kind: 'input' } });
    expect(h.closed).toContain('a');
  });

  it('host resume invalidates the old host connection', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 1);
    await h.send('evil', { action: 'resume', room: created.room, token: players[0].token });
    expect(h.last('evil')).toMatchObject({ code: 'invalid-token' });
    await h.send('host2', { action: 'resume', room: created.room, token: created.token });
    expect(h.last('host2')).toMatchObject({ type: 'created', room: created.room, token: created.token, hostOnline: true });
    expect(h.last('host2').roster).toHaveLength(1);
    expect(h.last('host')).toMatchObject({ type: 'error', code: 'replaced' });
    expect(h.closed).toContain('host');
    for (const action of [{ action: 'relay', to: 'all', data: {} }, { action: 'kick', id: players[0].id }, { action: 'close' }]) {
      h.clear('host');
      await h.send('host', action);
      expect(h.errors('host')).toEqual(['not-in-room']);
    }
    expect((await h.store.getRoom(created.room)).players).toHaveLength(1);
    h.clear('p0');
    await h.send('host2', { action: 'relay', to: 'all', data: { kind: 'status' } });
    expect(h.last('p0')).toEqual({ type: 'relay', from: 'host', data: { kind: 'status' } });
  });

  it('a stale connection disconnecting does not knock the new one offline', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 1);
    await h.send('host2', { action: 'resume', room: created.room, token: created.token });
    await h.send('p0b', { action: 'join', room: created.room, token: players[0].token });
    await h.hub.disconnect({ connectionId: 'host' });
    await h.hub.disconnect({ connectionId: 'p0' });
    const room = await h.store.getRoom(created.room);
    expect(room.hostOnline).toBe(true);
    expect(room.hostConn).toBe('host2');
    expect(room.players[0]).toMatchObject({ connected: true, conn: 'p0b' });
  });

  it('host disconnect notifies phones and the room survives for resume', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 2);
    await h.hub.disconnect({ connectionId: 'host' });
    expect(h.ofType('p0', 'host-offline')).toHaveLength(1);
    expect(h.last('p1')).toMatchObject({ type: 'roster', hostOnline: false });
    h.clear('p0');
    await h.send('p0', { action: 'relay', to: 'host', data: {} });
    expect(h.errors('p0')).toEqual(['peer-offline']);
    await h.send('host2', { action: 'resume', room: created.room, token: created.token });
    expect(h.last('p0')).toMatchObject({ type: 'roster', hostOnline: true });
  });
});

describe('expiry', () => {
  it('expires rooms after 2 hours regardless of storage TTL', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 1);
    h.advance(LIMITS.roomTtlMs - 1);
    await h.send('p0', { action: 'roster' });
    expect(h.last('p0')).toMatchObject({ type: 'roster' });
    h.advance(1);
    await h.send('p0', { action: 'relay', to: 'host', data: {} });
    expect(h.last('p0')).toMatchObject({ code: 'room-expired' });
    expect(await h.join('late', created.room)).toMatchObject({ code: 'room-not-found' });
    await h.send('host9', { action: 'resume', room: created.room, token: created.token });
    expect(h.last('host9')).toMatchObject({ code: 'room-not-found' });
  });
});

describe('leave, close, kick', () => {
  it('explicit player leave frees the seat and notifies everyone', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 2);
    await h.send('p0', { action: 'leave' });
    expect(h.last('host').roster.map((p) => p.id)).toEqual([players[1].id]);
    expect(h.last('p1').roster.map((p) => p.id)).toEqual([players[1].id]);
    expect(await h.join('p0b', created.room, { token: players[0].token })).toMatchObject({ code: 'invalid-token' });
    expect(await h.join('n', created.room)).toMatchObject({ slot: 0 });
  });

  it('host leave puts the room offline without closing it', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 1);
    await h.send('host', { action: 'leave' });
    expect(h.ofType('p0', 'host-offline')).toHaveLength(1);
    await h.send('host', { action: 'create' });
    expect(h.last('host')).toMatchObject({ type: 'created' });
    await h.send('host2', { action: 'resume', room: created.room, token: created.token });
    expect(h.last('host2')).toMatchObject({ type: 'created', room: created.room });
  });

  it('only the host can close, and closing removes everyone', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 2);
    await h.send('p0', { action: 'close' });
    expect(h.last('p0')).toMatchObject({ code: 'forbidden' });
    await h.send('host', { action: 'close' });
    for (const id of ['p0', 'p1', 'host']) expect(h.last(id)).toEqual({ type: 'room-closed' });
    expect(await h.store.getRoom(created.room)).toBeNull();
    await h.send('p0', { action: 'relay', to: 'host', data: {} });
    expect(h.last('p0')).toMatchObject({ code: 'not-in-room' });
    expect(await h.join('n', created.room)).toMatchObject({ code: 'room-not-found' });
  });

  it('only the host can kick; a kicked phone loses its seat and token', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 2);
    await h.send('p1', { action: 'kick', id: players[0].id });
    expect(h.last('p1')).toMatchObject({ code: 'forbidden' });
    await h.send('host', { action: 'kick', id: 'p000000000000' });
    expect(h.last('host')).toMatchObject({ code: 'unknown-peer' });
    await h.send('host', { action: 'kick', id: players[0].id });
    expect(h.ofType('p0', 'error').at(-1)).toMatchObject({ code: 'kicked' });
    expect(h.closed).toContain('p0');
    expect(h.last('p1').roster.map((p) => p.id)).toEqual([players[1].id]);
    await h.send('p0', { action: 'relay', to: 'host', data: {} });
    expect(h.last('p0')).toMatchObject({ code: 'not-in-room' });
    expect(await h.join('p0b', created.room, { token: players[0].token })).toMatchObject({ code: 'invalid-token' });
  });
});

describe('forwarding', () => {
  it('relays inputs to the host with the server-assigned sender', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 2);
    h.clear('host');
    await h.send('p0', { action: 'relay', to: 'host', from: players[1].id, data: { kind: 'input', seq: 3, x: 1, z: 0, action: true } });
    expect(h.last('host')).toEqual({ type: 'relay', from: players[0].id, data: { kind: 'input', seq: 3, x: 1, z: 0, action: true } });
  });

  it('enforces role boundaries on targets', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 2);
    const cases = [
      ['p0', { action: 'relay', to: players[1].id, data: {} }, 'forbidden'],
      ['p0', { action: 'relay', to: 'all', data: {} }, 'forbidden'],
      ['p0', { action: 'signal', to: players[1].id, data: { candidate: null } }, 'forbidden'],
      ['host', { action: 'relay', to: 'host', data: {} }, 'bad-request'],
      ['host', { action: 'signal', to: 'all', data: { candidate: null } }, 'bad-request'],
      ['host', { action: 'relay', to: 'p999999999999', data: {} }, 'unknown-peer'],
      ['host', { action: 'relay', to: players[0].id, data: 'text' }, 'bad-request'],
      ['host', { action: 'relay', to: players[0].id, data: [1] }, 'bad-request'],
      ['host', { action: 'signal', to: players[0].id, data: { sdp: 'x' } }, 'bad-request'],
      ['outsider', { action: 'relay', to: 'host', data: {} }, 'not-in-room'],
      ['outsider', { action: 'roster' }, 'not-in-room'],
    ];
    for (const [id, msg, code] of cases) {
      h.clear(id);
      await h.send(id, msg);
      expect(h.errors(id), JSON.stringify(msg)).toEqual([code]);
    }
  });

  it('host can target one phone or broadcast to connected phones only', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 3);
    await h.hub.disconnect({ connectionId: 'p2' });
    ['p0', 'p1', 'p2', 'host'].forEach(h.clear);
    await h.send('host', { action: 'relay', to: players[1].id, data: { kind: 'feedback', event: 'hit' } });
    expect(h.said('p1')).toEqual([{ type: 'relay', from: 'host', data: { kind: 'feedback', event: 'hit' } }]);
    expect(h.said('p0')).toEqual([]);
    await h.send('host', { action: 'relay', to: 'all', data: { kind: 'status' } });
    expect(h.said('p0')).toEqual([{ type: 'relay', from: 'host', data: { kind: 'status' } }]);
    expect(h.said('p2')).toEqual([]);
    expect(h.said('host')).toEqual([]);
    await h.send('host', { action: 'relay', to: players[2].id, data: {} });
    expect(h.errors('host')).toEqual(['peer-offline']);
  });

  it('forwards cleaned WebRTC signals both ways', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 1);
    await h.send('host', { action: 'signal', to: players[0].id, data: { description: { type: 'offer', sdp: 'v=0', x: 1 } } });
    expect(h.last('p0')).toEqual({ type: 'signal', from: 'host', data: { description: { type: 'offer', sdp: 'v=0' } } });
    await h.send('p0', { action: 'signal', to: 'host', data: { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } } });
    expect(h.last('host')).toEqual({ type: 'signal', from: players[0].id, data: { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } } });
  });

  it('reports a peer whose socket is gone as offline', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 1);
    h.gone.add('p0');
    await h.send('host', { action: 'relay', to: players[0].id, data: {} });
    expect(h.errors('host')).toEqual(['peer-offline']);
  });

  it('relaying does not write the room', async () => {
    const h = createHarness();
    const { created } = await roomWith(h, 2);
    const before = (await h.store.getRoom(created.room)).ver;
    for (let i = 0; i < 20; i++) await h.send('p0', { action: 'relay', to: 'host', data: { kind: 'input', seq: i } });
    await h.send('host', { action: 'relay', to: 'all', data: {} });
    expect((await h.store.getRoom(created.room)).ver).toBe(before);
  });
});

describe('rate limits and errors', () => {
  it('lets 8 phones at 20 Hz plus host status through', async () => {
    const h = createHarness();
    const { players } = await roomWith(h, 8);
    h.clear('host');
    for (let tick = 0; tick < 40; tick++) {
      h.advance(50);
      await Promise.all(players.map((_, i) => h.send(`p${i}`, { action: 'relay', to: 'host', data: { kind: 'input', seq: tick } })));
      if (tick % 5 === 0) await Promise.all(players.map((p) => h.send('host', { action: 'relay', to: p.id, data: { kind: 'status' } })));
    }
    expect(h.ofType('host', 'relay')).toHaveLength(8 * 40);
    for (let i = 0; i < 8; i++) expect(h.errors(`p${i}`)).toEqual([]);
    expect(h.errors('host')).toEqual([]);
  });

  it('throttles a flooding phone and its error replies', async () => {
    const h = createHarness();
    await roomWith(h, 1);
    h.clear('host');
    for (let i = 0; i < 200; i++) await h.send('p0', { action: 'relay', to: 'host', data: { seq: i } });
    expect(h.ofType('host', 'relay')).toHaveLength(LIMITS.rate.player.burst);
    expect(h.errors('p0').length).toBeLessThanOrEqual(LIMITS.rate.errorReply.burst);
    expect(new Set(h.errors('p0'))).toEqual(new Set(['rate-limited']));
    h.advance(1000);
    await h.send('p0', { action: 'relay', to: 'host', data: { seq: 'after' } });
    expect(h.last('host')).toMatchObject({ data: { seq: 'after' } });
  });

  it('throttles any connection before touching storage', async () => {
    const h = createHarness();
    let reads = 0;
    const getConn = h.store.getConn;
    h.store.getConn = (...a) => (reads++, getConn(...a));
    for (let i = 0; i < 1000; i++) await h.send('spam', { action: 'roster' });
    expect(reads).toBe(LIMITS.rate.message.burst);
  });

  it('returns sensible errors for malformed input', async () => {
    const h = createHarness();
    const cases = [
      ['not json', 'bad-request'],
      ['[]', 'bad-request'],
      ['null', 'bad-request'],
      ['{}', 'bad-request'],
      ['{"action":5}', 'bad-request'],
      ['{"action":"explode"}', 'unknown-action'],
      ['{"action":"__proto__"}', 'unknown-action'],
      ['{"action":"constructor"}', 'unknown-action'],
      ['{"action":"hasOwnProperty"}', 'unknown-action'],
      ['{"action":"ping","at":"x"}', 'bad-request'],
      ['{"action":"ping"}', 'bad-request'],
      [JSON.stringify({ action: 'ping', at: 1, pad: 'x'.repeat(LIMITS.maxMessageBytes) }), 'too-large'],
      ['{"action":"resume","room":"ABCDEF"}', 'invalid-token'],
      ['{"action":"kick","id":"host"}', 'bad-request'],
    ];
    for (const [raw, code] of cases) {
      h.clear('c');
      await h.send('c', raw);
      expect(h.errors('c'), raw.slice(0, 40)).toEqual([code]);
    }
    await h.send('c', { action: 'ping', at: 12.5 });
    expect(h.last('c')).toEqual({ type: 'pong', at: 12.5 });
  });

  it('reports storage failures as internal without details', async () => {
    const h = createHarness();
    h.store.getConn = async () => {
      throw Object.assign(new Error('secret table detail'), { name: 'ProvisionedThroughputExceededException' });
    };
    await h.send('c', { action: 'roster' });
    expect(h.last('c')).toEqual({ type: 'error', code: 'internal', message: 'Something went wrong, please retry' });
    expect(h.logs.join()).not.toContain('secret table detail');
  });
});

describe('connect', () => {
  it('rejects foreign origins and connection floods per IP', async () => {
    const h = createHarness();
    expect(await h.hub.connect({ connectionId: 'a', ip: '1.2.3.4', origin: 'https://evil.example' })).toEqual({ ok: false, status: 403 });
    expect(await h.hub.connect({ connectionId: 'a', ip: '1.2.3.4', origin: 'https://manishh-13.github.io' })).toMatchObject({ ok: true });
    for (let i = 1; i < LIMITS.ip.connect.limit; i++) await h.hub.connect({ connectionId: `c${i}`, ip: '1.2.3.4', origin: 'https://manishh-13.github.io' });
    expect(await h.hub.connect({ connectionId: 'z', ip: '1.2.3.4', origin: 'https://manishh-13.github.io' })).toEqual({ ok: false, status: 429 });
    expect(await h.hub.connect({ connectionId: 'y', ip: '1.2.3.5', origin: 'https://manishh-13.github.io' })).toMatchObject({ ok: true });
  });
});

describe('privacy', () => {
  it('never logs tokens, room codes, names or payloads', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 2);
    await h.send('p0', { action: 'relay', to: 'host', data: { secret: 'payload-marker' } });
    await h.send('host', { action: 'resume', room: created.room, token: created.token });
    await h.send('host2', { action: 'resume', room: created.room, token: created.token });
    await h.send('p1', { action: 'leave' });
    await h.hub.connect({ connectionId: 'e', ip: '9.9.9.9', origin: 'https://evil.example' });
    await h.send('host2', { action: 'close' });
    const logs = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const secret of [created.token, created.room, players[0].token, players[0].id, 'p0', 'payload-marker', '9.9.9.9', '203.0.113.7']) {
      expect(logs).not.toContain(secret);
    }
  });

  it('never sends a token to anyone but its owner', async () => {
    const h = createHarness();
    const { created, players } = await roomWith(h, 3);
    await h.hub.disconnect({ connectionId: 'p1' });
    await h.join('p1b', created.room, { token: players[1].token });
    const tokens = [created.token, ...players.map((p) => p.token)];
    for (const [id, owned] of [['host', created.token], ['p0', players[0].token], ['p1b', players[1].token], ['p2', players[2].token]]) {
      const seen = JSON.stringify(h.said(id));
      for (const t of tokens) if (t !== owned) expect(seen, id).not.toContain(t);
    }
  });
});
