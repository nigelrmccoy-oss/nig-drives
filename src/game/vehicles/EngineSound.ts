import type { Vehicle } from './Vehicle';

/**
 * Procedural Web Audio engine — RPM-linked harmonics + load.
 * Distinct character per Golf engine and bus diesel/hybrid.
 * Optional sample files (not required) can be dropped later under public/audio-samples/.
 */
export class EngineSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers: Array<{
    osc: OscillatorNode;
    gain: GainNode;
    type: OscillatorType;
    ratio: number;
    level: number;
  }> = [];
  private noise: AudioBufferSourceNode | null = null;
  private noiseGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private started = false;
  private enabled = true;
  private character: EngineCharacter = 'aba';

  start(vehicleId?: string): void {
    if (this.started || !this.enabled) return;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 900;
      this.filter.Q.value = 0.7;
      this.filter.connect(this.master);
      this.master.connect(this.ctx.destination);

      this.character = characterFor(vehicleId ?? 'golf_20aba');
      const recipe = recipes[this.character];

      for (const L of recipe.layers) {
        const osc = this.ctx.createOscillator();
        osc.type = L.type;
        osc.frequency.value = 60;
        const gain = this.ctx.createGain();
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(this.filter);
        osc.start();
        this.layers.push({ osc, gain, type: L.type, ratio: L.ratio, level: L.level });
      }

      // Soft noise bed (diesel clatter / intake)
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
      this.noise = this.ctx.createBufferSource();
      this.noise.buffer = buf;
      this.noise.loop = true;
      this.noiseGain = this.ctx.createGain();
      this.noiseGain.gain.value = 0;
      const nFilter = this.ctx.createBiquadFilter();
      nFilter.type = 'bandpass';
      nFilter.frequency.value = recipe.noiseFreq;
      nFilter.Q.value = 0.6;
      this.noise.connect(nFilter);
      nFilter.connect(this.noiseGain);
      this.noiseGain.connect(this.filter);
      this.noise.start();

      this.started = true;
      void this.ctx.resume().catch(() => {});
    } catch {
      this.enabled = false;
    }
  }

  setVehicle(vehicleId: string): void {
    this.character = characterFor(vehicleId);
    // Rebuild only if already started — dispose + restart layers would click; adjust levels live
    const recipe = recipes[this.character];
    if (this.filter) {
      this.filter.frequency.value = recipe.filterHz;
    }
  }

  update(vehicle: Vehicle): void {
    if (!this.started || !this.ctx || !this.master || !this.filter) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const recipe = recipes[characterFor(vehicle.spec.id)];
    const rpm = vehicle.getEngineRpmNorm();
    const load = THREE_clamp(vehicle.throttleLoad, 0, 1);
    const pitch = vehicle.spec.soundPitch;
    const base = recipe.baseHz * pitch;
    const freq = THREE_clamp(base + rpm * recipe.rpmSpan * pitch, 28, 1400);
    const now = this.ctx.currentTime;

    for (const L of this.layers) {
      L.osc.frequency.setTargetAtTime(freq * L.ratio, now, 0.04);
      const lvl =
        L.level *
        (0.35 + load * 0.65) *
        (0.55 + rpm * 0.55) *
        (vehicle.spec.class === 'bus' ? 0.9 : 1);
      L.gain.gain.setTargetAtTime(lvl, now, 0.06);
    }

    this.filter.frequency.setTargetAtTime(
      recipe.filterHz + rpm * recipe.filterSpan + load * 200,
      now,
      0.08,
    );

    if (this.noiseGain) {
      const nVol = recipe.noiseLevel * (0.2 + rpm * 0.5 + load * 0.4);
      this.noiseGain.gain.setTargetAtTime(nVol, now, 0.1);
    }

    const vol =
      (0.018 + rpm * 0.04 + load * 0.028) * recipe.master * (vehicle.spec.class === 'bus' ? 0.95 : 1);
    this.master.gain.setTargetAtTime(Math.min(0.11, vol), now, 0.07);
  }

  dispose(): void {
    try {
      for (const L of this.layers) L.osc.stop();
      this.noise?.stop();
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.layers = [];
    this.noise = null;
    this.noiseGain = null;
    this.filter = null;
    this.master = null;
    this.ctx = null;
    this.started = false;
  }
}

