/**
 * Action → keyboard / gamepad binding table.
 * Defaults match pre-1.5.0 behaviour; rebound bindings live in settings.bindings.
 */

export type InputAction =
  | 'throttle'
  | 'brake'
  | 'steer_left'
  | 'steer_right'
  | 'handbrake'
  | 'clutch'
  | 'shift_up'
  | 'shift_down'
  | 'auto_selector'
  | 'camera'
  | 'weather'
  | 'time'
  | 'time_pause'
  | 'assists'
  | 'telemetry'
  | 'imagery'
  | 'pause'
  | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'h_n' | 'h_r';

export interface ActionBinding {
  /** Keyboard KeyboardEvent.code values (any match). */
  keys: string[];
  /** Optional gamepad button index (standard mapping). */
  padButton?: number;
}

export const DEFAULT_BINDINGS: Record<InputAction, ActionBinding> = {
  throttle: { keys: ['KeyW', 'ArrowUp'], padButton: 7 }, // RT analog also
  brake: { keys: ['KeyS', 'ArrowDown'], padButton: 6 },
  steer_left: { keys: ['KeyA', 'ArrowLeft'] },
  steer_right: { keys: ['KeyD', 'ArrowRight'] },
  handbrake: { keys: ['Space'], padButton: 0 },
  clutch: { keys: ['ShiftLeft', 'ShiftRight'] },
  shift_up: { keys: ['KeyE', 'Equal', 'NumpadAdd'], padButton: 5 },
  shift_down: { keys: ['KeyQ', 'Minus', 'NumpadSubtract'], padButton: 4 },
  auto_selector: { keys: ['KeyG'], padButton: 1 },
  camera: { keys: ['KeyC'], padButton: 3 },
  weather: { keys: ['KeyR'] },
  time: { keys: ['KeyT'] },
  time_pause: { keys: ['KeyP'] },
  assists: { keys: ['F1'] },
  telemetry: { keys: ['F2'] },
  imagery: { keys: ['KeyI'] },
  pause: { keys: ['Escape'] },
  h1: { keys: ['Digit1', 'Numpad1'] },
  h2: { keys: ['Digit2', 'Numpad2'] },
  h3: { keys: ['Digit3', 'Numpad3'] },
  h4: { keys: ['Digit4', 'Numpad4'] },
  h5: { keys: ['Digit5', 'Numpad5'] },
  h6: { keys: ['Digit6', 'Numpad6'] },
  h_n: { keys: ['KeyN'] },
  h_r: { keys: ['KeyB'] },
};

export type BindingsMap = Record<InputAction, ActionBinding>;

/** Merge saved flat code overrides: action → primary key code. */
export function bindingsFromSettings(flat?: Record<string, string> | null): BindingsMap {
  const out: BindingsMap = structuredClone(DEFAULT_BINDINGS);
  if (!flat) return out;
  for (const [action, code] of Object.entries(flat)) {
    if (action in out && code) {
      const b = out[action as InputAction];
      // Keep alts after the rebound primary
      b.keys = [code, ...b.keys.filter((k) => k !== code)];
    }
  }
  return out;
}

export function flattenBindings(map: BindingsMap): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [a, b] of Object.entries(map) as [InputAction, ActionBinding][]) {
    flat[a] = b.keys[0];
  }
  return flat;
}

export const ACTION_LABELS: Record<InputAction, string> = {
  throttle: 'Throttle',
  brake: 'Brake',
  steer_left: 'Steer left',
  steer_right: 'Steer right',
  handbrake: 'Handbrake',
  clutch: 'Clutch',
  shift_up: 'Shift up',
  shift_down: 'Shift down',
  auto_selector: 'Auto P/R/N/D',
  camera: 'Camera',
  weather: 'Weather',
  time: 'Time of day',
  time_pause: 'Pause clock',
  assists: 'Assists toggle',
  telemetry: 'Telemetry+',
  imagery: 'Satellite ground',
  pause: 'Pause / menu',
  h1: 'H-pattern 1',
  h2: 'H-pattern 2',
  h3: 'H-pattern 3',
  h4: 'H-pattern 4',
  h5: 'H-pattern 5',
  h6: 'H-pattern 6',
  h_n: 'H-pattern N',
  h_r: 'H-pattern R',
};
