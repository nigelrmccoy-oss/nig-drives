export class Input {
  forward = false;
  back = false;
  left = false;
  right = false;
  brake = false;
  /** Left Shift — optional-lite clutch for stick. */
  clutch = false;

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
