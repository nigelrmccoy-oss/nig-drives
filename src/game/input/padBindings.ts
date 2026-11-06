/**
 * v1.5.0c: gamepad action map (first connected pad, standard Gamepad API mapping by default).
 * Saved globally in settings.padBindings; anything missing or invalid falls back to the Xbox defaults.
 */

export type PadAction =
  | 'steer'
  | 'throttle'
  | 'brake'
  | 'shift_down'
  | 'shift_up'
  | 'reverse'
  | 'clutch'
  | 'camera'
  | 'auto_selector';

/**
 * A physical pad input.
 * - button: value 0..1 (analog triggers report their pressure here on standard mapping).
 * - axis: `dir` is the push direction that counts as positive. For steer it is the "left" direction
 *   (standard stick: -1). `full` means the axis rests at -dir (trigger-as-axis, -1..1 range).
 */
export type PadInput =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; dir: 1 | -1; full?: boolean };

export type PadBindingsMap = Record<PadAction, PadInput | null>;

export const PAD_ACTIONS: PadAction[] = [
  'steer', 'throttle', 'brake', 'shift_down', 'shift_up', 'reverse', 'clutch', 'camera', 'auto_selector',
];

/** Xbox / standard mapping, identical to the 1.4.0–1.5.0b hard-coded pad layout. */
export const DEFAULT_PAD_BINDINGS: PadBindingsMap = {
  steer: { kind: 'axis', index: 0, dir: -1 },
  throttle: { kind: 'button', index: 7 },
  brake: { kind: 'button', index: 6 },
  shift_down: { kind: 'button', index: 4 },
  shift_up: { kind: 'button', index: 5 },
  reverse: { kind: 'button', index: 1 },
  clutch: { kind: 'button', index: 2 },
  camera: { kind: 'button', index: 3 },
  auto_selector: { kind: 'button', index: 8 },
};

export const PAD_ACTION_LABELS: Record<PadAction, string> = {
  steer: 'Steer (axis)',
  throttle: 'Throttle',
  brake: 'Brake',
  shift_down: 'Shift down',
  shift_up: 'Shift up',
  reverse: 'Reverse',
  clutch: 'Clutch',
  camera: 'Camera',
  auto_selector: 'Cycle P-R-N-D',
};

/** Steer needs a bipolar axis; everything else takes a button or an axis direction. */
export function padActionAcceptsButton(a: PadAction): boolean {
  return a !== 'steer';
}

const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide'];
const AXIS_NAMES = ['LS X', 'LS Y', 'RS X', 'RS Y'];

export function padInputLabel(p: PadInput | null, action?: PadAction): string {
  if (!p) return '— unbound';
  if (p.kind === 'button') return BUTTON_NAMES[p.index] ? `${BUTTON_NAMES[p.index]} (btn ${p.index})` : `Button ${p.index}`;
  const name = AXIS_NAMES[p.index] ?? `Axis ${p.index}`;
  if (action === 'steer') return `${name}${p.dir === 1 ? ' (inverted)' : ''}`;
  return `${name} ${p.dir === 1 ? '+' : '−'}${p.full ? ' (trigger)' : ''}`;
}

function validInput(v: unknown, action: PadAction): PadInput | null | undefined {
  if (v === null) return null; // explicitly unbound by a conflict move
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const idx = o.index;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 63) return undefined;
  if (o.kind === 'button') return padActionAcceptsButton(action) ? { kind: 'button', index: idx } : undefined;
  if (o.kind === 'axis') {
    if (o.dir !== 1 && o.dir !== -1) return undefined;
    const out: PadInput = { kind: 'axis', index: idx, dir: o.dir };
    if (o.full === true && action !== 'steer') out.full = true;
    return out;
  }
  return undefined;
}

/** Saved (possibly old / partial / garbage) map → full map; invalid or missing entries use the defaults. */
export function padBindingsFromSettings(saved?: unknown): PadBindingsMap {
  const out: PadBindingsMap = structuredClone(DEFAULT_PAD_BINDINGS);
  if (!saved || typeof saved !== 'object') return out;
  const s = saved as Record<string, unknown>;
  for (const a of PAD_ACTIONS) {
    if (!(a in s)) continue;
    const v = validInput(s[a], a);
    if (v !== undefined) out[a] = v;
  }
  return out;
}

/**
 * Do two bindings share one physical control? Same button always clashes. On the same axis, steer (which
 * uses both directions) clashes with anything; two half-axis uses clash only in the same direction.
 */
export function padInputsClash(aAction: PadAction, a: PadInput | null, bAction: PadAction, b: PadInput | null): boolean {
  if (!a || !b || a.kind !== b.kind || a.index !== b.index) return false;
  if (a.kind === 'button' || b.kind === 'button') return true;
  if (aAction === 'steer' || bAction === 'steer') return true;
  return a.dir === b.dir;
}

/**
 * Assign `input` to `action`; any other action on the same control is cleared (set unbound) so two actions
 * never silently share one input. Returns the actions that were cleared.
 */
export function assignPadBinding(map: PadBindingsMap, action: PadAction, input: PadInput): PadAction[] {
  const cleared: PadAction[] = [];
  for (const other of PAD_ACTIONS) {
    if (other === action) continue;
    if (padInputsClash(other, map[other], action, input)) {
      map[other] = null;
      cleared.push(other);
    }
  }
  map[action] = input;
  return cleared;
}

/** Read a bound input as 0..1 (steer: −1..1, +1 = left). `seen` tracks axes that have left an initial 0. */
export function readPadInput(pad: Gamepad, p: PadInput | null, seen?: Set<number>): number {
  if (!p) return 0;
  if (p.kind === 'button') {
    const b = pad.buttons[p.index];
    if (!b) return 0;
    return Math.max(b.value ?? 0, b.pressed ? 1 : 0);
  }
  const raw = pad.axes[p.index] ?? 0;
  if (raw !== 0) seen?.add(p.index);
  if (p.full) {
    // Trigger exposed as an axis that rests at -dir. Some browsers report 0 until first touched.
    if (seen && !seen.has(p.index)) return 0;
    return Math.max(0, Math.min(1, (p.dir * raw + 1) / 2));
  }
  return Math.max(0, Math.min(1, p.dir * raw));
}

/** Global "Options is capturing a pad input" flag. While set, Input ignores the pad (no driving, no edges). */
export const padCapture = { active: false };
