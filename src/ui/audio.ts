import type { GameEvent } from '../game/types';
/** Original synthesized effects, no external audio assets or autoplay. */
export class GameAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private seen = 0;
  enabled = true;
  async unlock() {
    if (!this.context) {
      const Audio = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Audio) return;
      this.context = new Audio();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0.2;
      this.gain.connect(this.context.destination);
    }
    try { await this.context.resume(); } catch { /* Sound is optional. */ }
  }
  setEnabled(enabled: boolean) { this.enabled = enabled; }
  play(event: GameEvent) {
    if (!this.enabled || !this.context || this.context.state !== 'running' || !this.gain) return;
    const type = event.type;
    if (!['slam', 'hit', 'ride', 'ko', 'hop', 'start', 'finish'].includes(type)) return;
    const c = this.context, start = c.currentTime;
    const oscillator = c.createOscillator(), envelope = c.createGain();
    oscillator.connect(envelope); envelope.connect(this.gain);
    const config: Record<string, [number, number, number, OscillatorType]> = {
      slam: [110 + event.power * 40, 38, 0.28, 'sine'], hit: [230, 70, 0.12, 'triangle'],
      ride: [370, 740, 0.28, 'sine'], ko: [190, 45, 0.45, 'triangle'],
      hop: [180, 350, 0.10, 'sine'], start: [440, 660, 0.30, 'triangle'], finish: [523, 1046, 0.6, 'sine'],
    };
    const [from, to, duration, wave] = config[type];
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(to, start + duration);
    envelope.gain.setValueAtTime(0.001, start);
    envelope.gain.exponentialRampToValueAtTime(type === 'hop' ? 0.15 : 0.5, start + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + duration);
    oscillator.start(start); oscillator.stop(start + duration + 0.02);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }
  consume(events: GameEvent[]) { for (const event of events) if (event.id > this.seen) { this.seen = event.id; this.play(event); } }
  dispose() { void this.context?.close(); }
}
