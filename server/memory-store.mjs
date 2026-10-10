// In-process store with the same conditional-write semantics as the DynamoDB store.
// `tick` lets tests interleave concurrent operations the way network round trips would.
export function createMemoryStore({ now = Date.now, tick = () => new Promise((r) => setImmediate(r)) } = {}) {
  const rooms = new Map();
  const conns = new Map();
  const counters = new Map();
  const copy = (v) => (v == null ? null : structuredClone(v));

  function matches(conn, match) {
    if (!match) return true;
    return (match.room === undefined || conn.room === match.room) && (match.role === undefined || conn.role === match.role);
  }

  return {
    async getRoom(code) {
      await tick();
      return copy(rooms.get(code));
    },
    async createRoom(room) {
      await tick();
      const existing = rooms.get(room.code);
      if (existing && existing.expiresAt > now()) return false;
      room.ver = 1;
      rooms.set(room.code, copy(room));
      return true;
    },
    async updateRoom(room, expectedVer) {
      await tick();
      const existing = rooms.get(room.code);
      if (!existing || existing.ver !== expectedVer) return false;
      room.ver = expectedVer + 1;
      rooms.set(room.code, copy(room));
      return true;
    },
    async deleteRoom(code, expectedVer) {
      await tick();
      const existing = rooms.get(code);
      if (!existing || existing.ver !== expectedVer) return false;
      rooms.delete(code);
      return true;
    },
    async getConn(id) {
      await tick();
      return copy(conns.get(id));
    },
    async putConn(conn) {
      await tick();
      if (conns.has(conn.id)) return false;
      conns.set(conn.id, copy(conn));
      return true;
    },
    async deleteConn(id, match) {
      await tick();
      const existing = conns.get(id);
      if (existing && matches(existing, match)) conns.delete(id);
    },
    async hit(key, limit, windowMs) {
      await tick();
      const t = now();
      const windowKey = `${key}#${Math.floor(t / windowMs)}`;
      const entry = counters.get(windowKey) ?? { n: 0, expiresAt: (Math.floor(t / windowMs) + 1) * windowMs };
      if (entry.n >= limit) return false;
      entry.n += 1;
      counters.set(windowKey, entry);
      return true;
    },
    sweep() {
      const t = now();
      for (const [k, v] of rooms) if (v.expiresAt <= t) rooms.delete(k);
      for (const [k, v] of conns) if (v.expiresAt <= t) conns.delete(k);
      for (const [k, v] of counters) if (v.expiresAt <= t) counters.delete(k);
    },
    stats() {
      return { rooms: rooms.size, conns: conns.size, counters: counters.size };
    },
  };
}
