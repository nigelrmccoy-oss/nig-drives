/**
 * What the vehicle reads each frame (v1.4.0 M1). Input implements it; the headless
 * bench passes its own object. steer +1 = full left, throttle / brakeAxis 0–1.
 */
import { bindingsFromSettings, type BindingsMap, type InputAction } from './bindings';
import { loadSettings } from '../save/settings';

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
/** v1.4.1 P2-8: a stick resting off-centre (drift) below this never takes over from the keys. */
const PAD_TAKEOVER = 0.15;
/** Change per poll that counts as the pad being used right now. */
const PAD_MOVE = 0.04;
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];

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
  private padPrevAxes = { stick: 0, rt: 0, lt: 0 };

  private pressed = new Set<string>();
  private cameraToggleQueued = false;
  private weatherCycleQueued = false;
  private timeCycleQueued = false;
  private timePauseQueued = false;
  private gearUpQueued = false;
  private gearDownQueued = false;
  private autoSelectorQueued = false;
  private hGearQueued: number | null = null; // 0=N, -1=R, 1..6
  private assistToggleQueued = false;
  private telemetryPlusQueued = false;
  private imageryQueued = false;
  private pauseQueued = false;
  private bindings: BindingsMap = bindingsFromSettings(loadSettings().bindings);

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Reload bindings after Options saves. */
  reloadBindings(): void {
    this.bindings = bindingsFromSettings(loadSettings().bindings);
    this.sync();
  }

  private bound(action: InputAction): string[] {
    return this.bindings[action]?.keys ?? [];
  }

  private anyDown(action: InputAction): boolean {
    return this.bound(action).some((k) => this.pressed.has(k));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.code;
    const driveCodes = [
      ...this.bound('throttle'), ...this.bound('brake'),
      ...this.bound('steer_left'), ...this.bound('steer_right'),
      ...this.bound('handbrake'),
    ];
    if (driveCodes.includes(k) || this.bound('assists').includes(k) || this.bound('telemetry').includes(k)) {
      e.preventDefault();
    }
    if (driveCodes.includes(k)) this.analog = false;
    if (!this.pressed.has(k)) {
      if (this.bound('camera').includes(k)) this.cameraToggleQueued = true;
      if (this.bound('weather').includes(k)) this.weatherCycleQueued = true;
      if (this.bound('time').includes(k)) this.timeCycleQueued = true;
      if (this.bound('time_pause').includes(k)) this.timePauseQueued = true;
      if (this.bound('shift_up').includes(k)) this.gearUpQueued = true;
      if (this.bound('shift_down').includes(k)) this.gearDownQueued = true;
      if (this.bound('auto_selector').includes(k)) this.autoSelectorQueued = true;
      if (this.bound('assists').includes(k)) this.assistToggleQueued = true;
      if (this.bound('telemetry').includes(k)) this.telemetryPlusQueued = true;
      if (this.bound('imagery').includes(k)) this.imageryQueued = true;
      if (this.bound('pause').includes(k)) this.pauseQueued = true;
      if (this.bound('h1').includes(k)) this.hGearQueued = 1;
      if (this.bound('h2').includes(k)) this.hGearQueued = 2;
      if (this.bound('h3').includes(k)) this.hGearQueued = 3;
      if (this.bound('h4').includes(k)) this.hGearQueued = 4;
      if (this.bound('h5').includes(k)) this.hGearQueued = 5;
      if (this.bound('h6').includes(k)) this.hGearQueued = 6;
      if (this.bound('h_n').includes(k)) this.hGearQueued = 0;
      if (this.bound('h_r').includes(k)) this.hGearQueued = -1;
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
    this.forward = this.anyDown('throttle');
    this.back = this.anyDown('brake');
    this.left = this.anyDown('steer_left');
    this.right = this.anyDown('steer_right');
    this.brake = this.anyDown('handbrake');
    this.clutch = this.anyDown('clutch');
    if (!this.analog) {
      this.steer = (this.left ? 1 : 0) + (this.right ? -1 : 0);
      this.throttle = this.forward ? 1 : 0;
      this.brakeAxis = this.back ? 1 : 0;
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
    // v1.4.1 P2-8: the most recently used device drives. The pad takes over when it is being moved
    // (stick past the takeover threshold, a trigger or B/X), or when it is held deflected while no
    // driving key is down. A slightly deflected / drifting stick no longer blocks keyboard steering.
    const prev = this.padPrevAxes;
    const moving =
      Math.abs(stick - prev.stick) > PAD_MOVE || Math.abs(rt - prev.rt) > PAD_MOVE || Math.abs(lt - prev.lt) > PAD_MOVE;
    prev.stick = stick;
    prev.rt = rt;
    prev.lt = lt;
    const engaged = Math.abs(stick) > PAD_TAKEOVER || rt > 0.04 || lt > 0.04 || held(1) || held(2);
    const keysDown = DRIVE_KEYS.some((k) => this.pressed.has(k));
    if (engaged && (moving || !keysDown || held(1) || held(2))) this.analog = true;
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

  /** v1.4.1: F1 switches all assists off / back on (the panel is the HUD button). */
  consumeAssistToggle(): boolean {
    const v = this.assistToggleQueued;
    this.assistToggleQueued = false;
    return v;
  }

  /** v1.4.0: F2 shows / hides Telemetry+. */
  consumeTelemetryPlus(): boolean {
    const v = this.telemetryPlusQueued;
    this.telemetryPlusQueued = false;
    return v;
  }

  /** v1.5.0b: I = satellite imagery on the ground (needs a Cesium ion key). */
  consumePause(): boolean {
    const v = this.pauseQueued;
    this.pauseQueued = false;
    return v;
  }

  consumeImageryToggle(): boolean {
    const v = this.imageryQueued;
    this.imageryQueued = false;
    return v;
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
