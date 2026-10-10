import { describe, it, expect, vi } from 'vitest';
import { createLambdaHandler, createApiGatewayTransport } from './lambda.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { parseOriginPolicy } from './hub.mjs';

function setup() {
  const sent = [];
  const transport = {
    endpoint: null,
    setEndpoint(e) { this.endpoint = e; },
    async send(id, data) { sent.push([id, JSON.parse(data)]); return true; },
    async close() {},
  };
  const logs = [];
  const handler = createLambdaHandler({
    store: createMemoryStore(),
    transport,
    originPolicy: parseOriginPolicy('https://manishh-13.github.io,http://localhost:4381'),
    logger: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
  });
  const event = (routeKey, connectionId, extra = {}) => ({
    requestContext: { routeKey, connectionId, domainName: 'abc.execute-api.ap-south-1.amazonaws.com', stage: 'prod', identity: { sourceIp: '198.51.100.9' } },
    ...extra,
  });
  return { handler, transport, sent, logs, event };
}

describe('Lambda handler', () => {
  it('checks the Origin header on $connect, any casing', async () => {
    const { handler, event } = setup();
    expect(await handler(event('$connect', 'a', { headers: { Origin: 'https://manishh-13.github.io' } }))).toEqual({ statusCode: 200 });
    expect(await handler(event('$connect', 'b', { headers: { origin: 'http://localhost:4381' } }))).toEqual({ statusCode: 200 });
    expect(await handler(event('$connect', 'c', { headers: { Origin: 'https://evil.example' } }))).toEqual({ statusCode: 403 });
    expect(await handler(event('$connect', 'd', { headers: {} }))).toEqual({ statusCode: 403 });
  });

  it('routes $default messages, decodes binary frames and handles $disconnect', async () => {
    const { handler, event, sent, transport } = setup();
    await handler(event('$default', 'h', { body: JSON.stringify({ action: 'create' }) }));
    expect(transport.endpoint).toBe('https://abc.execute-api.ap-south-1.amazonaws.com/prod');
    const created = sent.at(-1)[1];
    expect(created.type).toBe('created');
    const body = Buffer.from(JSON.stringify({ action: 'join', room: created.room, name: 'Bin' })).toString('base64');
    expect(await handler(event('$default', 'p', { body, isBase64Encoded: true }))).toEqual({ statusCode: 200 });
    expect(sent.find(([id, m]) => id === 'p' && m.type === 'joined')).toBeTruthy();
    await handler(event('$disconnect', 'p'));
    expect(sent.at(-1)).toEqual(['h', expect.objectContaining({ type: 'roster', roster: [expect.objectContaining({ connected: false })] })]);
    await handler(event('$default', 'x', {}));
    expect(sent.at(-1)).toEqual(['x', expect.objectContaining({ type: 'error', code: 'bad-request' })]);
  });

  it('does not log tokens, codes, IPs or payloads', async () => {
    const { handler, event, sent, logs } = setup();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handler(event('$connect', 'h', { headers: { Origin: 'https://evil.example' } }));
    await handler(event('$default', 'h', { body: JSON.stringify({ action: 'create' }) }));
    const created = sent.at(-1)[1];
    await handler(event('$default', 'h', { body: JSON.stringify({ action: 'relay', to: 'all', data: { marker: 'payload-marker' } }) }));
    spy.mockRestore();
    const text = logs.join('\n') + JSON.stringify(spy.mock.calls);
    expect(logs.length).toBeGreaterThan(0);
    for (const s of [created.token, created.room, '198.51.100.9', 'payload-marker']) expect(text).not.toContain(s);
  });
});

describe('API Gateway transport', () => {
  it('posts to the event endpoint and maps GoneException to offline', async () => {
    const seen = [];
    class Client { constructor(cfg) { this.cfg = cfg; } async send(cmd) { seen.push([this.cfg.endpoint, cmd]); if (cmd.input.ConnectionId === 'gone') throw Object.assign(new Error('gone'), { name: 'GoneException' }); } }
    class Post { constructor(input) { this.input = input; this.kind = 'post'; } }
    class Del { constructor(input) { this.input = input; this.kind = 'delete'; } }
    const t = createApiGatewayTransport({ Client, PostToConnectionCommand: Post, DeleteConnectionCommand: Del });
    t.setEndpoint('https://x/prod');
    expect(await t.send('ok', '{}')).toBe(true);
    expect(await t.send('gone', '{}')).toBe(false);
    await t.close('gone');
    expect(seen.map(([e, c]) => [e, c.kind, c.input.ConnectionId])).toEqual([
      ['https://x/prod', 'post', 'ok'],
      ['https://x/prod', 'post', 'gone'],
      ['https://x/prod', 'delete', 'gone'],
    ]);
  });
});
