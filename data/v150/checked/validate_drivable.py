#!/usr/bin/env python3
"""Completeness validator for checked car pack. Writes REPORT.md + _build.json summary."""
import json, os, collections, math, re
ROOT=os.path.expanduser('~/nig-drives-data/v150/checked')
CARS=os.path.join(ROOT,'cars')
DRV=['curb_mass_kg','peak_power_kw','peak_torque_nm','peak_power_rpm','peak_torque_rpm',
     'redline_rpm','gear_ratios','final_drive','drivetrain','tyre_sizes']
# also require engine block present
ENG=['layout','displacement_cc','aspiration']

def get(c,k):
    if k.startswith('engine.'): return (c.get('engine') or {}).get(k[7:])
    return c.get(k)

rows=[]; nullc=collections.Counter(); missing_drv=collections.Counter()
for fn in sorted(os.listdir(CARS)):
    if not fn.endswith('.json'): continue
    slug=fn[:-5]
    c=json.load(open(os.path.join(CARS,fn)))
    miss=[k for k in DRV if get(c,k) in (None,[],'')]
    eng_miss=[k for k in ENG if not (c.get('engine') or {}).get(k)]
    drv=not miss and not eng_miss
    # refresh flag
    c['drivable']=drv
    json.dump(c, open(os.path.join(CARS,fn),'w'), indent=1, ensure_ascii=False)
    nulls=[k for k in [
        'peak_power_kw','peak_power_rpm','peak_torque_nm','peak_torque_rpm','redline_rpm',
        'gearbox_type','gear_ratios','final_drive','curb_mass_kg','weight_dist_front_pct',
        'length_mm','width_mm','height_mm','wheelbase_mm','track_front_mm','track_rear_mm',
        'tyre_sizes','zero_to_100_s','top_speed_kmh','drivetrain','torque_curve'
    ] if get(c,k) in (None,[],'')]
    for k in nulls: nullc[k]+=1
    for k in miss: missing_drv[k]+=1
    rows.append(dict(
        slug=slug, conf=c.get('checked_confidence'), drv=drv, nulls=nulls,
        flags=c.get('checked_flags') or [], msrp=(c.get('msrp') or {}).get('amount') is not None,
        redline=c.get('redline_rpm'), fd=c.get('final_drive'),
        make=c.get('make'), model=c.get('model'), year=c.get('year'),
        miss_drv=miss+['engine.'+k for k in eng_miss],
    ))

n=len(rows); nd=sum(1 for r in rows if r['drv'])
ncurve=sum(1 for r in rows if 'torque_curve' not in r['nulls'])
nmsrp=sum(1 for r in rows if r['msrp'])

L=[]
L+=['# nig-drives v1.5.0 – checked car data','']
L+=['Updated: 2026-11-05 (America/Toronto). Output: `checked/cars/<slug>.json` (originals under `v150/cars/` untouched).','']
L+=['## Summary','']
L+=[f'- Cars: **{n}**; fully drivable (engine + mass, power, torque, both peak rpms, redline, ratios, FD, drivetrain, tyres): **{nd}**']
L+=[f'- Cars with MSRP: {nmsrp}/{n}']
L+=[f'- Cars with derived torque curve: {ncurve}']
L+=['- Swapped out (poorly documented): `plymouth-hemi-cuda-1970`, `alpine-a110-1971`']
L+=['- Swapped in: `bmw-m3-e30-1988` (Euro S14 dogleg), `chevrolet-corvette-z06-2001` (LS6)']
L+=['','## Remaining nulls by field','']
for k,v in nullc.most_common():
    L.append(f'- {k}: {v}')
L+=['','## Drivable gate failures (non-drivable cars)','']
for r in rows:
    if not r['drv']:
        L.append(f'- {r["slug"]}: missing {", ".join(r["miss_drv"])}')
L+=['','## Per-car table','','| slug | conf | drivable | redline | FD | remaining nulls |','|---|---|---|---|---|---|']
for r in rows:
    L.append(f'| {r["slug"]} | {r["conf"]} | {"yes" if r["drv"] else "no"} | {r["redline"] if r["redline"] is not None else "—"} | {r["fd"] if r["fd"] is not None else "—"} | {", ".join(r["nulls"]) or "-"} |')

L+=['','## Provenance rules (this pass)','',
'- Never guess. Null if no manufacturer brochure/press kit, official tech sheet, or named period road test.',
'- `torque_curve` labelled `derived:shape-from-peaks` when peaks + redline are sourced.',
'- S2000 `final_drive` stores Honda secondary 4.100; Honda also publishes primary reduction 1.160 — see car notes.',
'']
open(os.path.join(ROOT,'REPORT.md'),'w').write('\n'.join(L)+'\n')
json.dump({'summary':rows,'generated':'2026-11-05','drivable':nd,'cars':n}, open(os.path.join(ROOT,'_build.json'),'w'), indent=1, default=str)
print(f'{n} cars; drivable {nd}; curve {ncurve}; msrp {nmsrp}')
print('nulls', nullc.most_common(12))
print('still missing redline:', sum(1 for r in rows if r['redline'] is None))
