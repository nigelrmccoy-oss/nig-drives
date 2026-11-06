/** Auto-generated catalog of checked v1.5.0 cars. Do not edit by hand. */

import alfa_romeo_156_2_5_v6_1998 from './alfa-romeo-156-2.5-v6-1998.json' with { type: 'json' };
import audi_quattro_1984 from './audi-quattro-1984.json' with { type: 'json' };
import audi_rs2_avant_1994 from './audi-rs2-avant-1994.json' with { type: 'json' };
import bmw_m3_e30_1988 from './bmw-m3-e30-1988.json' with { type: 'json' };
import bmw_m3_e46_2001 from './bmw-m3-e46-2001.json' with { type: 'json' };
import chevrolet_chevelle_ss_454_1970 from './chevrolet-chevelle-ss-454-1970.json' with { type: 'json' };
import chevrolet_corvette_z06_2001 from './chevrolet-corvette-z06-2001.json' with { type: 'json' };
import citroen_ds_21_1967 from './citroen-ds-21-1967.json' with { type: 'json' };
import datsun_240z_1971 from './datsun-240z-1971.json' with { type: 'json' };
import dodge_viper_gts_1996 from './dodge-viper-gts-1996.json' with { type: 'json' };
import ferrari_f355_1995 from './ferrari-f355-1995.json' with { type: 'json' };
import fiat_500r_1972 from './fiat-500r-1972.json' with { type: 'json' };
import ford_mustang_svt_cobra_1999 from './ford-mustang-svt-cobra-1999.json' with { type: 'json' };
import ford_ranger_t6_2015 from './ford-ranger-t6-2015.json' with { type: 'json' };
import honda_beat_1991 from './honda-beat-1991.json' with { type: 'json' };
import honda_civic_type_r_ek9_1997 from './honda-civic-type-r-ek9-1997.json' with { type: 'json' };
import honda_civic_type_r_fk8_2017 from './honda-civic-type-r-fk8-2017.json' with { type: 'json' };
import honda_nsx_1991 from './honda-nsx-1991.json' with { type: 'json' };
import honda_s2000_1999 from './honda-s2000-1999.json' with { type: 'json' };
import lamborghini_countach_lp5000qv_1985 from './lamborghini-countach-lp5000qv-1985.json' with { type: 'json' };
import lancia_delta_integrale_1992 from './lancia-delta-integrale-1992.json' with { type: 'json' };
import lancia_stratos_hf_1974 from './lancia-stratos-hf-1974.json' with { type: 'json' };
import lotus_elise_s1_1996 from './lotus-elise-s1-1996.json' with { type: 'json' };
import mazda_mx5_na_1990 from './mazda-mx5-na-1990.json' with { type: 'json' };
import mazda_rx7_fd3s_1998 from './mazda-rx7-fd3s-1998.json' with { type: 'json' };
import mercedes_190e_2_3_16_1988 from './mercedes-190e-2.3-16-1988.json' with { type: 'json' };
import mini_cooper_1_3i_1994 from './mini-cooper-1.3i-1994.json' with { type: 'json' };
import mitsubishi_lancer_evo_vi_1999 from './mitsubishi-lancer-evo-vi-1999.json' with { type: 'json' };
import nissan_silvia_s15_1999 from './nissan-silvia-s15-1999.json' with { type: 'json' };
import nissan_skyline_gtr_r32_1991 from './nissan-skyline-gtr-r32-1991.json' with { type: 'json' };
import peugeot_205_gti_1986 from './peugeot-205-gti-1986.json' with { type: 'json' };
import porsche_911_carrera_rs_1973 from './porsche-911-carrera-rs-1973.json' with { type: 'json' };
import porsche_911_gt3_992_2022 from './porsche-911-gt3-992-2022.json' with { type: 'json' };
import shelby_gt350_1966 from './shelby-gt350-1966.json' with { type: 'json' };
import subaru_impreza_wrx_sti_gc8_1997 from './subaru-impreza-wrx-sti-gc8-1997.json' with { type: 'json' };
import toyota_2000gt_1967 from './toyota-2000gt-1967.json' with { type: 'json' };
import toyota_ae86_trueno_1985 from './toyota-ae86-trueno-1985.json' with { type: 'json' };
import toyota_gr86_2022 from './toyota-gr86-2022.json' with { type: 'json' };
import toyota_mr2_sw20_1990 from './toyota-mr2-sw20-1990.json' with { type: 'json' };
import toyota_supra_a80_1997 from './toyota-supra-a80-1997.json' with { type: 'json' };
import volvo_240_estate_1985 from './volvo-240-estate-1985.json' with { type: 'json' };

export interface CatalogCar {
  make: string; model: string; year: number; trim?: string | null;
  body_type?: string | null; drivetrain: string;
  engine?: { layout?: string; displacement_cc?: number; aspiration?: string };
  peak_power_kw: number; peak_power_rpm: number; peak_torque_nm: number; peak_torque_rpm: number;
  redline_rpm: number; gearbox_type?: string | null; gear_ratios: number[]; final_drive: number;
  curb_mass_kg: number; weight_dist_front_pct?: number | null;
  length_mm?: number | null; width_mm?: number | null; height_mm?: number | null;
  wheelbase_mm?: number | null; track_front_mm?: number | null; track_rear_mm?: number | null;
  tyre_sizes: string[]; torque_curve?: [number, number][] | null;
  top_speed_kmh?: number | null; zero_to_100_s?: number | null;
  redline_estimated?: boolean; redline_provenance?: string;
}

