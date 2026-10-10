import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{6}$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PLAYER_ID_RE = /^p[0-9a-f]{12}$/;

export const LIMITS = Object.freeze({
  maxMessageBytes: 16 * 1024,
  maxPlayers: 8,
  roomTtlMs: 2 * 60 * 60 * 1000,
  nameMaxChars: 16,
  // A full room may hand the seat of a phone that has been offline this long to a newcomer.
  reclaimOfflineMs: 2 * 60 * 1000,
  mutateRetries: 12,
  rate: {
    // Token buckets per connection (rate per second, burst). Host sends status to every phone.
    message: { rate: 150, burst: 300 },
    player: { rate: 40, burst: 80 },
    control: { rate: 1 / 6, burst: 10 },
    errorReply: { rate: 1, burst: 3 },
  },
  ip: {
    connect: { limit: 60, windowMs: 60_000 },
    create: { limit: 20, windowMs: 10 * 60_000 },
    join: { limit: 120, windowMs: 10 * 60_000 },
  },
});

export class HubError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(hash, token) {
  if (typeof hash !== 'string' || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  return code;
}

export function parseRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

export function newPlayerId() {
  return `p${randomBytes(6).toString('hex')}`;
}

export function sanitizeName(raw, maxChars = LIMITS.nameMaxChars) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .slice(0, 256)
    .normalize('NFKC')
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxChars).join('').trim();
}

export function ipKey(ip) {
  return createHash('sha256').update(`bounce-riot:${ip || 'unknown'}`).digest('base64url').slice(0, 22);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isLocalDevHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// `local-dev` admits http(s) pages served from localhost or a private LAN address (vite dev on a phone).
export function parseOriginPolicy(spec, { allowMissing = false } = {}) {
  const entries = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    origins: entries.filter((e) => e !== 'local-dev').map((e) => e.replace(/\/+$/, '')),
    allowLocalDev: entries.includes('local-dev'),
    allowMissing,
  };
}

export function originAllowed(origin, policy) {
  if (!origin) return policy.allowMissing;
  if (policy.origins.includes(origin)) return true;
  if (!policy.allowLocalDev) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && `${url.protocol}//${url.host}` === origin && isLocalDevHost(url.hostname);
  } catch {
    return false;
  }
}

export function createRateLimiter(now = Date.now, maxKeys = 20_000) {
  const buckets = new Map();
  return {
    take(key, { rate, burst }) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        b = { tokens: burst, at: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * rate);
      b.at = t;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
    forget(prefix) {
      for (const key of buckets.keys()) if (key.startsWith(prefix)) buckets.delete(key);
    },
    get size() {
      return buckets.size;
    },
  };
}

const SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);

function optionalStringOrNull(value, max) {
  return value === undefined || value === null || (typeof value === 'string' && value.length <= max);
}

export function cleanSignalData(data) {
  if (!isPlainObject(data)) return null;
  const keys = Object.keys(data);
  if (!keys.length || keys.some((k) => k !== 'description' && k !== 'candidate')) return null;
  const out = {};
  if ('description' in data) {
    const d = data.description;
    if (!isPlainObject(d) || !SDP_TYPES.has(d.type)) return null;
    if (d.sdp !== undefined && (typeof d.sdp !== 'string' || d.sdp.length > 15_000)) return null;
    out.description = d.sdp === undefined ? { type: d.type } : { type: d.type, sdp: d.sdp };
  }
  if ('candidate' in data) {
    const c = data.candidate;
    if (c === null) {
      out.candidate = null;
    } else {
      if (!isPlainObject(c) || typeof c.candidate !== 'string' || c.candidate.length > 1024) return null;
      if (!optionalStringOrNull(c.sdpMid, 64) || !optionalStringOrNull(c.usernameFragment, 256)) return null;
      if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64)) return null;
      out.candidate = { candidate: c.candidate };
      for (const k of ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) if (c[k] !== undefined) out.candidate[k] = c[k];
    }
  }
  return out;
}

export function rosterOf(room) {
  return [...room.players]
    .sort((a, b) => a.slot - b.slot)
    .map(({ id, name, slot, connected }) => ({ id, name, slot, connected }));
}

