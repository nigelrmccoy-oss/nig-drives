/** v1.4.0 M9: the driver's assist switches, remembered between sessions. */
export interface AssistPrefs {
  abs: boolean;
  tcs: boolean;
  stability: boolean;
}

const KEY = 'nigdrives.assists';
const DEFAULTS: AssistPrefs = { abs: true, tcs: true, stability: true };

export function loadAssistPrefs(): AssistPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<AssistPrefs>;
    return {
      abs: typeof p.abs === 'boolean' ? p.abs : DEFAULTS.abs,
      tcs: typeof p.tcs === 'boolean' ? p.tcs : DEFAULTS.tcs,
      stability: typeof p.stability === 'boolean' ? p.stability : DEFAULTS.stability,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAssistPrefs(p: AssistPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: keep for this session only */
  }
}

export const ASSIST_LABELS: Record<keyof AssistPrefs, { short: string; name: string; hint: string }> = {
  abs: { short: 'ABS', name: 'ABS', hint: 'Anti-lock brakes' },
  tcs: { short: 'TCS', name: 'Traction', hint: 'Cuts power on wheelspin' },
  stability: { short: 'STM', name: 'Stability', hint: 'Brakes a wheel to stop a spin' },
};