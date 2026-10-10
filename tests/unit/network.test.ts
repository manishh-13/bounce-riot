import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomConnection } from '../../src/net/room';
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  static OPEN = 1; static CONNECTING = 0;
  readyState = 0; bufferedAmount = 0; sent: Record<string, unknown>[] = [];
  constructor(public url: string) { super(); FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(value: unknown) { const e = new Event('message'); Object.assign(e, { data: JSON.stringify(value) }); this.dispatchEvent(e); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
class FakeChannel {
  readyState = 'connecting'; bufferedAmount = 0; onopen?: () => void; onclose?: () => void; onerror?: () => void; onmessage?: (e: { data: string }) => void;
  sent: string[] = [];
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
}
class FakePeer {
  static instances: FakePeer[] = [];
  connectionState = 'new'; remoteDescription: unknown = null; localDescription: unknown = null;
  onicecandidate?: (e: unknown) => void; ondatachannel?: (e: { channel: FakeChannel }) => void; onconnectionstatechange?: () => void;
  candidates: unknown[] = [];
  constructor() { FakePeer.instances.push(this); }
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
  async setLocalDescription(d: unknown) { this.localDescription = d; }
  async createAnswer() { return { type: 'answer', sdp: 'test-answer' }; }
  async createOffer() { return { type: 'offer', sdp: 'test-offer' }; }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  createDataChannel() { return new FakeChannel(); }
  close() { this.connectionState = 'closed'; }
}
let rooms: RoomConnection[] = [];
beforeEach(() => {
  vi.useFakeTimers(); FakeSocket.instances = []; FakePeer.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket); vi.stubGlobal('window', { RTCPeerConnection: FakePeer }); vi.stubGlobal('RTCPeerConnection', FakePeer);
});
afterEach(() => { rooms.forEach(r => r.disconnect()); rooms = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
function player(callbacks = {}) {
  const room = new RoomConnection({ signalUrl: 'wss://test.invalid' }, 'player', callbacks); rooms.push(room);
  room.connect({ room: 'ABC234', name: 'Nova' }); const socket = FakeSocket.instances.at(-1)!; socket.open();
  socket.message({ type: 'joined', room: 'ABC234', token: 'test-token', id: 'p1', slot: 0, roster: [{ id: 'p1', name: 'Nova', slot: 0, connected: true }], hostOnline: true });
  return { room, socket };
}
describe('room connection transport and lifecycle', () => {
  it('joins by room code then sends inputs over the relay without WebRTC', () => {
    vi.stubGlobal('window', {});
    const { room, socket } = player();
    expect(socket.sent[0]).toEqual({ action: 'join', room: 'ABC234', name: 'Nova' });
    room.send('host', { kind: 'input', seq: 1, x: 0, z: 0, action: false });
    expect(socket.sent.at(-1)).toMatchObject({ action: 'relay', to: 'host', data: { kind: 'input' } });
  });
  it('keeps ICE candidates that arrive before the offer', async () => {
    const { socket } = player();
    const candidate = { candidate: 'test-candidate', sdpMid: '0', sdpMLineIndex: 0 };
    socket.message({ type: 'signal', from: 'host', data: { candidate } });
    socket.message({ type: 'signal', from: 'host', data: { description: { type: 'offer', sdp: 'test-offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakePeer.instances).toHaveLength(1);
    expect(FakePeer.instances[0].candidates).toEqual([candidate]);
    expect(socket.sent.some(m => m.action === 'signal')).toBe(true);
  });
  it('uses the open peer channel and falls back when it closes', async () => {
    const { room, socket } = player();
    socket.message({ type: 'signal', from: 'host', data: { description: { type: 'offer', sdp: 'test-offer' } } });
    await vi.advanceTimersByTimeAsync(0);
    const channel = new FakeChannel(); FakePeer.instances[0].ondatachannel?.({ channel });
    channel.readyState = 'open'; channel.onopen?.();
    room.send('host', { kind: 'input', seq: 5 });
    expect(channel.sent.some(s => JSON.parse(s).seq === 5)).toBe(true);
    expect(room.getTransport('host')).toBe('direct');
    channel.close(); room.send('host', { kind: 'input', seq: 6 });
    expect(socket.sent.at(-1)).toMatchObject({ action: 'relay', data: { seq: 6 } });
  });
  it('reconnects using the saved token rather than taking a new seat', async () => {
    const { socket } = player(); socket.close();
    await vi.advanceTimersByTimeAsync(501);
    const reopened = FakeSocket.instances.at(-1)!; reopened.open();
    expect(reopened.sent[0]).toEqual({ action: 'join', room: 'ABC234', name: 'Nova', token: 'test-token' });
  });
  it('does not retry invalid credentials endlessly', async () => {
    const room = new RoomConnection({ signalUrl: 'wss://test.invalid' }, 'player', {}); rooms.push(room); room.connect({ room: 'ABC234', token: 'bad' });
    const socket = FakeSocket.instances.at(-1)!; socket.open();
    socket.message({ type: 'error', code: 'INVALID_TOKEN', message: 'Invalid reconnect token' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('ignores non-host signaling on a phone', async () => {
    const { socket } = player();
    socket.message({ type: 'signal', from: 'other-player', data: { description: { type: 'offer', sdp: 'test' } } });
    await vi.advanceTimersByTimeAsync(0); expect(FakePeer.instances).toHaveLength(0);
  });
});

describe('roster ordering and terminal errors', () => {
  it('ignores an older roster after a newer join update', () => {
    const { room, socket } = player();
    socket.message({ type: 'roster', version: 4, hostOnline: true, roster: [{ id: 'p1', name: 'Nova', slot: 0, connected: true }, { id: 'p2', name: 'Mochi', slot: 1, connected: true }] });
    socket.message({ type: 'roster', version: 3, hostOnline: true, roster: [{ id: 'p1', name: 'Nova', slot: 0, connected: true }] });
    expect(room.roster).toHaveLength(2);
  });
  it('stops reconnecting when the host removes a player', async () => {
    const closed = vi.fn(); const { socket } = player({ onClosed: closed });
    socket.message({ type: 'error', code: 'kicked', message: 'Removed by host' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(closed).toHaveBeenCalledOnce(); expect(FakeSocket.instances).toHaveLength(1);
  });
});
