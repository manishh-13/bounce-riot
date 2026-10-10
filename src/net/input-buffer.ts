import type { Input } from '../game/types';
interface InputFrame { input: Input; at: number; seq: number; }
interface Seat { latest: InputFrame; edges: Input[]; consumed: Input; }
export const INPUT_TIMEOUT_MS = 600;
const neutral = (): Input => ({ x: 0, z: 0, action: false, cancel: true });
/** Preserve down/up edges even when both messages arrive before one render frame. */
export class InputBuffer {
  private seats = new Map<string, Seat>();
  accept(id: string, data: Record<string, unknown>, now: number): boolean {
    const previous = this.seats.get(id);
    if (!Number.isSafeInteger(data.seq) || Number(data.seq) < 0 || (previous && Number(data.seq) <= previous.latest.seq)) return false;
    if (typeof data.x !== 'number' || !Number.isFinite(data.x) || typeof data.z !== 'number' || !Number.isFinite(data.z) || typeof data.action !== 'boolean') return false;
    let x = Math.max(-1, Math.min(1, data.x)), z = Math.max(-1, Math.min(1, data.z));
    const length = Math.hypot(x, z); if (length > 1) { x /= length; z /= length; }
    const input: Input = { x, z, action: data.action, cancel: data.cancel === true };
    const frame = { input, at: now, seq: Number(data.seq) };
    const seat: Seat = previous ?? { latest: frame, edges: [], consumed: neutral() };
    const lastInput = previous?.latest.input ?? neutral();
    if (input.cancel) { seat.edges = [input]; }
    else if (lastInput.action !== input.action) {
      if (seat.edges.length >= 8) seat.edges = [neutral()];
      seat.edges.push(input);
    }
    seat.latest = frame;
    this.seats.set(id, seat);
    return true;
  }
  read(id: string, now: number, connected = true): Input {
    const seat = this.seats.get(id);
    if (!seat || !connected || now - seat.latest.at > INPUT_TIMEOUT_MS) {
      if (seat) { seat.edges = []; seat.consumed = neutral(); }
      return neutral();
    }
    if (seat.edges.length) {
      seat.consumed = seat.edges.shift()!;
      return seat.consumed;
    }
    seat.consumed = seat.latest.input;
    return seat.consumed;
  }
  clear() { this.seats.clear(); }
  remove(id: string) { this.seats.delete(id); }
}
