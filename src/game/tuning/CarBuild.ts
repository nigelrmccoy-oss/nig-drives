import type { CompoundId, GarageCar, PartSlot, SetupSheet } from '../save/types';
import type { EngineSpec } from '../physics/PhysicsSpec';

/** Tunable build applied on top of a catalogue PhysicsSpec. */
export interface CarBuild {
  tyres: { front: CompoundId; rear: CompoundId };
  parts: Partial<Record<PartSlot, { stage: number; variant?: string }>>;
  conversions?: { aspiration?: string; engine?: string; drivetrain?: string };
  /** Sourced donor engine only — never invent a swap curve. */
  donorEngine?: EngineSpec;
  setup: SetupSheet;
  ballastKg?: number;
}

export function carBuildFromGarage(car: GarageCar): CarBuild {
  return {
    tyres: { ...car.tyres },
    parts: { ...car.parts },
    conversions: car.conversions ? { ...car.conversions } : undefined,
    setup: { ...car.setup },
    ballastKg: car.setup.ballastKg,
  };
}

export function stockBuild(): CarBuild {
  return {
    tyres: { front: 'all_season', rear: 'all_season' },
    parts: {},
    setup: {},
  };
}
