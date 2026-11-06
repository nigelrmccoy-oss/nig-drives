/**
 * Engine / drivetrain swaps — donor must be a catalogue / hand-spec id with real curves.
 * No invented engines.
 */
import { physicsSpecFor } from '../physics/deriveSpec';
import { VEHICLE_SPECS } from '../vehicles/Vehicle';
import { peakPower, type EngineSpec, type DriveLayout } from '../physics/PhysicsSpec';

export interface DonorOption {
  modelId: string;
  label: string;
  engine: EngineSpec;
  drive: DriveLayout;
}

export function listEngineDonors(): DonorOption[] {
  const out: DonorOption[] = [];
  for (const id of Object.keys(VEHICLE_SPECS)) {
    const vs = VEHICLE_SPECS[id];
    if (!vs || vs.class === 'bus') continue;
    try {
      const phys = physicsSpecFor(vs);
      if (!phys.engine?.torqueCurve?.length) continue;
      out.push({
        modelId: id,
        label: `${vs.name} · ${Math.round(peakPower(phys.engine.torqueCurve, phys.engine.limiterRpm).watts / 1000)} kW`,
        engine: structuredClone(phys.engine),
        drive: phys.drive,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function donorEngine(modelId: string): EngineSpec | null {
  const vs = VEHICLE_SPECS[modelId];
  if (!vs) return null;
  try {
    return structuredClone(physicsSpecFor(vs).engine);
  } catch {
    return null;
  }
}
