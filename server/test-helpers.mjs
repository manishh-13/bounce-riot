import { createHub, parseOriginPolicy, LIMITS } from './hub.mjs';
import { createMemoryStore } from './memory-store.mjs';

export function createHarness({ limits = LIMITS, store: makeStore, start = 1_700_000_000_000 } = {}) {
  let t = start;
  const now = () => t;
  const store = makeStore ? makeStore(now) : createMemoryStore({ now });
  const outbox = new Map();
  const gone = new Set();
  const closed = [];
  const logs = [];
  const raw = [];
  const transport = {
    async send(id, data) {
      if (gone.has(id)) return false;
      raw.push(data);
      if (!outbox.has(id)) outbox.set(id, []);
      outbox.get(id).push(JSON.parse(data));
      return true;
    },
    async close(id) {
      closed.push(id);
    },
  };
  const hub = createHub({
    store,
    transport,
    now,
    limits,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    originPolicy: parseOriginPolicy('https://manishh-13.github.io,local-dev'),
  });
  const said = (id) => outbox.get(id) ?? [];
  const h = {
    hub,
    store,
    now,
    logs,
    raw,
    gone,
    closed,
    said,
    advance: (ms) => (t += ms),
    last: (id) => said(id).at(-1),
    clear: (id) => outbox.set(id, []),
    ofType: (id, type) => said(id).filter((m) => m.type === type),
    errors: (id) => said(id).filter((m) => m.type === 'error').map((m) => m.code),
    send: (id, msg, ip = '203.0.113.7') => hub.message({ connectionId: id, ip }, typeof msg === 'string' ? msg : JSON.stringify(msg)),
    async create(id = 'host', ip) {
      await h.send(id, { action: 'create' }, ip);
      const m = h.last(id);
      if (m.type !== 'created') throw new Error(`create failed: ${m.code}`);
      return m;
    },
    async join(id, room, extra = {}, ip) {
      await h.send(id, { action: 'join', room, name: id, ...extra }, ip);
      return h.last(id);
    },
  };
  return h;
}
