export interface Member { id: string; name: string; slot: number; connected: boolean; }
export type Transport = 'direct' | 'relay' | 'connecting' | 'offline';
export interface RoomInfo { room: string; token: string; id: string; slot: number; }
export interface RoomCallbacks {
  onRoom?: (info: RoomInfo) => void;
  onRoster?: (roster: Member[], hostOnline: boolean) => void;
  onPayload?: (from: string, payload: Record<string, unknown>) => void;
  onTransport?: (peerId: string, transport: Transport) => void;
  onError?: (message: string, code: string) => void;
  onConnection?: (connected: boolean) => void;
  onClosed?: () => void;
}
interface Peer { pc: RTCPeerConnection; channel?: RTCDataChannel; candidates: RTCIceCandidateInit[]; negotiating: boolean; }
export interface ServiceConfig { signalUrl: string; iceServers?: RTCIceServer[]; }
export async function loadServiceConfig(): Promise<ServiceConfig> {
  const override = import.meta.env.VITE_SIGNAL_URL;
  if (override) return { signalUrl: override };
  if (['localhost', '127.0.0.1'].includes(location.hostname)) return { signalUrl: `ws://${location.hostname}:4382` };
  try {
    const response = await fetch(new URL('config.json', location.href.split('?')[0].split('#')[0]), { cache: 'no-store' });
    if (!response.ok) throw new Error('Configuration unavailable');
    const config = await response.json() as ServiceConfig;
    if (!config.signalUrl || !/^wss:\/\//.test(config.signalUrl)) throw new Error('Room service not configured');
    return config;
  } catch { throw new Error('The room service is unavailable. Practice still works. Please try hosting again in a moment.'); }
}

/** The TV owns the simulation. The service pairs peers; a data channel carries input when possible. */
export class RoomConnection {
  room = '';
  id = '';
  slot = 0;
  roster: Member[] = [];
  token = '';
  role: 'host' | 'player';
  hostOnline = false;
  private socket?: WebSocket;
  private peers = new Map<string, Peer>();
  private stopped = false;
  private joined = false;
  private rosterVersion = -1;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private retry = 0;
  private name = '';
  private transport = new Map<string, Transport>();
  private openTimeout?: ReturnType<typeof setTimeout>;
  constructor(private config: ServiceConfig, role: 'host' | 'player', private callbacks: RoomCallbacks) { this.role = role; }
  connect(options: { room?: string; token?: string; name?: string } = {}) {
    this.room = options.room ?? this.room;
    this.token = options.token ?? this.token;
    this.name = options.name ?? this.name;
    this.stopped = false;
    this.openSocket();
  }
  private openSocket() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimeout);
    try { this.socket = new WebSocket(this.config.signalUrl); }
    catch { this.callbacks.onError?.('Could not connect to the room service.', 'CONNECTION'); this.scheduleReconnect(); return; }
    const socket = this.socket;
    this.openTimeout = setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, 12000);
    socket.addEventListener('open', () => {
      clearTimeout(this.openTimeout);
      if (this.stopped || socket !== this.socket) return;
      this.retry = 0;
      if (this.role === 'host') {
        this.sendService(this.token && this.room ? { action: 'resume', room: this.room, token: this.token } : { action: 'create' });
      } else {
        this.sendService({ action: 'join', room: this.room, name: this.name, ...(this.token ? { token: this.token } : {}) });
      }
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.sendService({ action: 'ping', at: Date.now() }), 25000);
    });
    socket.addEventListener('message', (event) => {
      if (socket !== this.socket || this.stopped || typeof event.data !== 'string' || event.data.length > 32768) return;
      try { this.receiveService(JSON.parse(event.data) as Record<string, unknown>); } catch { /* Reject malformed server frames. */ }
    });
    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      clearTimeout(this.openTimeout);
      clearInterval(this.pingTimer);
      this.joined = false;
      this.callbacks.onConnection?.(false);
      for (const [id, peer] of this.peers) {
        if (peer.channel?.readyState !== 'open') this.setTransport(id, 'offline');
      }
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (this.retry === 0) this.callbacks.onError?.('Connection interrupted. Reconnecting to your room...', 'CONNECTION');
    });
  }
  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(8000, 500 * 2 ** Math.min(4, this.retry++));
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }
  private receiveService(message: Record<string, unknown>) {
    if (message.type === 'created' || message.type === 'joined') {
      this.joined = true;
      this.room = String(message.room);
      this.token = String(message.token ?? this.token);
      this.id = this.role === 'host' ? 'host' : String(message.id);
      this.slot = Number(message.slot ?? 0);
      this.callbacks.onConnection?.(true);
      this.callbacks.onRoom?.({ room: this.room, token: this.token, id: this.id, slot: this.slot });
      this.updateRoster(message);
      if (this.role === 'player') {
        this.setTransport('host', 'relay');
        this.send('host', { kind: 'hello' });
        const peer = this.peers.get('host');
        if (peer && peer.channel?.readyState !== 'open') this.sendService({ action: 'relay', to: 'host', data: { kind: 'direct-retry' } });
      }
    } else if (message.type === 'roster') this.updateRoster(message);
    else if (message.type === 'signal') void this.receiveSignal(String(message.from), message.data as Record<string, unknown>);
    else if (message.type === 'relay') {
      if (message.data && typeof message.data === 'object') {
        const from = String(message.from), payload = message.data as Record<string, unknown>;
        if (this.role === 'host' && (payload.kind === 'hello' || payload.kind === 'direct-retry') && this.roster.some(m => m.id === from && m.connected)) {
          const existing = this.peers.get(from);
          if (payload.kind === 'direct-retry' || !existing || existing.pc.connectionState === 'disconnected' || existing.pc.connectionState === 'failed' || existing.pc.connectionState === 'closed') void this.offer(from);
        }
        this.callbacks.onPayload?.(from, payload);
      }
    } else if (message.type === 'host-offline') {
      this.hostOnline = false;
      this.callbacks.onRoster?.(this.roster, false);
      this.setTransport('host', this.peers.get('host')?.channel?.readyState === 'open' ? 'direct' : 'offline');
    } else if (message.type === 'room-closed' || message.type === 'kicked') {
      this.stopped = true;
      this.callbacks.onClosed?.();
      this.disconnect();
    } else if (message.type === 'error') {
      const code = String(message.code ?? 'error').toLowerCase();
      const text = String(message.message ?? 'Something went wrong. Please try again.');
      const joinedBeforeError = this.joined;
      this.callbacks.onError?.(text, code);
      if (['kicked', 'replaced', 'room-closed'].includes(code) || (code === 'room-expired' && joinedBeforeError)) {
        this.stopped = true;
        this.callbacks.onClosed?.();
        this.disconnect();
        return;
      }
      // Authentication and lookup errors need a new user action, never an endless join loop.
      if (!this.joined && !['rate-limit', 'rate-limited', 'rate_limit', 'rate_limited', 'busy', 'internal'].includes(code)) {
        this.stopped = true;
        this.socket?.close();
      }
    }
  }
  private updateRoster(message: Record<string, unknown>) {
    const version = typeof message.version === 'number' ? message.version : null;
    if (version !== null && version < this.rosterVersion) return;
    if (version !== null) this.rosterVersion = version;
    if (Array.isArray(message.roster)) {
      this.roster = message.roster.filter((m): m is Member => !!m && typeof m === 'object' && typeof m.id === 'string');
    }
    this.hostOnline = message.hostOnline !== false;
    this.callbacks.onRoster?.(this.roster, this.hostOnline);
    if (this.role === 'host') {
      const active = new Set(this.roster.filter(m => m.connected).map(m => m.id));
      for (const [id] of this.peers) if (!active.has(id)) this.dropPeer(id);
      for (const member of this.roster) if (member.connected && !this.peers.has(member.id)) void this.offer(member.id);
    }
  }
  private setTransport(id: string, value: Transport) {
    if (this.transport.get(id) === value) return;
    this.transport.set(id, value);
    this.callbacks.onTransport?.(id, value);
  }
  getTransport(id: string): Transport { return this.transport.get(id) ?? 'connecting'; }
  private makePeer(id: string): Peer | null {
    if (typeof window.RTCPeerConnection !== 'function') { this.setTransport(id, 'relay'); return null; }
    this.dropPeer(id);
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: this.config.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }] });
    } catch { this.setTransport(id, 'relay'); return null; }
    const peer: Peer = { pc, candidates: [], negotiating: false };
    this.peers.set(id, peer);
    pc.onicecandidate = event => { if (event.candidate) this.sendService({ action: 'signal', to: id, data: { candidate: event.candidate.toJSON() } }); };
    pc.ondatachannel = event => this.attachChannel(id, peer, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') this.setTransport(id, this.joined ? 'relay' : 'offline');
    };
    this.setTransport(id, 'relay');
    return peer;
  }
  private attachChannel(id: string, peer: Peer, channel: RTCDataChannel) {
    peer.channel = channel;
    channel.onopen = () => { this.setTransport(id, 'direct'); this.send(id, { kind: 'hello' }); };
    channel.onclose = () => this.setTransport(id, this.joined ? 'relay' : 'offline');
    channel.onerror = () => this.setTransport(id, this.joined ? 'relay' : 'offline');
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 16384) return;
      try {
        const data = JSON.parse(event.data);
        if (data && typeof data === 'object' && !Array.isArray(data)) this.callbacks.onPayload?.(id, data);
      } catch { /* Ignore invalid peer messages. */ }
    };
  }
  private async offer(id: string) {
    const peer = this.makePeer(id);
    if (!peer) return;
    this.attachChannel(id, peer, peer.pc.createDataChannel('bounce-riot', { ordered: true }));
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      this.sendService({ action: 'signal', to: id, data: { description: peer.pc.localDescription } });
    } catch { this.setTransport(id, 'relay'); }
  }
  private async receiveSignal(id: string, data: Record<string, unknown>) {
    if (!data || (this.role === 'player' && id !== 'host')) return;
    if (this.role === 'host' && !this.roster.some(m => m.id === id && m.connected)) return;
    try {
      let peer = this.peers.get(id);
      if (data.description) {
        const description = data.description as RTCSessionDescriptionInit;
        if (description.type === 'offer') {
          if (this.role === 'host') return;
          if (!peer || peer.pc.remoteDescription) peer = this.makePeer(id) ?? undefined;
        }
        if (!peer) return;
        await peer.pc.setRemoteDescription(description);
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        if (description.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.sendService({ action: 'signal', to: id, data: { description: peer.pc.localDescription } });
        }
      } else if (data.candidate) {
        if (!peer) peer = this.makePeer(id) ?? undefined;
        if (!peer) return;
        const candidate = data.candidate as RTCIceCandidateInit;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
        else if (peer.candidates.length < 40) peer.candidates.push(candidate);
      }
    } catch { this.setTransport(id, this.joined ? 'relay' : 'offline'); }
  }
  send(to: string, data: Record<string, unknown>) {
    const channel = this.peers.get(to)?.channel;
    if (channel?.readyState === 'open' && channel.bufferedAmount < 8192) {
      try { channel.send(JSON.stringify(data)); return; } catch { this.setTransport(to, 'relay'); }
    }
    if (this.joined) this.sendService({ action: 'relay', to, data });
  }
  kick(id: string) { if (this.role === 'host') this.sendService({ action: 'kick', id }); }
  private sendService(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 65536) this.socket.send(JSON.stringify(message));
  }
  private dropPeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onconnectionstatechange = null;
    if (peer.channel) { peer.channel.onclose = null; peer.channel.close(); }
    peer.pc.close();
    this.peers.delete(id);
  }
  disconnect(permanent = false) {
    this.stopped = true;
    if (permanent) this.sendService({ action: this.role === 'host' ? 'close' : 'leave' });
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.openTimeout);
    clearInterval(this.pingTimer);
    for (const [id] of this.peers) this.dropPeer(id);
    this.socket?.close();
    this.joined = false;
  }
}
