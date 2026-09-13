import type { Vehicle } from './Vehicle';

/**
 * Lightweight Web Audio engine note — pitch scales with RPM × spec.soundPitch.
 * Starts on first user gesture (browser autoplay policy).
 */
export class EngineSound {
  private ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private started = false;
  private enabled = true;

  start(): void {
    if (this.started || !this.enabled) return;
    // Must be called from a user-gesture stack (Start menu click).
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.ctx.destination);

      this.osc = this.ctx.createOscillator();
      this.osc.type = 'sawtooth';
      this.osc.frequency.value = 60;
      this.osc.connect(this.gain);

      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'triangle';
      this.osc2.frequency.value = 90;
      const g2 = this.ctx.createGain();
      g2.gain.value = 0.35;
      this.osc2.connect(g2);
      g2.connect(this.gain);

      this.osc.start();
      this.osc2.start();
      this.started = true;
      void this.ctx.resume().catch(() => {
        /* autoplay policy — stay silent until next resume */
      });
    } catch {
      this.enabled = false;
    }
  }

  update(vehicle: Vehicle): void {
    if (!this.started || !this.ctx || !this.osc || !this.osc2 || !this.gain) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const rpm = vehicle.getEngineRpmNorm();
    const pitch = vehicle.spec.soundPitch;
    const base = vehicle.spec.class === 'bus' ? 48 : 70;
    let freq = (base + rpm * 180) * pitch;
    if (!Number.isFinite(freq) || freq < 20) freq = 60;
    if (freq > 1200) freq = 1200;
    const now = this.ctx.currentTime;
    this.osc.frequency.setTargetAtTime(freq, now, 0.05);
    this.osc2.frequency.setTargetAtTime(freq * 1.5, now, 0.05);

    const vol =
      0.02 +
      rpm * 0.045 * (0.55 + vehicle.throttleLoad * 0.45) *
        (vehicle.spec.class === 'bus' ? 0.85 : 1);
    this.gain.gain.setTargetAtTime(Math.min(0.09, vol), now, 0.08);
  }

  dispose(): void {
    try {
      this.osc?.stop();
      this.osc2?.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.osc = null;
    this.osc2 = null;
    this.gain = null;
    this.ctx = null;
    this.started = false;
  }
}
