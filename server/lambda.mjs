import { createHub, parseOriginPolicy } from './hub.mjs';
import { createDynamoStore } from './dynamo-store.mjs';

const log = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

function header(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

export function createApiGatewayTransport({ Client, PostToConnectionCommand, DeleteConnectionCommand }) {
  const clients = new Map();
  let endpoint;
  const client = () => {
    if (!clients.has(endpoint)) clients.set(endpoint, new Client({ endpoint }));
    return clients.get(endpoint);
  };
  const gone = (err) => err?.name === 'GoneException' || err?.$metadata?.httpStatusCode === 410;
  return {
    setEndpoint(value) {
      endpoint = value;
    },
    async send(connectionId, data) {
      try {
        await client().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }));
        return true;
      } catch (err) {
        if (gone(err)) return false;
        throw err;
      }
    },
    async close(connectionId) {
      try {
        await client().send(new DeleteConnectionCommand({ ConnectionId: connectionId }));
      } catch (err) {
        if (!gone(err)) throw err;
      }
    },
  };
}

export function createLambdaHandler({ store, transport, originPolicy, now = Date.now, logger = log }) {
  const hub = createHub({ store, transport, originPolicy, now, log: logger });
  return async (event) => {
    const rc = event.requestContext ?? {};
    const connectionId = rc.connectionId;
    const ip = rc.identity?.sourceIp;
    // Derived per event because the API id would create a template dependency cycle if passed via env.
    transport.setEndpoint?.(`https://${rc.domainName}/${rc.stage}`);
    if (rc.routeKey === '$connect') {
      const verdict = await hub.connect({ connectionId, ip, origin: header(event.headers, 'origin') });
      return { statusCode: verdict.ok ? 200 : verdict.status };
    }
    if (rc.routeKey === '$disconnect') {
      await hub.disconnect({ connectionId });
      return { statusCode: 200 };
    }
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    await hub.message({ connectionId, ip }, body);
    return { statusCode: 200 };
  };
}

async function defaultHandler() {
  const [{ DynamoDBClient }, lib, mgmt] = await Promise.all([
    import('@aws-sdk/client-dynamodb'),
    import('@aws-sdk/lib-dynamodb'),
    import('@aws-sdk/client-apigatewaymanagementapi'),
  ]);
  const client = lib.DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const doc = {
    get: (input) => client.send(new lib.GetCommand(input)),
    put: (input) => client.send(new lib.PutCommand(input)),
    update: (input) => client.send(new lib.UpdateCommand(input)),
    delete: (input) => client.send(new lib.DeleteCommand(input)),
  };
  return createLambdaHandler({
    store: createDynamoStore({ doc, table: process.env.TABLE_NAME }),
    transport: createApiGatewayTransport({
      Client: mgmt.ApiGatewayManagementApiClient,
      PostToConnectionCommand: mgmt.PostToConnectionCommand,
      DeleteConnectionCommand: mgmt.DeleteConnectionCommand,
    }),
    originPolicy: parseOriginPolicy(process.env.ALLOWED_ORIGINS, { allowMissing: process.env.ALLOW_MISSING_ORIGIN === 'true' }),
  });
}

let ready;
export const handler = async (event) => {
  ready ??= defaultHandler().catch((err) => {
    ready = undefined;
    throw err;
  });
  return (await ready)(event);
};