type EngineCharacter = 'carb' | 'aba' | 'tdi' | 'vr6' | 'bus_diesel' | 'bus_hybrid';

interface LayerRecipe {
  type: OscillatorType;
  ratio: number;
  level: number;
}

interface Recipe {
  baseHz: number;
  rpmSpan: number;
  filterHz: number;
  filterSpan: number;
  noiseFreq: number;
  noiseLevel: number;
  master: number;
  layers: LayerRecipe[];
}

const recipes: Record<EngineCharacter, Recipe> = {
  carb: {
    baseHz: 58,
    rpmSpan: 160,
    filterHz: 700,
    filterSpan: 500,
    noiseFreq: 220,
    noiseLevel: 0.012,
    master: 1,
    layers: [
      { type: 'sawtooth', ratio: 1, level: 0.045 },
      { type: 'triangle', ratio: 2.01, level: 0.02 },
      { type: 'square', ratio: 0.5, level: 0.01 },
    ],
  },
  aba: {
    baseHz: 68,
    rpmSpan: 190,
    filterHz: 850,
    filterSpan: 650,
    noiseFreq: 280,
    noiseLevel: 0.01,
    master: 1,
    layers: [
      { type: 'sawtooth', ratio: 1, level: 0.05 },
      { type: 'triangle', ratio: 1.5, level: 0.022 },
      { type: 'sine', ratio: 3, level: 0.012 },
    ],
  },
  tdi: {
    baseHz: 42,
    rpmSpan: 130,
    filterHz: 550,
    filterSpan: 400,
    noiseFreq: 160,
    noiseLevel: 0.028,
    master: 1.05,
    layers: [
      { type: 'square', ratio: 1, level: 0.035 },
      { type: 'sawtooth', ratio: 0.5, level: 0.03 },
      { type: 'triangle', ratio: 2, level: 0.015 },
    ],
  },
  vr6: {
    baseHz: 78,
    rpmSpan: 220,
    filterHz: 1000,
    filterSpan: 900,
    noiseFreq: 340,
    noiseLevel: 0.008,
    master: 1.08,
    layers: [
      { type: 'sawtooth', ratio: 1, level: 0.048 },
      { type: 'sawtooth', ratio: 1.5, level: 0.02 },
      { type: 'triangle', ratio: 2.5, level: 0.018 },
      { type: 'sine', ratio: 4, level: 0.01 },
    ],
  },
  bus_diesel: {
    baseHz: 32,
    rpmSpan: 90,
    filterHz: 420,
    filterSpan: 280,
    noiseFreq: 110,
    noiseLevel: 0.035,
    master: 1.1,
    layers: [
      { type: 'square', ratio: 1, level: 0.04 },
      { type: 'sawtooth', ratio: 0.5, level: 0.035 },
      { type: 'triangle', ratio: 1.25, level: 0.015 },
    ],
  },
  bus_hybrid: {
    baseHz: 48,
    rpmSpan: 140,
    filterHz: 900,
    filterSpan: 700,
    noiseFreq: 400,
    noiseLevel: 0.014,
    master: 0.95,
    layers: [
      { type: 'sine', ratio: 1, level: 0.035 },
      { type: 'triangle', ratio: 2, level: 0.025 },
      { type: 'sawtooth', ratio: 0.5, level: 0.012 },
    ],
  },
};

function characterFor(id: string): EngineCharacter {
  if (id.includes('18carb')) return 'carb';
  if (id.includes('19tdi')) return 'tdi';
  if (id.includes('28vr6')) return 'vr6';
  if (id === 'bus_diesel') return 'bus_diesel';
  if (id === 'bus_hybrid') return 'bus_hybrid';
  return 'aba';
}

function THREE_clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
