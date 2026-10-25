/**
 * What the vehicle reads each frame (v1.4.0 M1). Input implements it; the headless
 * bench passes its own object. steer +1 = full left, throttle / brakeAxis 0–1.
 */
export interface DriverInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  brake: boolean;
  clutch: boolean;
  steer: number;
  throttle: number;
  brakeAxis: number;
  /** True while a gamepad drives (no keyboard ramps applied). */
  analog: boolean;
  consumeGearUp(): boolean;
  consumeGearDown(): boolean;
  consumeAutoSelector(): boolean;
  consumeHGear(): number | null;
}

const PAD_DEADZONE = 0.08;

export class Input implements DriverInput {
  forward = false;
  back = false;
  left = false;
  right = false;
  brake = false;
  /** Left Shift — optional-lite clutch for stick. */
  clutch = false;
  /** v1.4.0 analog channels: keyboard writes 0/±1, a gamepad writes real values. */
  steer = 0;
  throttle = 0;
  brakeAxis = 0;
  analog = false;
  private padPrev: boolean[] = [];

  private pressed = new Set<string>();
  private cameraToggleQueued = false;
  private weatherCycleQueued = false;
  private timeCycleQueued = false;
  private timePauseQueued = false;
  private gearUpQueued = false;
  private gearDownQueued = false;
  private autoSelectorQueued = false;
  private hGearQueued: number | null = null; // 0=N, -1=R, 1..6

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.code;
    if (
      k === 'KeyW' ||
      k === 'KeyA' ||
      k === 'KeyS' ||
      k === 'KeyD' ||
      k === 'ArrowUp' ||
      k === 'ArrowDown' ||
      k === 'ArrowLeft' ||
      k === 'ArrowRight' ||
      k === 'Space'
    ) {
      e.preventDefault();
    }
    this.analog = false; // a key press hands control back to the keyboard
    if (!this.pressed.has(k)) {
      if (k === 'KeyC') this.cameraToggleQueued = true;
      if (k === 'KeyR') this.weatherCycleQueued = true;
      if (k === 'KeyT') this.timeCycleQueued = true;
      if (k === 'KeyP') this.timePauseQueued = true;
      if (k === 'KeyE' || k === 'Equal' || k === 'NumpadAdd') this.gearUpQueued = true;
      if (k === 'KeyQ' || k === 'Minus' || k === 'NumpadSubtract') this.gearDownQueued = true;
      if (k === 'KeyG') this.autoSelectorQueued = true;
      // H-pattern: digits 1–6, KeyN = N, KeyB = reverse (R conflicts with weather)
      if (k === 'Digit1' || k === 'Numpad1') this.hGearQueued = 1;
      if (k === 'Digit2' || k === 'Numpad2') this.hGearQueued = 2;
      if (k === 'Digit3' || k === 'Numpad3') this.hGearQueued = 3;
      if (k === 'Digit4' || k === 'Numpad4') this.hGearQueued = 4;
      if (k === 'Digit5' || k === 'Numpad5') this.hGearQueued = 5;
      if (k === 'Digit6' || k === 'Numpad6') this.hGearQueued = 6;
      if (k === 'KeyN') this.hGearQueued = 0;
      if (k === 'KeyB') this.hGearQueued = -1;
    }
    this.pressed.add(k);
    this.sync();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.code);
    this.sync();
  };

  private onBlur = (): void => {
    this.pressed.clear();
    this.sync();
  };

  private sync(): void {
    this.forward = this.pressed.has('KeyW') || this.pressed.has('ArrowUp');
    this.back = this.pressed.has('KeyS') || this.pressed.has('ArrowDown');
    this.left = this.pressed.has('KeyA') || this.pressed.has('ArrowLeft');
    this.right = this.pressed.has('KeyD') || this.pressed.has('ArrowRight');
    this.brake = this.pressed.has('Space');
    this.clutch = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight');
    if (!this.analog) {
      this.steer = (this.left ? 1 : 0) - (this.right ? 1 : 0);
      this.throttle = this.forward ? 1 : 0;
      this.brakeAxis = this.brake ? 1 : 0;
    }
  }

  /**
   * v1.4.0 M1: read the first connected gamepad (standard mapping). Call once per frame.
   * Left stick steer, RT throttle, LT brake, B reverse/brake, X clutch,
   * RB/LB shift up/down, Y camera, View/Back cycles P-R-N-D.
   */
  poll(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      if (this.analog) {
        this.analog = false;
        this.sync();
      }
      return;
    }
    const gp = pad;
    const held = (i: number): boolean => !!gp.buttons[i]?.pressed;
    const edge = (i: number): boolean => {
      const now = held(i);
      const was = this.padPrev[i] ?? false;
      this.padPrev[i] = now;
      return now && !was;
    };
    if (edge(5)) this.gearUpQueued = true;
    if (edge(4)) this.gearDownQueued = true;
    if (edge(3)) this.cameraToggleQueued = true;
    if (edge(8)) this.autoSelectorQueued = true;
    const raw = gp.axes[0] ?? 0;
    const stick = Math.abs(raw) < PAD_DEADZONE ? 0 : (Math.sign(raw) * (Math.abs(raw) - PAD_DEADZONE)) / (1 - PAD_DEADZONE);
    const rt = gp.buttons[7]?.value ?? 0;
    const lt = gp.buttons[6]?.value ?? 0;
    const active = Math.abs(stick) > 0.02 || rt > 0.04 || lt > 0.04 || held(1) || held(2);
    if (active) this.analog = true;
    if (!this.analog) return;
    this.steer = Math.max(-1, Math.min(1, -stick));
    this.throttle = Math.max(0, Math.min(1, rt));
    this.brakeAxis = Math.max(0, Math.min(1, lt));
    this.forward = this.throttle > 0.5;
    this.brake = this.brakeAxis > 0.5;
    this.back = held(1);
    this.left = this.steer > 0.25;
    this.right = this.steer < -0.25;
    this.clutch = held(2);
  }

  consumeCameraToggle(): boolean {
    if (!this.cameraToggleQueued) return false;
    this.cameraToggleQueued = false;
    return true;
  }

  consumeWeatherCycle(): boolean {
    if (!this.weatherCycleQueued) return false;
    this.weatherCycleQueued = false;
    return true;
  }

  consumeTimeCycle(): boolean {
    if (!this.timeCycleQueued) return false;
    this.timeCycleQueued = false;
    return true;
  }

  consumeTimePause(): boolean {
    if (!this.timePauseQueued) return false;
    this.timePauseQueued = false;
    return true;
  }

  consumeGearUp(): boolean {
    if (!this.gearUpQueued) return false;
    this.gearUpQueued = false;
    return true;
  }

  consumeGearDown(): boolean {
    if (!this.gearDownQueued) return false;
    this.gearDownQueued = false;
    return true;
  }

  consumeAutoSelector(): boolean {
    if (!this.autoSelectorQueued) return false;
    this.autoSelectorQueued = false;
    return true;
  }

  consumeHGear(): number | null {
    const g = this.hGearQueued;
    this.hGearQueued = null;
    return g;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