export const CATALOG_CARS: Record<string, CatalogCar> = {
  'alfa-romeo-156-2.5-v6-1998': alfa_romeo_156_2_5_v6_1998 as unknown as CatalogCar,
  'audi-quattro-1984': audi_quattro_1984 as unknown as CatalogCar,
  'audi-rs2-avant-1994': audi_rs2_avant_1994 as unknown as CatalogCar,
  'bmw-m3-e30-1988': bmw_m3_e30_1988 as unknown as CatalogCar,
  'bmw-m3-e46-2001': bmw_m3_e46_2001 as unknown as CatalogCar,
  'chevrolet-chevelle-ss-454-1970': chevrolet_chevelle_ss_454_1970 as unknown as CatalogCar,
  'chevrolet-corvette-z06-2001': chevrolet_corvette_z06_2001 as unknown as CatalogCar,
  'citroen-ds-21-1967': citroen_ds_21_1967 as unknown as CatalogCar,
  'datsun-240z-1971': datsun_240z_1971 as unknown as CatalogCar,
  'dodge-viper-gts-1996': dodge_viper_gts_1996 as unknown as CatalogCar,
  'ferrari-f355-1995': ferrari_f355_1995 as unknown as CatalogCar,
  'fiat-500r-1972': fiat_500r_1972 as unknown as CatalogCar,
  'ford-mustang-svt-cobra-1999': ford_mustang_svt_cobra_1999 as unknown as CatalogCar,
  'ford-ranger-t6-2015': ford_ranger_t6_2015 as unknown as CatalogCar,
  'honda-beat-1991': honda_beat_1991 as unknown as CatalogCar,
  'honda-civic-type-r-ek9-1997': honda_civic_type_r_ek9_1997 as unknown as CatalogCar,
  'honda-civic-type-r-fk8-2017': honda_civic_type_r_fk8_2017 as unknown as CatalogCar,
  'honda-nsx-1991': honda_nsx_1991 as unknown as CatalogCar,
  'honda-s2000-1999': honda_s2000_1999 as unknown as CatalogCar,
  'lamborghini-countach-lp5000qv-1985': lamborghini_countach_lp5000qv_1985 as unknown as CatalogCar,
  'lancia-delta-integrale-1992': lancia_delta_integrale_1992 as unknown as CatalogCar,
  'lancia-stratos-hf-1974': lancia_stratos_hf_1974 as unknown as CatalogCar,
  'lotus-elise-s1-1996': lotus_elise_s1_1996 as unknown as CatalogCar,
  'mazda-mx5-na-1990': mazda_mx5_na_1990 as unknown as CatalogCar,
  'mazda-rx7-fd3s-1998': mazda_rx7_fd3s_1998 as unknown as CatalogCar,
  'mercedes-190e-2.3-16-1988': mercedes_190e_2_3_16_1988 as unknown as CatalogCar,
  'mini-cooper-1.3i-1994': mini_cooper_1_3i_1994 as unknown as CatalogCar,
  'mitsubishi-lancer-evo-vi-1999': mitsubishi_lancer_evo_vi_1999 as unknown as CatalogCar,
  'nissan-silvia-s15-1999': nissan_silvia_s15_1999 as unknown as CatalogCar,
  'nissan-skyline-gtr-r32-1991': nissan_skyline_gtr_r32_1991 as unknown as CatalogCar,
  'peugeot-205-gti-1986': peugeot_205_gti_1986 as unknown as CatalogCar,
  'porsche-911-carrera-rs-1973': porsche_911_carrera_rs_1973 as unknown as CatalogCar,
  'porsche-911-gt3-992-2022': porsche_911_gt3_992_2022 as unknown as CatalogCar,
  'shelby-gt350-1966': shelby_gt350_1966 as unknown as CatalogCar,
  'subaru-impreza-wrx-sti-gc8-1997': subaru_impreza_wrx_sti_gc8_1997 as unknown as CatalogCar,
  'toyota-2000gt-1967': toyota_2000gt_1967 as unknown as CatalogCar,
  'toyota-ae86-trueno-1985': toyota_ae86_trueno_1985 as unknown as CatalogCar,
  'toyota-gr86-2022': toyota_gr86_2022 as unknown as CatalogCar,
  'toyota-mr2-sw20-1990': toyota_mr2_sw20_1990 as unknown as CatalogCar,
  'toyota-supra-a80-1997': toyota_supra_a80_1997 as unknown as CatalogCar,
  'volvo-240-estate-1985': volvo_240_estate_1985 as unknown as CatalogCar,
};

export const CATALOG_SLUGS: string[] = Object.keys(CATALOG_CARS).sort((a, b) => {
  const A = CATALOG_CARS[a], B = CATALOG_CARS[b];
  return A.make.localeCompare(B.make) || A.year - B.year || A.model.localeCompare(B.model);
});

