/**
 * Auto / stick (H-pattern or sequential) gearbox.
 * Clutch is optional-lite: shifting without clutch still works with a soft RPM mismatch.
 */

export type TransmissionMode = 'auto' | 'stick_h' | 'stick_seq';

export type GearLabel = 'P' | 'R' | 'N' | 'D' | '1' | '2' | '3' | '4' | '5' | '6';

export interface TransmissionConfig {
  mode: TransmissionMode;
  /** Forward gears (5 for most Golfs, 6 for VR6 / buses use 5). */
  forwardGears: number;
}

/** Ratio relative to 4th ≈ 1.0; higher = more torque / lower top in gear. */
const RATIOS_5 = [0, 3.78, 2.12, 1.36, 0.97, 0.76];
const RATIOS_6 = [0, 3.78, 2.12, 1.36, 0.97, 0.76, 0.62];
const REVERSE_RATIO = 3.6;
const FINAL_DRIVE = 3.65;

export class Transmission {
  mode: TransmissionMode;
  readonly forwardGears: number;
  /** Auto: P/R/N/D. Stick: R/N/1..n */
  gearIndex = 0; // 0=N for stick; for auto we use selector separately
  /** Auto selector: -1=P, 0=R, 1=N, 2=D */
  autoSelector = 2; // default D
  /** Current engaged forward gear 1..n while in D (auto) or stick. */
  currentGear = 1;
  clutchIn = false;
  private shiftCooldown = 0;
  private autoHold = 0;

  constructor(cfg: TransmissionConfig) {
    this.mode = cfg.mode;
    this.forwardGears = Math.max(4, Math.min(6, cfg.forwardGears));
    if (this.mode === 'auto') {
      this.autoSelector = 2;
      this.currentGear = 1;
    } else {
      this.gearIndex = 0; // N
      this.currentGear = 0;
    }
  }

  get ratios(): number[] {
    return this.forwardGears >= 6 ? RATIOS_6 : RATIOS_5;
  }

  /** Engaged ratio (>0) or 0 if neutral/park. Negative for reverse semantics via flag. */
  getDriveRatio(): { ratio: number; reverse: boolean; engaged: boolean } {
    if (this.mode === 'auto') {
      if (this.autoSelector === -1) return { ratio: 0, reverse: false, engaged: false }; // P
      if (this.autoSelector === 0) return { ratio: REVERSE_RATIO * FINAL_DRIVE, reverse: true, engaged: true };
      if (this.autoSelector === 1) return { ratio: 0, reverse: false, engaged: false }; // N
      const g = Math.max(1, Math.min(this.forwardGears, this.currentGear));
      return { ratio: this.ratios[g] * FINAL_DRIVE, reverse: false, engaged: true };
    }
    // stick
    if (this.gearIndex === 0) return { ratio: 0, reverse: false, engaged: false }; // N
    if (this.gearIndex < 0) return { ratio: REVERSE_RATIO * FINAL_DRIVE, reverse: true, engaged: true };
    const g = Math.max(1, Math.min(this.forwardGears, this.gearIndex));
    return { ratio: this.ratios[g] * FINAL_DRIVE, reverse: false, engaged: true };
  }

  getLabel(): GearLabel {
    if (this.mode === 'auto') {
      if (this.autoSelector === -1) return 'P';
      if (this.autoSelector === 0) return 'R';
      if (this.autoSelector === 1) return 'N';
      return String(this.currentGear) as GearLabel; // show gear in D
    }
    if (this.gearIndex === 0) return 'N';
    if (this.gearIndex < 0) return 'R';
    return String(this.gearIndex) as GearLabel;
  }

  /** Auto PRND letter for HUD. */
  getAutoSelectorLabel(): string {
    if (this.mode !== 'auto') return this.getLabel();
    if (this.autoSelector === -1) return 'P';
    if (this.autoSelector === 0) return 'R';
    if (this.autoSelector === 1) return 'N';
    return `D${this.currentGear}`;
  }

  /** Wheel speed (m/s) → engine RPM norm 0–1 given current gear. */
  rpmFromSpeed(speedMs: number, idle = 0.12, redline = 1): number {
    const { ratio, engaged } = this.getDriveRatio();
    if (!engaged || ratio < 0.01) {
      return idle; // idle when N/P (throttle may raise separately)
    }
    // Arcade: ~55 m/s in 5th ≈ redline-ish depending on ratio
    const wheelOmega = Math.abs(speedMs) / 0.32; // rad/s-ish with r=0.32
    const engOmega = wheelOmega * ratio;
    // Map ~0–900 rad/s to idle–redline
    const norm = engOmega / 520;
    return Math.max(idle, Math.min(redline, norm));
  }

