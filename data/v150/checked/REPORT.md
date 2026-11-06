# nig-drives v1.5.0 – checked car data

Updated: 2026-11-05 (America/Toronto). Output: `checked/cars/<slug>.json` (originals under `v150/cars/` untouched).

## Summary

- Cars: **41**; fully drivable (engine + mass, power, torque, both peak rpms, redline, ratios, FD, drivetrain, tyres): **41**
- Cars with MSRP: 34/41
- Cars with derived torque curve: 41
- Swapped out (poorly documented): `plymouth-hemi-cuda-1970`, `alpine-a110-1971`
- Swapped in: `bmw-m3-e30-1988` (Euro S14 dogleg), `chevrolet-corvette-z06-2001` (LS6)

## Remaining nulls by field

- weight_dist_front_pct: 29
- zero_to_100_s: 25
- top_speed_kmh: 20
- track_front_mm: 4
- track_rear_mm: 4
- length_mm: 1
- width_mm: 1
- height_mm: 1

## Drivable gate failures (non-drivable cars)


## Per-car table

| slug | conf | drivable | redline | FD | remaining nulls |
|---|---|---|---|---|---|
| alfa-romeo-156-2.5-v6-1998 | med | yes | 7000 | 3.937 | - |
| audi-quattro-1984 | med | yes | 6750 | 3.89 | weight_dist_front_pct |
| audi-rs2-avant-1994 | med | yes | 7500 | 4.111 | weight_dist_front_pct |
| bmw-m3-e30-1988 | high | yes | 7250 | 3.25 | weight_dist_front_pct |
| bmw-m3-e46-2001 | med | yes | 8000 | 3.62 | length_mm, width_mm, height_mm, track_front_mm, track_rear_mm, zero_to_100_s, top_speed_kmh |
| chevrolet-chevelle-ss-454-1970 | high | yes | 6500 | 4.11 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| chevrolet-corvette-z06-2001 | high | yes | 6500 | 3.42 | zero_to_100_s, top_speed_kmh |
| citroen-ds-21-1967 | med | yes | 6000 | 4.375 | weight_dist_front_pct, track_front_mm, track_rear_mm, zero_to_100_s |
| datsun-240z-1971 | high | yes | 7000 | 3.364 | weight_dist_front_pct, track_front_mm, track_rear_mm, zero_to_100_s, top_speed_kmh |
| dodge-viper-gts-1996 | high | yes | 6000 | 3.07 | zero_to_100_s |
| ferrari-f355-1995 | med | yes | 8500 | 3.562 | weight_dist_front_pct |
| fiat-500r-1972 | high | yes | 4800 | 4.875 | weight_dist_front_pct, zero_to_100_s |
| ford-mustang-svt-cobra-1999 | med | yes | 6500 | 3.27 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| ford-ranger-t6-2015 | high | yes | 4900 | 3.73 | weight_dist_front_pct |
| honda-beat-1991 | med | yes | 8500 | 5.714 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| honda-civic-type-r-ek9-1997 | med | yes | 8400 | 4.4 | weight_dist_front_pct |
| honda-civic-type-r-fk8-2017 | high | yes | 7000 | 4.111 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| honda-nsx-1991 | med | yes | 8000 | 4.062 | - |
| honda-s2000-1999 | high | yes | 9000 | 4.1 | - |
| lamborghini-countach-lp5000qv-1985 | med | yes | 7500 | 4.091 | - |
| lancia-delta-integrale-1992 | med | yes | 6500 | 3.111 | zero_to_100_s, top_speed_kmh |
| lancia-stratos-hf-1974 | med | yes | 7500 | 3.824 | weight_dist_front_pct |
| lotus-elise-s1-1996 | high | yes | 7000 | 3.938 | zero_to_100_s, top_speed_kmh |
| mazda-mx5-na-1990 | high | yes | 7000 | 4.3 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| mazda-rx7-fd3s-1998 | high | yes | 8000 | 4.3 | - |
| mercedes-190e-2.3-16-1988 | high | yes | 7000 | 3.07 | weight_dist_front_pct, track_front_mm, track_rear_mm, zero_to_100_s, top_speed_kmh |
| mini-cooper-1.3i-1994 | high | yes | 6500 | 3.12 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| mitsubishi-lancer-evo-vi-1999 | high | yes | 7000 | 4.529 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| nissan-silvia-s15-1999 | high | yes | 7500 | 3.692 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| nissan-skyline-gtr-r32-1991 | med | yes | 8000 | 4.111 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| peugeot-205-gti-1986 | med | yes | 6800 | 3.688 | weight_dist_front_pct |
| porsche-911-carrera-rs-1973 | high | yes | 7200 | 4.429 | weight_dist_front_pct |
| porsche-911-gt3-992-2022 | med | yes | 9000 | 4.54 | weight_dist_front_pct |
| shelby-gt350-1966 | high | yes | 6500 | 3.89 | zero_to_100_s |
| subaru-impreza-wrx-sti-gc8-1997 | med | yes | 8000 | 4.444 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| toyota-2000gt-1967 | high | yes | 7400 | 4.375 | zero_to_100_s |
| toyota-ae86-trueno-1985 | med | yes | 7600 | 4.3 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| toyota-gr86-2022 | high | yes | 7400 | 4.1 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| toyota-mr2-sw20-1990 | med | yes | 7200 | 4.285 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| toyota-supra-a80-1997 | med | yes | 6800 | 3.266 | weight_dist_front_pct, zero_to_100_s, top_speed_kmh |
| volvo-240-estate-1985 | med | yes | 6000 | 3.31 | weight_dist_front_pct |

## Provenance rules (this pass)

- Never guess. Null if no manufacturer brochure/press kit, official tech sheet, or named period road test.
- `torque_curve` labelled `derived:shape-from-peaks` when peaks + redline are sourced.
- S2000 `final_drive` stores Honda secondary 4.100; Honda also publishes primary reduction 1.160 — see car notes.

