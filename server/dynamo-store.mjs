// Single-table layout keyed by `pk`: R#<code> rooms, C#<connectionId> bindings, L#<key>#<window> rate counters.
// Rooms are written only on membership changes; forwarding a message is two consistent reads, no writes.
// `doc` is a thin adapter over DynamoDBDocumentClient: { get, put, update, delete } taking command input.
const NAMES = { '#pk': 'pk', '#ver': 'ver', '#exp': 'exp' };

function isConditionFailure(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

async function conditional(promise) {
  try {
    await promise;
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

const ttlSeconds = (ms) => Math.ceil(ms / 1000);

function roomItem(room, ver) {
  const { ver: _ignored, ...data } = room;
  return { pk: `R#${room.code}`, ver, exp: room.expiresAt, ttl: ttlSeconds(room.expiresAt), data };
}

export function createDynamoStore({ doc, table, now = Date.now }) {
  return {
    async getRoom(code) {
      const { Item } = await doc.get({ TableName: table, Key: { pk: `R#${code}` }, ConsistentRead: true });
      return Item ? { ...Item.data, ver: Item.ver } : null;
    },

    async createRoom(room) {
      const ok = await conditional(
        doc.put({
          TableName: table,
          Item: roomItem(room, 1),
          ConditionExpression: 'attribute_not_exists(#pk) OR #exp <= :now',
          ExpressionAttributeNames: { '#pk': NAMES['#pk'], '#exp': NAMES['#exp'] },
          ExpressionAttributeValues: { ':now': now() },
        }),
      );
      if (ok) room.ver = 1;
      return ok;
    },

    async updateRoom(room, expectedVer) {
      const ok = await conditional(
        doc.put({
          TableName: table,
          Item: roomItem(room, expectedVer + 1),
          ConditionExpression: '#ver = :ver',
          ExpressionAttributeNames: { '#ver': NAMES['#ver'] },
          ExpressionAttributeValues: { ':ver': expectedVer },
        }),
      );
      if (ok) room.ver = expectedVer + 1;
      return ok;
    },

    async deleteRoom(code, expectedVer) {
      return conditional(
        doc.delete({
          TableName: table,
          Key: { pk: `R#${code}` },
          ConditionExpression: '#ver = :ver',
          ExpressionAttributeNames: { '#ver': NAMES['#ver'] },
          ExpressionAttributeValues: { ':ver': expectedVer },
        }),
      );
    },

    async getConn(id) {
      const { Item } = await doc.get({ TableName: table, Key: { pk: `C#${id}` }, ConsistentRead: true });
      return Item ? { id, room: Item.room, role: Item.role, pid: Item.pid ?? null, expiresAt: Item.exp } : null;
    },

    async putConn(conn) {
      return conditional(
        doc.put({
          TableName: table,
          Item: { pk: `C#${conn.id}`, room: conn.room, role: conn.role, pid: conn.pid ?? null, exp: conn.expiresAt, ttl: ttlSeconds(conn.expiresAt) },
          ConditionExpression: 'attribute_not_exists(#pk)',
          ExpressionAttributeNames: { '#pk': NAMES['#pk'] },
        }),
      );
    },

    async deleteConn(id, match) {
      const params = { TableName: table, Key: { pk: `C#${id}` } };
      if (match?.room !== undefined && match?.role !== undefined) {
        Object.assign(params, {
          ConditionExpression: '#room = :room AND #role = :role',
          ExpressionAttributeNames: { '#room': 'room', '#role': 'role' },
          ExpressionAttributeValues: { ':room': match.room, ':role': match.role },
        });
      }
      await conditional(doc.delete(params));
    },

    async hit(key, limit, windowMs) {
      const window = Math.floor(now() / windowMs);
      return conditional(
        doc.update({
          TableName: table,
          Key: { pk: `L#${key}#${window}` },
          UpdateExpression: 'ADD #n :one SET #ttl = :ttl',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
          ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': ttlSeconds((window + 1) * windowMs) + 60 },
        }),
      );
    },
  };
}
