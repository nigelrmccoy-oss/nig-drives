#!/usr/bin/env python3
"""Build src/game/map/data/shore-west-ontario.json (v1.3.5 bundled shoreline).

Inputs are raw Overpass JSON dumps (ODbL, (c) OpenStreetMap contributors):
  ontario.json  rel["natural"="water"]["name"="Lake Ontario"]; way(r)(43.22,-80.00,43.72,-79.20); out geom;
  piers.json    way["man_made"~"^(pier|breakwater|groyne)$"](43.22,-80.00,43.72,-79.20); out geom;
  laurel.json   Laurel Creek Reservoir / Columbia Lake / Silver Lake (Waterloo) ways + relations, out geom;
Usage: build-shore-data.py <dir-with-inputs> <out.json>
"""
import json, math, sys

src, out_path = sys.argv[1], sys.argv[2]
COVER = {'s': 43.24, 'w': -79.93, 'n': 43.69, 'e': -79.30}
LAT0 = 43.45
MLAT = 111320.0
MLON = MLAT * math.cos(math.radians(LAT0))

def xy(p): return ((p[1] + 79.6) * MLON, (p[0] - LAT0) * MLAT)

def dp(pts, tol):
    """Douglas-Peucker on lat/lon points with a metre tolerance."""
    if len(pts) < 3: return pts
    P = [xy(p) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, az = P[a]; bx, bz = P[b]
        dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, pz = P[i]
            if L2 < 1e-9: d = math.hypot(px - ax, pz - az)
            else:
                t = max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L2))
                d = math.hypot(px - ax - dx * t, pz - az - dz * t)
            if d > best: best, bi = d, i
        if best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]

def enc(pts):
    """Delta-coded 1e-6 degree ints: [lat0, lon0, dlat1, dlon1, ...]."""
    o = []; pl = pn = 0
    for la, lo in pts:
        a, b = round(la * 1e6), round(lo * 1e6)
        o += [a - pl, b - pn]; pl, pn = a, b
    return o

def key(p): return (round(p[0], 7), round(p[1], 7))

def assemble(ways):
    segs = [list(w) for w in ways if len(w) >= 2]
    rings, chains = [], []
    while segs:
        cur = segs.pop(); changed = True
        while changed and key(cur[0]) != key(cur[-1]):
            changed = False
            for i, s in enumerate(segs):
                if key(s[0]) == key(cur[-1]): cur += s[1:]
                elif key(s[-1]) == key(cur[-1]): cur += s[::-1][1:]
                elif key(s[-1]) == key(cur[0]): cur = s + cur[1:]
                elif key(s[0]) == key(cur[0]): cur = s[::-1] + cur[1:]
                else: continue
                segs.pop(i); changed = True; break
        (rings if key(cur[0]) == key(cur[-1]) else chains).append(cur)
    return rings, chains

def geom(e): return [(g['lat'], g['lon']) for g in (e.get('geometry') or []) if g]

def bbox_hit(pts, b, pad=0.01):
    return any(b['s'] - pad <= la <= b['n'] + pad and b['w'] - pad <= lo <= b['e'] + pad for la, lo in pts)

# --- Lake Ontario: one open mainland chain (closed far outside the coverage box) + closed rings
on = json.load(open(f'{src}/ontario.json'))
base = on.get('osm3s', {}).get('timestamp_osm_base')
rings, chains = assemble([geom(e) for e in on['elements'] if e['type'] == 'way'])
chains.sort(key=len, reverse=True)
main = chains[0]
# the mainland chain runs Grimsby → Hamilton → Toronto (Scarborough); close it east / south of the box
if main[0][0] > main[-1][0]: main = main[::-1]
start, end = main[0], main[-1]
closure = [(end[0] + 0.03, -78.9), (43.10, -78.9), (43.10, start[1])]
poly = main + closure + [start]
water = [poly] + [r for r in rings if bbox_hit(r, COVER)]
water = [dp(r, 1.0) for r in water]
npts = sum(len(r) for r in water)

# --- piers / breakwaters / groynes in or at the lake (≤ 60 m from a lake vertex)
cell = 0.002
grid = {}
for r in water:
    for la, lo in r:
        grid.setdefault((int(la / cell), int(lo / cell)), []).append(xy((la, lo)))
def near_lake(pts, maxd=60):
    for la, lo in pts:
        x, z = xy((la, lo)); ci, cj = int(la / cell), int(lo / cell)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for qx, qz in grid.get((ci + di, cj + dj), ()):
                    if math.hypot(qx - x, qz - z) < maxd: return True
    return False
pj = json.load(open(f'{src}/piers.json'))
land_areas, land_lines = [], []
for e in pj['elements']:
    g = geom(e)
    if len(g) < 2 or not bbox_hit(g, COVER, 0) or not near_lake(g): continue
    closed = len(g) >= 4 and key(g[0]) == key(g[-1])
    (land_areas if closed and e.get('tags', {}).get('area') != 'no' else land_lines).append(dp(g, 0.5))

# --- Waterloo reservoirs (inland OSM water areas, used when Overpass has none)
lj = json.load(open(f'{src}/laurel.json'))
inland = []
for e in lj['elements']:
    t = e.get('tags', {})
    keep_t = {k: t[k] for k in ('natural', 'water', 'name', 'landuse') if k in t}
    if e['type'] == 'way':
        parts = [geom(e)]; k = f"w{e['id']}"
    else:
        parts = [[(g['lat'], g['lon']) for g in (m.get('geometry') or []) if g] for m in e.get('members', []) if m.get('type') == 'way' and m.get('role') in ('outer', 'inner', '')]
        k = f"r{e['id']}"
    parts = [dp(p, 1.0) for p in parts if len(p) >= 2]
    inland.append({'key': k, 'tags': keep_t, 'parts': [enc(p) for p in parts]})

out = {
    'v': 1,
    'attribution': '(c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
    'osmBase': base,
    'cover': COVER,
    'water': [enc(r) for r in water],
    'landAreas': [enc(r) for r in land_areas],
    'landLines': [enc(r) for r in land_lines],
    'inland': inland,
}
s = json.dumps(out, separators=(',', ':'))
open(out_path, 'w').write(s)
print(f'water rings {len(water)} ({npts} pts), piers {len(land_areas)} areas + {len(land_lines)} lines, inland {len(inland)}, {len(s)/1024:.0f} KB, base {base}')