  /** Torque multiplier from gear (low gear = more accel). */
  torqueMul(): number {
    const { ratio, engaged } = this.getDriveRatio();
    if (!engaged) return 0;
    // Normalize vs ~4th gear (ratio ~3.5)
    return Math.min(2.4, Math.max(0.45, (ratio / 3.5) * 0.95));
  }

  update(
    dt: number,
    speedMs: number,
    throttle: number,
    opts: {
      upshift?: boolean;
      downshift?: boolean;
      setGear?: number | null; // 0=N, -1=R, 1..n
      clutch?: boolean;
      autoCycle?: boolean; // cycle P-R-N-D
    },
  ): void {
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.clutchIn = !!opts.clutch;
    this.autoHold = Math.max(0, this.autoHold - dt);

    if (this.mode === 'auto') {
      if (opts.autoCycle && this.shiftCooldown <= 0) {
        // P → R → N → D → P
        const order = [-1, 0, 1, 2];
        const i = order.indexOf(this.autoSelector);
        this.autoSelector = order[(i + 1) % order.length];
        this.shiftCooldown = 0.25;
        if (this.autoSelector === 2) this.currentGear = 1;
      }
      if (this.autoSelector === 2) {
        this.autoShift(speedMs, throttle, dt);
      }
      return;
    }

    // Stick H-pattern direct set
    if (opts.setGear !== undefined && opts.setGear !== null && this.shiftCooldown <= 0) {
      const g = opts.setGear;
      if (g === 0 || g === -1 || (g >= 1 && g <= this.forwardGears)) {
        this.applyStickGear(g);
      }
    }

    // Sequential
    if (this.mode === 'stick_seq' && this.shiftCooldown <= 0) {
      if (opts.upshift) {
        if (this.gearIndex < 0) this.applyStickGear(0);
        else if (this.gearIndex === 0) this.applyStickGear(1);
        else if (this.gearIndex < this.forwardGears) this.applyStickGear(this.gearIndex + 1);
      }
      if (opts.downshift) {
        if (this.gearIndex > 1) this.applyStickGear(this.gearIndex - 1);
        else if (this.gearIndex === 1) this.applyStickGear(0);
        else if (this.gearIndex === 0) this.applyStickGear(-1);
      }
    }

    // H-pattern also allows Q/E sequential as convenience
    if (this.mode === 'stick_h' && this.shiftCooldown <= 0) {
      if (opts.upshift) {
        if (this.gearIndex < 0) this.applyStickGear(0);
        else if (this.gearIndex === 0) this.applyStickGear(1);
        else if (this.gearIndex < this.forwardGears) this.applyStickGear(this.gearIndex + 1);
      }
      if (opts.downshift) {
        if (this.gearIndex > 1) this.applyStickGear(this.gearIndex - 1);
        else if (this.gearIndex === 1) this.applyStickGear(0);
        else if (this.gearIndex === 0) this.applyStickGear(-1);
      }
    }
  }

  private applyStickGear(g: number): void {
    // Optional-lite clutch: without clutch, small delay / allow anyway
    const delay = this.clutchIn ? 0.08 : 0.18;
    this.gearIndex = g;
    this.currentGear = g > 0 ? g : 0;
    this.shiftCooldown = delay;
  }

  private autoShift(speedMs: number, throttle: number, _dt: number): void {
    if (this.autoHold > 0) return;
    const rpm = this.rpmFromSpeed(speedMs, 0.15, 1);
    // Upshift
    if (rpm > (throttle > 0.55 ? 0.82 : 0.72) && this.currentGear < this.forwardGears) {
      this.currentGear++;
      this.autoHold = 0.35;
      return;
    }
    // Downshift
    if (rpm < (throttle > 0.7 ? 0.28 : 0.38) && this.currentGear > 1 && speedMs > 1.5) {
      this.currentGear--;
      this.autoHold = 0.28;
    }
  }
}

export function defaultForwardGears(vehicleId: string): number {
  if (vehicleId.includes('vr6') || vehicleId.includes('hybrid')) return 6;
  if (vehicleId.startsWith('bus')) return 5;
  return 5;
}
