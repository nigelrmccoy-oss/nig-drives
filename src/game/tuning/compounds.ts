/** Relative tyre compound table (All-season = 1.0 = existing car tyre numbers). */
import type { CompoundId } from '../save/types';

export interface Compound {
  id: CompoundId;
  label: string;
  family: 'road' | 'sport' | 'race' | 'winter' | 'rally';
  mu: number;
  peakSlip: number;
  peakAngle: number;
  C: number;
  slideFloor: number;
  loadSens: number;
  rollRes: number;
  relax: number;
  widthM: number;
  inertia: number;
  wet: number;
  snow: number;
  loose: number;
  priceRel: number;
  lifeRel: number;
}

export const COMPOUNDS: Record<CompoundId, Compound> = {
  eco: {
    id: 'eco', label: 'Eco', family: 'road',
    mu: 0.88, peakSlip: 1.12, peakAngle: 1.1, C: -0.05, slideFloor: 0.86,
    loadSens: 0, rollRes: 0.85, relax: 1, widthM: 1, inertia: 1,
    wet: 0.85, snow: 0.85, loose: 0.95, priceRel: 0.6, lifeRel: 1.4,
  },
  comfort: {
    id: 'comfort', label: 'Comfort', family: 'road',
    mu: 0.93, peakSlip: 1.08, peakAngle: 1.08, C: -0.03, slideFloor: 0.85,
    loadSens: 0, rollRes: 0.92, relax: 1, widthM: 1, inertia: 1,
    wet: 0.92, snow: 0.85, loose: 0.95, priceRel: 0.8, lifeRel: 1.2,
  },
  all_season: {
    id: 'all_season', label: 'All-season', family: 'road',
    mu: 1, peakSlip: 1, peakAngle: 1, C: 0, slideFloor: 0.8,
    loadSens: 0, rollRes: 1, relax: 1, widthM: 1, inertia: 1,
    wet: 1, snow: 1.1, loose: 1, priceRel: 1, lifeRel: 1,
  },
  sport: {
    id: 'sport', label: 'Sport', family: 'sport',
    mu: 1.1, peakSlip: 0.95, peakAngle: 0.95, C: 0.05, slideFloor: 0.78,
    loadSens: 0, rollRes: 1.05, relax: 0.95, widthM: 1.02, inertia: 1,
    wet: 0.95, snow: 0.45, loose: 0.92, priceRel: 1.4, lifeRel: 0.75,
  },
  sport_soft: {
    id: 'sport_soft', label: 'Sport Soft', family: 'sport',
    mu: 1.18, peakSlip: 0.92, peakAngle: 0.92, C: 0.08, slideFloor: 0.76,
    loadSens: 0, rollRes: 1.1, relax: 0.92, widthM: 1.04, inertia: 1,
    wet: 0.9, snow: 0.35, loose: 0.88, priceRel: 1.7, lifeRel: 0.55,
  },
  semi_slick: {
    id: 'semi_slick', label: 'Semi-slick', family: 'race',
    mu: 1.3, peakSlip: 0.88, peakAngle: 0.88, C: 0.12, slideFloor: 0.74,
    loadSens: 0.02, rollRes: 1.15, relax: 0.88, widthM: 1.08, inertia: 1.05,
    wet: 0.7, snow: 0.25, loose: 0.8, priceRel: 2.2, lifeRel: 0.4,
  },
  slick_hard: {
    id: 'slick_hard', label: 'Slick Hard', family: 'race',
    mu: 1.38, peakSlip: 0.85, peakAngle: 0.85, C: 0.15, slideFloor: 0.74,
    loadSens: 0.03, rollRes: 1.2, relax: 0.85, widthM: 1.12, inertia: 1.08,
    wet: 0.55, snow: 0.2, loose: 0.72, priceRel: 3, lifeRel: 0.35,
  },
  slick_soft: {
    id: 'slick_soft', label: 'Slick Soft', family: 'race',
    mu: 1.52, peakSlip: 0.82, peakAngle: 0.82, C: 0.18, slideFloor: 0.72,
    loadSens: 0.04, rollRes: 1.25, relax: 0.82, widthM: 1.14, inertia: 1.1,
    wet: 0.5, snow: 0.15, loose: 0.68, priceRel: 3.5, lifeRel: 0.22,
  },
  winter: {
    id: 'winter', label: 'Winter', family: 'winter',
    mu: 0.93, peakSlip: 1.05, peakAngle: 1.05, C: -0.02, slideFloor: 0.84,
    loadSens: 0, rollRes: 1.05, relax: 1.05, widthM: 1, inertia: 1,
    wet: 1, snow: 1.55, loose: 1.05, priceRel: 1.2, lifeRel: 0.9,
  },
  rally: {
    id: 'rally', label: 'Rally', family: 'rally',
    mu: 0.95, peakSlip: 1.1, peakAngle: 1.1, C: -0.05, slideFloor: 0.88,
    loadSens: 0, rollRes: 1.2, relax: 1.1, widthM: 1.05, inertia: 1.05,
    wet: 0.95, snow: 1.2, loose: 1.35, priceRel: 1.8, lifeRel: 0.7,
  },
};

export const COMPOUND_ORDER: CompoundId[] = [
  'eco', 'comfort', 'all_season', 'sport', 'sport_soft',
  'semi_slick', 'slick_hard', 'slick_soft', 'winter', 'rally',
];
