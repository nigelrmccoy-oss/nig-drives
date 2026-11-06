/** GT-style upgrade stages. Prices shown (priceRel) but never charged in sandbox. */
import type { PartSlot } from '../save/types';

export interface PartStage {
  stage: number;
  label: string;
  priceRel: number;
  /** Multipliers / additives applied by compileBuild. */
  effects: {
    torqueMul?: number;
    redlineMul?: number;
    inertiaMul?: number;
    clutchMul?: number;
    massMul?: number;
    cdAMul?: number;
    brakeMul?: number;
    rollStiffFrontAdd?: number;
    bodyFreqMul?: number;
    efficiencyAdd?: number;
  };
}

export interface PartDef {
  slot: PartSlot;
  label: string;
  stages: PartStage[];
}

export const PARTS: PartDef[] = [
  {
    slot: 'ecu',
    label: 'Racing chip / ECU',
    stages: [{ stage: 1, label: 'Chip', priceRel: 1.5, effects: { torqueMul: 1.03 } }],
  },
  {
    slot: 'intake',
    label: 'Intake',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 2, effects: { torqueMul: 1.04 } },
      { stage: 2, label: 'Semi-racing', priceRel: 4, effects: { torqueMul: 1.08 } },
      { stage: 3, label: 'Racing', priceRel: 7, effects: { torqueMul: 1.12 } },
    ],
  },
  {
    slot: 'exhaust',
    label: 'Exhaust',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 2.2, effects: { torqueMul: 1.03 } },
      { stage: 2, label: 'Semi-racing', priceRel: 5, effects: { torqueMul: 1.07 } },
      { stage: 3, label: 'Racing', priceRel: 9, effects: { torqueMul: 1.11 } },
    ],
  },
  {
    slot: 'na_tune',
    label: 'NA tune',
    stages: [
      { stage: 1, label: 'Stage 1', priceRel: 4.9, effects: { torqueMul: 1.08, redlineMul: 1.02 } },
      { stage: 2, label: 'Stage 2', priceRel: 12.5, effects: { torqueMul: 1.18, redlineMul: 1.04 } },
      { stage: 3, label: 'Stage 3', priceRel: 28, effects: { torqueMul: 1.3, redlineMul: 1.06 } },
    ],
  },
  {
    slot: 'turbo',
    label: 'Turbo kit',
    stages: [
      { stage: 1, label: 'Stage 1', priceRel: 4.8, effects: { torqueMul: 1.12 } },
      { stage: 2, label: 'Stage 2', priceRel: 14, effects: { torqueMul: 1.22 } },
      { stage: 3, label: 'Stage 3', priceRel: 32, effects: { torqueMul: 1.35 } },
      { stage: 4, label: 'Stage 4', priceRel: 55, effects: { torqueMul: 1.5 } },
    ],
  },
  {
    slot: 'intercooler',
    label: 'Intercooler',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 3, effects: { torqueMul: 1.02 } },
      { stage: 2, label: 'Racing', priceRel: 6, effects: { torqueMul: 1.04 } },
    ],
  },
  {
    slot: 'flywheel',
    label: 'Flywheel',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 0.6, effects: { inertiaMul: 0.85 } },
      { stage: 2, label: 'Semi-racing', priceRel: 1.2, effects: { inertiaMul: 0.7 } },
      { stage: 3, label: 'Racing', priceRel: 2.5, effects: { inertiaMul: 0.55 } },
    ],
  },
  {
    slot: 'clutch',
    label: 'Clutch',
    stages: [
      { stage: 1, label: 'Single plate', priceRel: 1.5, effects: { clutchMul: 1.3 } },
      { stage: 2, label: 'Twin plate', priceRel: 3, effects: { clutchMul: 1.7 } },
      { stage: 3, label: 'Triple plate', priceRel: 4.6, effects: { clutchMul: 2.2 } },
    ],
  },
  {
    slot: 'brakes',
    label: 'Brakes',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 3, effects: { brakeMul: 1.12 } },
      { stage: 2, label: 'Racing', priceRel: 8, effects: { brakeMul: 1.25 } },
    ],
  },
  {
    slot: 'suspension',
    label: 'Suspension',
    stages: [
      { stage: 1, label: 'Sports', priceRel: 4, effects: { bodyFreqMul: 1.08, rollStiffFrontAdd: 0.02 } },
      { stage: 2, label: 'Semi-racing', priceRel: 9, effects: { bodyFreqMul: 1.15, rollStiffFrontAdd: 0.04 } },
      { stage: 3, label: 'Full custom', priceRel: 18, effects: { bodyFreqMul: 1.22, rollStiffFrontAdd: 0.05 } },
    ],
  },
  {
    slot: 'weight',
    label: 'Weight reduction',
    stages: [
      { stage: 1, label: 'Stage 1', priceRel: 1.2, effects: { massMul: 0.95 } },
      { stage: 2, label: 'Stage 2', priceRel: 5.5, effects: { massMul: 0.9 } },
      { stage: 3, label: 'Stage 3', priceRel: 22, effects: { massMul: 0.85 } },
    ],
  },
  {
    slot: 'body_rigidity',
    label: 'Body rigidity',
    stages: [{ stage: 1, label: 'Cage / braces', priceRel: 6, effects: { bodyFreqMul: 1.05, rollStiffFrontAdd: 0.03 } }],
  },
  {
    slot: 'driveshaft',
    label: 'Carbon driveshaft',
    stages: [{ stage: 1, label: 'Carbon', priceRel: 4, effects: { efficiencyAdd: 0.005 } }],
  },
  {
    slot: 'aero',
    label: 'Aero kit',
    stages: [
      { stage: 1, label: 'Street', priceRel: 3, effects: { cdAMul: 0.97 } },
      { stage: 2, label: 'Track', priceRel: 10, effects: { cdAMul: 0.92 } },
    ],
  },
  {
    slot: 'transmission',
    label: 'Close-ratio gearbox',
    stages: [
      { stage: 1, label: 'Close', priceRel: 8, effects: {} },
      { stage: 2, label: 'Super-close', priceRel: 16, effects: {} },
    ],
  },
  {
    slot: 'diff',
    label: 'LSD',
    stages: [
      { stage: 1, label: '1-way', priceRel: 5, effects: {} },
      { stage: 2, label: '1.5-way', priceRel: 7, effects: {} },
      { stage: 3, label: '2-way', priceRel: 9, effects: {} },
    ],
  },
];

export function partBySlot(slot: PartSlot): PartDef | undefined {
  return PARTS.find((p) => p.slot === slot);
}

export function stageOf(slot: PartSlot, stage: number): PartStage | undefined {
  return partBySlot(slot)?.stages.find((s) => s.stage === stage);
}

/** Rough list price in sandbox display credits (priceRel × 1000). */
export function displayPrice(priceRel: number): number {
  return Math.round(priceRel * 1000);
}
