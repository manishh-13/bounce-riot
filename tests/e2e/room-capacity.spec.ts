import { test, expect } from '@playwright/test';
import WebSocket from 'ws';
function openClient() {
  return new Promise<{ socket: WebSocket; frames: Record<string, any>[]; send: (message: unknown) => void }>((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:4382'); const frames: Record<string, any>[] = [];
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    socket.once('error', reject); socket.once('open', () => resolve({ socket, frames, send: message => socket.send(JSON.stringify(message)) }));
  });
}
test('eight simultaneous seats, ninth rejected, explicit leave frees slot without takeover', async () => {
  test.skip(!!process.env.BOUNCE_BASE_URL, 'Local service integration test.');
  const host = await openClient(); host.send({ action: 'create' });
  await expect.poll(() => host.frames.find(f => f.type === 'created')?.room).toMatch(/^[A-Z0-9]{6}$/);
  const code = host.frames.find(f => f.type === 'created')!.room;
  const clients = await Promise.all(Array.from({ length: 9 }, () => openClient()));
  clients.slice(0, 8).forEach((client, i) => client.send({ action: 'join', room: code, name: `Player ${i}` }));
  await expect.poll(() => clients.slice(0, 8).filter(c => c.frames.some(f => f.type === 'joined')).length).toBe(8);
  const slots = clients.slice(0, 8).map(c => c.frames.find(f => f.type === 'joined')!.slot);
  expect(new Set(slots).size).toBe(8);
  clients[8].send({ action: 'join', room: code, name: 'Ninth' });
  await expect.poll(() => clients[8].frames.find(f => f.code === 'room-full')?.type).toBe('error');
  clients[0].send({ action: 'leave' });
  await expect.poll(() => host.frames.filter(f => f.type === 'roster').at(-1)?.roster.length).toBe(7);
  clients[8].send({ action: 'join', room: code, name: 'Replacement' });
  await expect.poll(() => clients[8].frames.find(f => f.type === 'joined')?.slot).toBe(slots[0]);
  host.send({ action: 'close' });
  await expect.poll(() => clients[8].frames.some(f => f.type === 'room-closed')).toBe(true);
  for (const c of clients) c.socket.close(); host.socket.close();
});
