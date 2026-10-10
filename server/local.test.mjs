import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startLocalServer } from './local.mjs';
import { runSmoke, SmokeClient } from './smoke.mjs';

let server;
let url;
beforeAll(async () => {
  server = await startLocalServer({ port: 0, host: '127.0.0.1', log: () => {} });
  url = `ws://127.0.0.1:${server.port}`;
});
afterAll(() => server.close());

describe('local WebSocket server', () => {
  it('serves /health', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'bounce-riot-room-service' });
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404);
  });

  it('passes the full protocol smoke end to end', async () => {
    await runSmoke(url);
  });

  it('caps a room at 8 phones and restores a reconnecting phone to its slot', async () => {
    const clients = [];
    const open = async () => { const c = await SmokeClient.open(url, 'http://localhost:4381'); clients.push(c); return c; };
    try {
      const host = await open();
      const { room } = await host.request({ action: 'create' }, 'created');
      const phones = [];
      for (let i = 0; i < 8; i++) {
        const c = await open();
        phones.push({ c, joined: await c.request({ action: 'join', room, name: `P${i}` }, 'joined') });
      }
      const ninth = await open();
      expect(await ninth.request({ action: 'join', room, name: 'late' }, 'error')).toMatchObject({ code: 'room-full' });
      const { c, joined } = phones[4];
      await c.close();
      const back = await open();
      const rejoined = await back.request({ action: 'join', room, token: joined.token }, 'joined');
      expect(rejoined).toMatchObject({ id: joined.id, slot: 4 });
      expect(rejoined.roster).toHaveLength(8);
      back.send({ action: 'relay', to: 'host', data: { kind: 'hello' } });
      expect(await host.next((m) => m.type === 'relay')).toEqual({ type: 'relay', from: joined.id, data: { kind: 'hello' } });
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
});