function silentLog() {}

const SKIP = Symbol('skip');

export function createHub({ store, transport, now = Date.now, limits = LIMITS, originPolicy = parseOriginPolicy(''), log = silentLog }) {
  const limiter = createRateLimiter(now);

  async function send(connId, msg) {
    if (!connId) return false;
    try {
      return (await transport.send(connId, JSON.stringify(msg))) !== false;
    } catch (err) {
      log('send-failed', { error: err?.name ?? 'Error' });
      return false;
    }
  }

  async function sendError(connId, code, message) {
    if (code === 'rate-limited' && !limiter.take(`${connId}:err`, limits.rate.errorReply)) return;
    await send(connId, { type: 'error', code, message });
  }

  async function closeConn(connId) {
    try {
      await transport.close?.(connId);
    } catch (err) {
      log('close-failed', { error: err?.name ?? 'Error' });
    }
  }

  function connsOf(room, exceptConn) {
    const ids = room.players.filter((p) => p.connected && p.conn).map((p) => p.conn);
    if (room.hostOnline && room.hostConn) ids.push(room.hostConn);
    return ids.filter((id) => id !== exceptConn);
  }

  async function broadcast(ids, msg) {
    await Promise.all(ids.map((id) => send(id, msg)));
  }

  function rosterMessage(room) {
    return { type: 'roster', roster: rosterOf(room), hostOnline: room.hostOnline, version: room.ver };
  }

  async function loadRoom(code) {
    const room = await store.getRoom(code);
    if (!room) throw new HubError('room-not-found', 'No room with that code');
    if (room.expiresAt <= now()) {
      await store.deleteRoom(code, room.ver).catch(() => {});
      throw new HubError('room-expired', 'This room has expired, create a new one');
    }
    return room;
  }

  // Optimistic concurrency: every write is conditional on the version that was read.
  async function mutate(code, fn) {
    for (let attempt = 0; attempt < limits.mutateRetries; attempt++) {
      const room = await loadRoom(code);
      const result = fn(room) ?? {};
      if (result === SKIP) return { room, skipped: true };
      const ok = result.remove ? await store.deleteRoom(code, room.ver) : await store.updateRoom(room, room.ver);
      if (ok) return { ...result, room };
      // Jittered backoff so a burst of phones joining at once (separate Lambda invocations) spreads out.
      await new Promise((r) => setTimeout(r, Math.random() * 8 * (attempt + 1)));
    }
    throw new HubError('busy', 'Room is busy, please retry');
  }

  async function checkIp(kind, ip) {
    const { limit, windowMs } = limits.ip[kind];
    if (!(await store.hit(`${kind}:${ipKey(ip)}`, limit, windowMs))) {
      throw new HubError('rate-limited', 'Too many attempts, slow down');
    }
  }

  async function bindConn(connId, binding) {
    const ok = await store.putConn({ id: connId, ...binding, expiresAt: now() + limits.roomTtlMs });
    if (!ok) throw new HubError('already-in-room', 'This connection already belongs to a room');
  }

  async function revokeConn(oldConn, binding) {
    await store.deleteConn(oldConn, binding);
    await sendError(oldConn, 'replaced', 'This seat was resumed from another connection');
    await closeConn(oldConn);
  }

  async function requireUnbound(connId) {
    if (await store.getConn(connId)) throw new HubError('already-in-room', 'This connection already belongs to a room');
  }

  async function forwardingSession(connId) {
    const s = await session(connId);
    if (!s.host && !limiter.take(`${connId}:player`, limits.rate.player)) throw new HubError('rate-limited', 'Too many messages, slow down');
    return s;
  }

  // Authority comes from the room item, so a connection superseded by a resume is rejected even if its binding survived.
  async function session(connId) {
    const conn = await store.getConn(connId);
    if (!conn) throw new HubError('not-in-room', 'Create or join a room first');
    let room;
    try {
      room = await loadRoom(conn.room);
    } catch (err) {
      await store.deleteConn(connId, conn);
      throw err.code === 'room-not-found' ? new HubError('room-closed', 'The room is closed') : err;
    }
    if (conn.role === 'host' && room.hostConn === connId) return { conn, room, self: 'host', host: true };
    const player = conn.role === 'player' ? room.players.find((p) => p.id === conn.pid) : undefined;
    if (player && player.conn === connId) return { conn, room, self: player.id, host: false, player };
    await store.deleteConn(connId, conn);
    throw new HubError('not-in-room', 'This connection is no longer part of the room');
  }

  const actions = {
    async ping(ctx, msg) {
      if (typeof msg.at !== 'number' || !Number.isFinite(msg.at)) throw new HubError('bad-request', 'ping needs a numeric at');
      await send(ctx.connectionId, { type: 'pong', at: msg.at });
    },

    async create(ctx) {
      const id = ctx.connectionId;
      await requireUnbound(id);
      await checkIp('create', ctx.ip);
      const token = newToken();
      const t = now();
      let room;
      for (let attempt = 0; attempt < 6 && !room; attempt++) {
        const candidate = {
          code: newRoomCode(),
          hostTokenHash: hashToken(token),
          hostConn: id,
          hostOnline: true,
          players: [],
          createdAt: t,
          expiresAt: t + limits.roomTtlMs,
        };
        if (await store.createRoom(candidate)) room = candidate;
      }
      if (!room) throw new HubError('busy', 'Could not allocate a room code, please retry');
      try {
        await bindConn(id, { room: room.code, role: 'host', pid: null });
      } catch (err) {
        await store.deleteRoom(room.code, room.ver);
        throw err;
      }
      log('room-created', {});
      await send(id, { type: 'created', room: room.code, token, roster: [], hostOnline: true, version: room.ver });
    },

    async resume(ctx, msg) {
      const id = ctx.connectionId;
      const code = parseRoomCode(msg.room);
      if (!code) throw new HubError('bad-request', 'resume needs a room code');
      if (typeof msg.token !== 'string' || !TOKEN_RE.test(msg.token)) throw new HubError('invalid-token', 'Host token is not valid for this room');
      await requireUnbound(id);
      await checkIp('join', ctx.ip);
      const room0 = await loadRoom(code);
      if (!tokenMatches(room0.hostTokenHash, msg.token)) throw new HubError('invalid-token', 'Host token is not valid for this room');
      await bindConn(id, { room: code, role: 'host', pid: null });
      let result;
      try {
        result = await mutate(code, (room) => {
          if (!tokenMatches(room.hostTokenHash, msg.token)) throw new HubError('invalid-token', 'Host token is not valid for this room');
          const old = room.hostConn;
          room.hostConn = id;
          room.hostOnline = true;
          return { old };
        });
      } catch (err) {
        await store.deleteConn(id, { room: code, role: 'host' });
        throw err;
      }
      const { room, old } = result;
      if (old && old !== id) await revokeConn(old, { room: code, role: 'host' });
      await send(id, { type: 'created', room: code, token: msg.token, roster: rosterOf(room), hostOnline: true, version: room.ver });
      await broadcast(connsOf(room, id), rosterMessage(room));
    },

    async join(ctx, msg) {
      const id = ctx.connectionId;
      const code = parseRoomCode(msg.room);
      if (!code) throw new HubError('bad-request', 'join needs a room code');
      const resuming = msg.token !== undefined && msg.token !== null;
      if (resuming && (typeof msg.token !== 'string' || !TOKEN_RE.test(msg.token))) throw new HubError('invalid-token', 'Seat token is not valid for this room');
      const name = sanitizeName(msg.name, limits.nameMaxChars);
      await requireUnbound(id);
      await checkIp('join', ctx.ip);
      const room0 = await loadRoom(code);
      let pid;
      if (resuming) {
        pid = room0.players.find((p) => tokenMatches(p.tokenHash, msg.token))?.id;
        if (!pid) throw new HubError('invalid-token', 'Seat token is not valid for this room');
      } else {
        pid = newPlayerId();
      }
      const token = resuming ? msg.token : newToken();
      await bindConn(id, { room: code, role: 'player', pid });
      let result;
      try {
        result = await mutate(code, (room) => {
          const t = now();
          if (resuming) {
            const player = room.players.find((p) => p.id === pid && tokenMatches(p.tokenHash, token));
            if (!player) throw new HubError('invalid-token', 'Seat token is not valid for this room');
            const old = player.conn;
            Object.assign(player, { conn: id, connected: true, lastSeen: t });
            return { player, old };
          }
          let evicted = null;
          if (room.players.length >= limits.maxPlayers) {
            evicted = room.players
              .filter((p) => !p.connected && t - p.lastSeen >= limits.reclaimOfflineMs)
              .sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!evicted) throw new HubError('room-full', `This room already has ${limits.maxPlayers} players`);
            room.players = room.players.filter((p) => p !== evicted);
          }
          const used = new Set(room.players.map((p) => p.slot));
          let slot = 0;
          while (used.has(slot)) slot++;
          const player = { id: pid, name: name || `Player ${slot + 1}`, slot, tokenHash: hashToken(token), conn: id, connected: true, lastSeen: t };
          room.players.push(player);
          return { player, old: evicted?.conn ?? null };
        });
      } catch (err) {
        await store.deleteConn(id, { room: code, role: 'player' });
        throw err;
      }
      const { room, player, old } = result;
      if (old && old !== id) await revokeConn(old, { room: code, role: 'player' });
      await send(id, { type: 'joined', room: code, token, id: player.id, slot: player.slot, roster: rosterOf(room), hostOnline: room.hostOnline, version: room.ver });
      await broadcast(connsOf(room, id), rosterMessage(room));
    },

    async signal(ctx, msg) {
      const data = cleanSignalData(msg.data);
      if (!data) throw new HubError('bad-request', 'signal data must hold a description and/or candidate');
      const s = await forwardingSession(ctx.connectionId);
      const target = targetOf(s, msg.to);
      if (!(await send(target, { type: 'signal', from: s.self, data }))) throw new HubError('peer-offline', 'That peer is offline');
    },

    async relay(ctx, msg) {
      if (!isPlainObject(msg.data)) throw new HubError('bad-request', 'relay data must be an object');
      const s = await forwardingSession(ctx.connectionId);
      const out = { type: 'relay', from: s.self, data: msg.data };
      if (msg.to === 'all') {
        if (!s.host) throw new HubError('forbidden', 'Only the host can broadcast');
        await broadcast(connsOf(s.room, ctx.connectionId), out);
        return;
      }
      const target = targetOf(s, msg.to);
      if (!(await send(target, out))) throw new HubError('peer-offline', 'That peer is offline');
    },

    async roster(ctx) {
      const s = await session(ctx.connectionId);
      await send(ctx.connectionId, rosterMessage(s.room));
    },

    async leave(ctx) {
      const id = ctx.connectionId;
      const s = await session(id);
      await store.deleteConn(id, s.conn);
      await detach(s.conn, id, true);
    },

    async close(ctx) {
      const id = ctx.connectionId;
      const s = await session(id);
      if (!s.host) throw new HubError('forbidden', 'Only the host can close the room');
      const { room } = await mutate(s.room.code, (room) => {
        if (room.hostConn !== id) throw new HubError('not-in-room', 'This connection is no longer the host');
        return { remove: true };
      });
      await Promise.all(room.players.filter((p) => p.conn).map((p) => store.deleteConn(p.conn, { room: room.code, role: 'player' })));
      await store.deleteConn(id);
      await broadcast(connsOf(room), { type: 'room-closed' });
    },

    async kick(ctx, msg) {
      const id = ctx.connectionId;
      if (typeof msg.id !== 'string' || !PLAYER_ID_RE.test(msg.id)) throw new HubError('bad-request', 'kick needs a player id');
      const s = await session(id);
      if (!s.host) throw new HubError('forbidden', 'Only the host can kick players');
      const { room, kicked } = await mutate(s.room.code, (room) => {
        if (room.hostConn !== id) throw new HubError('not-in-room', 'This connection is no longer the host');
        const kicked = room.players.find((p) => p.id === msg.id);
        if (!kicked) throw new HubError('unknown-peer', 'No such player in this room');
        room.players = room.players.filter((p) => p !== kicked);
        return { kicked };
      });
      if (kicked.conn) {
        await store.deleteConn(kicked.conn, { room: room.code, role: 'player' });
        await sendError(kicked.conn, 'kicked', 'The host removed you from the room');
        await closeConn(kicked.conn);
      }
      await broadcast(connsOf(room), rosterMessage(room));
    },
  };

  function targetOf(s, to) {
    if (s.host) {
      if (to === 'host' || to === 'all') throw new HubError('bad-request', 'Pick a player id');
      const p = typeof to === 'string' ? s.room.players.find((x) => x.id === to) : undefined;
      if (!p) throw new HubError('unknown-peer', 'No such player in this room');
      if (!p.connected) throw new HubError('peer-offline', 'That player is offline');
      return p.conn;
    }
    if (to !== 'host') throw new HubError('forbidden', 'Players can only message the host');
    if (!s.room.hostOnline) throw new HubError('peer-offline', 'The host is offline');
    return s.room.hostConn;
  }

  // Shared by leave and disconnect: explicit player leave frees the seat, a dropped player keeps it.
  async function detach(conn, connId, explicit) {
    let result;
    try {
      result = await mutate(conn.room, (room) => {
        if (conn.role === 'host') {
          if (room.hostConn !== connId) return SKIP;
          room.hostConn = null;
          room.hostOnline = false;
          return {};
        }
        const player = room.players.find((p) => p.id === conn.pid);
        if (!player || player.conn !== connId) return SKIP;
        if (explicit) room.players = room.players.filter((p) => p !== player);
        else Object.assign(player, { conn: null, connected: false, lastSeen: now() });
        return {};
      });
    } catch (err) {
      if (err instanceof HubError) return;
      throw err;
    }
    if (result.skipped) return;
    const { room } = result;
    const others = connsOf(room, connId);
    if (conn.role === 'host') await broadcast(others, { type: 'host-offline' });
    await broadcast(others, rosterMessage(room));
  }

  return {
    async connect({ connectionId, ip, origin }) {
      if (!originAllowed(origin, originPolicy)) {
        log('connect-rejected', { reason: 'origin' });
        return { ok: false, status: 403 };
      }
      try {
        await checkIp('connect', ip);
      } catch {
        log('connect-rejected', { reason: 'rate' });
        return { ok: false, status: 429 };
      }
      return { ok: true, connectionId };
    },

    async message(ctx, raw) {
      const id = ctx.connectionId;
      try {
        const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
        if (Buffer.byteLength(text) > limits.maxMessageBytes) throw new HubError('too-large', `Messages are limited to ${limits.maxMessageBytes} bytes`);
        if (!limiter.take(`${id}:msg`, limits.rate.message)) throw new HubError('rate-limited', 'Too many messages, slow down');
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          throw new HubError('bad-request', 'Messages must be JSON');
        }
        if (!isPlainObject(msg) || typeof msg.action !== 'string') throw new HubError('bad-request', 'Messages need an action');
        const action = Object.hasOwn(actions, msg.action) ? actions[msg.action] : null;
        if (!action) throw new HubError('unknown-action', 'Unknown action');
        if (['create', 'resume', 'join'].includes(msg.action) && !limiter.take(`${id}:ctl`, limits.rate.control)) {
          throw new HubError('rate-limited', 'Too many room requests, slow down');
        }
        await action(ctx, msg);
      } catch (err) {
        if (err instanceof HubError) {
          await sendError(id, err.code, err.message);
          return;
        }
        log('internal-error', { error: err?.name ?? 'Error' });
        await sendError(id, 'internal', 'Something went wrong, please retry');
      }
    },

    async disconnect({ connectionId }) {
      limiter.forget(`${connectionId}:`);
      try {
        const conn = await store.getConn(connectionId);
        if (!conn) return;
        await store.deleteConn(connectionId, conn);
        await detach(conn, connectionId, false);
      } catch (err) {
        log('disconnect-error', { error: err?.name ?? 'Error' });
      }
    },
  };
}
