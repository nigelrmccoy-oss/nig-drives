/** Versioned save types for sandbox garage + driver profiles (career later). */

export type TransmissionModeSave = 'auto' | 'stick_seq' | 'stick_h';
export type PaintFinish = 'gloss' | 'metallic' | 'matte' | 'pearl';

/** Tyre compound ids — All-season is the baseline (existing tyre numbers). */
export type CompoundId =
  | 'eco'
  | 'comfort'
  | 'all_season'
  | 'sport'
  | 'sport_soft'
  | 'semi_slick'
  | 'slick_hard'
  | 'slick_soft'
  | 'winter'
  | 'rally';

export interface SetupSheet {
  // Fields unlock with parts; empty object = stock defaults from catalogue.
  rideHeightMm?: number;
  springRateFront?: number;
  springRateRear?: number;
  damperBumpFront?: number;
  damperBumpRear?: number;
  damperReboundFront?: number;
  damperReboundRear?: number;
  antiRollFront?: number;
  antiRollRear?: number;
  camberFrontDeg?: number;
  camberRearDeg?: number;
  toeFrontDeg?: number;
  toeRearDeg?: number;
  brakeBiasFrontPct?: number;
  finalDrive?: number;
  gearRatios?: number[];
  ballastKg?: number;
  ballastOffsetM?: number;
}

export type PartSlot =
  | 'intake'
  | 'exhaust'
  | 'ecu'
  | 'na_tune'
  | 'turbo'
  | 'intercooler'
  | 'flywheel'
  | 'clutch'
  | 'transmission'
  | 'diff'
  | 'driveshaft'
  | 'brakes'
  | 'suspension'
  | 'weight'
  | 'body_rigidity'
  | 'aero';

export interface GarageCar {
  id: string;
  modelId: string;
  modelRev: number;
  nickname: string;
  createdAt: string;
  updatedAt: string;
  paint: { body: string; accent?: string; finish: PaintFinish };
  tyres: { front: CompoundId; rear: CompoundId };
  parts: Partial<Record<PartSlot, { stage: number; variant?: string }>>;
  conversions?: { aspiration?: string; engine?: string; drivetrain?: string };
  setup: SetupSheet;
  assists: { abs: boolean; tcs: boolean; stability: boolean };
  transmission: TransmissionModeSave;
  odometerKm?: number;
  notes?: string;
  origin?: 'sandbox' | 'career';
}

export interface GarageDoc {
  schema: number;
  app: 'nig-drives';
  gameVersion: string;
  updatedAt: string;
  activeId: string | null;
  cars: GarageCar[];
}

export interface DriverProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DriversDoc {
  schema: number;
  app: 'nig-drives';
  gameVersion: string;
  updatedAt: string;
  activeId: string;
  drivers: DriverProfile[];
}

export interface GlobalSettings {
  schema: number;
  app: 'nig-drives';
  gameVersion: string;
  updatedAt: string;
  quality: 'low' | 'medium' | 'high';
  /** Defaults applied to newly added garage cars. */
  assistsDefault: { abs: boolean; tcs: boolean; stability: boolean };
  units: { speed: 'kmh' | 'mph'; temp: 'c' | 'f' };
  audio: { master: number; engine: number; ui: number };
  tutorialDone: boolean;
  lastCityId?: string;
  /** Input bindings land in 1.5.0f; reserved. */
  bindings?: Record<string, string>;
}
