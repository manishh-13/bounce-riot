// End-to-end protocol check against a running room service (local or deployed).
// Usage: node server/smoke.mjs wss://<api>.execute-api.<region>.amazonaws.com/prod [origin]
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const DEFAULT_ORIGIN = 'https://manishh-13.github.io';

export class SmokeClient {
  static open(url, origin = DEFAULT_ORIGIN) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { origin });
      const client = new SmokeClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('unexpected-response', (req, res) => {
        // With this listener attached, ws leaves the rejected HTTP exchange to us; release it so the process can exit.
        res.resume();
        req.destroy();
        ws.terminate();
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      });
      ws.once('error', reject);
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    this.closed = new Promise((r) => ws.once('close', (code) => r(code)));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const i = this.waiters.findIndex((w) => w.match(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
      else this.inbox.push(msg);
    });
  }

  send(msg) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  next(match = () => true, timeoutMs = 5000) {
    const pred = typeof match === 'string' ? (m) => m.type === match : match;
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match: pred, resolve: (m) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out waiting for ${typeof match === 'string' ? match : 'message'}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async request(msg, match) {
    this.send(msg);
    return this.next(match);
  }

  close() {
    if (this.ws.readyState === WebSocket.CLOSED) return this.closed;
    this.ws.close();
    const force = setTimeout(() => this.ws.terminate(), 2000);
    return this.closed.finally(() => clearTimeout(force));
  }
}

const isError = (code) => (m) => m.type === 'error' && m.code === code;

export async function runSmoke(url, { origin = DEFAULT_ORIGIN, log = () => {} } = {}) {
  const step = (name) => log(`ok ${name}`);
  const clients = [];
  const open = async () => {
    const c = await SmokeClient.open(url, origin);
    clients.push(c);
    return c;
  };
  try {
    await assert.rejects(SmokeClient.open(url, 'https://evil.example'), (err) => err.status === 403);
    step('foreign origin rejected');

    const host = await open();
    const pong = await host.request({ action: 'ping', at: 42 }, 'pong');
    assert.deepEqual(pong, { type: 'pong', at: 42 });
    step('ping');

    const created = await host.request({ action: 'create' }, 'created');
    assert.match(created.room, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(created.roster, []);
    assert.equal(created.hostOnline, true);
    step('create');

    const phone = await open();
    const joined = await phone.request({ action: 'join', room: created.room, name: 'Smoke <Bot>' }, 'joined');
    assert.equal(joined.room, created.room);
    assert.equal(joined.slot, 0);
    assert.equal(joined.roster[0].name, 'Smoke Bot');
    const hostRoster = await host.next('roster');
    assert.deepEqual(hostRoster.roster.map((p) => p.id), [joined.id]);
    step('join + roster notify');

    const intruder = await open();
    assert.ok(await intruder.request({ action: 'join', room: created.room, name: 'x', token: created.token }, isError('invalid-token')));
    assert.ok(await intruder.request({ action: 'resume', room: created.room, token: joined.token }, isError('invalid-token')));
    assert.ok(await intruder.request({ action: 'relay', to: 'host', data: {} }, isError('not-in-room')));
    step('foreign tokens and unbound sends refused');

    phone.send({ action: 'relay', to: 'host', data: { kind: 'input', seq: 1, x: 0.5, z: 0, action: false }, from: 'host' });
    const relayed = await host.next('relay');
    assert.deepEqual(relayed, { type: 'relay', from: joined.id, data: { kind: 'input', seq: 1, x: 0.5, z: 0, action: false } });
    assert.ok(await phone.request({ action: 'relay', to: 'all', data: {} }, isError('forbidden')));
    host.send({ action: 'relay', to: 'all', data: { kind: 'status', phase: 'lobby' } });
    assert.deepEqual(await phone.next('relay'), { type: 'relay', from: 'host', data: { kind: 'status', phase: 'lobby' } });
    step('relay both ways, broadcast host-only');

    host.send({ action: 'signal', to: joined.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    assert.deepEqual(await phone.next('signal'), { type: 'signal', from: 'host', data: { description: { type: 'offer', sdp: 'v=0' } } });
    phone.send({ action: 'signal', to: 'host', data: { candidate: null } });
    assert.deepEqual(await host.next('signal'), { type: 'signal', from: joined.id, data: { candidate: null } });
    step('signal');

    assert.ok(await phone.request({ action: 'kick', id: joined.id }, isError('forbidden')));
    const big = JSON.stringify({ action: 'relay', to: 'host', data: { pad: 'x'.repeat(17_000) } });
    assert.ok(await phone.request(big, isError('too-large')));
    step('player cannot kick, oversize rejected');

    const host2 = await open();
    const resumed = await host2.request({ action: 'resume', room: created.room, token: created.token }, 'created');
    assert.equal(resumed.roster.length, 1);
    assert.ok(await host.next(isError('replaced')));
    step('host resume supersedes old connection');

    host2.send({ action: 'close' });
    assert.equal((await phone.next('room-closed')).type, 'room-closed');
    assert.ok(await phone.request({ action: 'relay', to: 'host', data: {} }, isError('not-in-room')));
    step('close');
  } finally {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: node server/smoke.mjs <ws(s)://endpoint> [origin]');
    process.exit(2);
  }
  try {
    await runSmoke(url, { origin: process.argv[3] ?? DEFAULT_ORIGIN, log: console.log });
    console.log('smoke passed');
  } catch (err) {
    console.error(`smoke failed: ${err.message}`);
    process.exit(1);
  }
}
