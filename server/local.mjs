import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createHub, parseOriginPolicy, LIMITS } from './hub.mjs';
import { createMemoryStore } from './memory-store.mjs';

export const DEFAULT_LOCAL_ORIGINS = 'https://manishh-13.github.io,local-dev';

const jsonLog = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

export async function startLocalServer({
  port = 4382,
  host = '0.0.0.0',
  origins = DEFAULT_LOCAL_ORIGINS,
  allowMissingOrigin = true,
  limits = LIMITS,
  now = Date.now,
  log = jsonLog,
} = {}) {
  const store = createMemoryStore({ now, tick: () => Promise.resolve() });
  const sockets = new Map();
  const transport = {
    async send(id, data) {
      const ws = sockets.get(id);
      if (!ws || ws.readyState !== ws.OPEN) return false;
      ws.send(data);
      return true;
    },
    async close(id) {
      sockets.get(id)?.close(4000, 'closed');
    },
  };
  const hub = createHub({ store, transport, now, limits, log, originPolicy: parseOriginPolicy(origins, { allowMissing: allowMissingOrigin }) });

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'bounce-riot-room-service' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false }));
  });

  // Frames above the protocol limit still reach the hub (and get a too-large error) up to this hard cap.
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes * 4 });

  server.on('upgrade', async (req, socket, head) => {
    const connectionId = randomUUID();
    const ip = req.socket.remoteAddress;
    const verdict = await hub.connect({ connectionId, ip, origin: req.headers.origin });
    if (!verdict.ok) {
      socket.end(`HTTP/1.1 ${verdict.status} ${verdict.status === 403 ? 'Forbidden' : 'Too Many Requests'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(connectionId, ws);
      let queue = Promise.resolve();
      ws.on('message', (data) => {
        queue = queue.then(() => hub.message({ connectionId, ip }, data.toString('utf8')));
      });
      ws.on('close', () => {
        queue = queue.then(async () => {
          sockets.delete(connectionId);
          await hub.disconnect({ connectionId });
        });
      });
      ws.on('error', () => {});
    });
  });

  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    store,
    async close() {
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => server.close(() => r()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BR_SIGNAL_PORT ?? process.env.PORT ?? 4382);
  const origins = process.env.BR_ALLOWED_ORIGINS ?? DEFAULT_LOCAL_ORIGINS;
  const running = await startLocalServer({ port, host: process.env.BR_SIGNAL_HOST ?? '0.0.0.0', origins });
  console.log(`Bounce Riot room service on ws://localhost:${running.port} (health: http://localhost:${running.port}/health)`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
