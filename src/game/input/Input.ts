export class Input {
  forward = false;
  back = false;
  left = false;
  right = false;
  brake = false;

  private pressed = new Set<string>();
  private cameraToggleQueued = false;
  private weatherCycleQueued = false;
  private timeCycleQueued = false;
  private timePauseQueued = false;

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

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
