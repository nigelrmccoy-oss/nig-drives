#!/usr/bin/env python3
"""
v1.5.0a: bake Canada HRDEM (NRCan CanElevation, 1 m LiDAR DTM) into Terrarium-compatible PNG tiles.

  python3 scripts/bake-dem.py [--areas toronto,kw] [--zoom 16] [--out public/dem] [--jobs 4]

Needs:  pip install rasterio numpy pillow requests   (a venv is fine)
Source: STAC https://datacube.services.geo.ca/stac/api  collection hrdem-mosaic-1m, asset "dtm"
        (Cloud-Optimized GeoTIFF, EPSG:3979, CGVD2013). Open Government Licence - Canada.
Output: <out>/<z>/<x>/<y>.png  (Terrarium encoding: (R*256+G+B/256)-32768 m; B quantised to 1/16 m)
        <out>/index.json       (which tiles exist; the game never requests a tile that is not listed)
        pixels with no LiDAR DTM are written as the sentinel R=G=B=0 (the game falls back to Terrarium there)
The output folder is gitignored; keep it under ~2 GB. Re-running skips tiles that already exist.
"""
import argparse, json, math, os, sys, time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import requests
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from PIL import Image

STAC = 'https://datacube.services.geo.ca/stac/api'
ORIGIN = 20037508.342789244
SIZE = 256


def tile_bounds_3857(z, x, y):
    n = 2 ** z
    span = 2 * ORIGIN / n
    return (-ORIGIN + x * span, ORIGIN - (y + 1) * span, -ORIGIN + (x + 1) * span, ORIGIN - y * span)


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def find_dtm_href(bbox):
    s, w, n, e = bbox
    r = requests.get(f'{STAC}/search', params={'collections': 'hrdem-mosaic-1m', 'bbox': f'{w},{s},{e},{n}', 'limit': 5}, timeout=60)
    r.raise_for_status()
    feats = r.json().get('features', [])
    if not feats:
        return None
    return feats[0]['assets']['dtm']['href']


_ds = {}


def _open(href):
    if href not in _ds:
        _ds[href] = rasterio.open(href)
    return _ds[href]


def encode(h):
    """float32 metres (NaN = nodata) -> RGB uint8 Terrarium, B quantised to 1/16 m."""
    v = np.round((h + 32768.0) * 16.0) / 16.0
    nod = ~np.isfinite(h)
    v = np.where(nod, 0.0, v)
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    rgb[nod] = 0
    return rgb


def bake_tile(args):
    href, z, x, y, out = args
    path = os.path.join(out, str(z), str(x), f'{y}.png')
    if os.path.exists(path):
        return (x, y, 'skip')
    try:
        ds = _open(href)
        left, bottom, right, top = tile_bounds_3857(z, x, y)
        dst = np.full((SIZE, SIZE), np.nan, dtype=np.float32)
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif', GDAL_HTTP_MAX_RETRY='4', GDAL_HTTP_RETRY_DELAY='1', VSI_CACHE='TRUE', VSI_CACHE_SIZE='50000000'):
            reproject(
                source=rasterio.band(ds, 1), destination=dst,
                dst_transform=from_bounds(left, bottom, right, top, SIZE, SIZE), dst_crs='EPSG:3857',
                src_nodata=ds.nodata, dst_nodata=np.nan, resampling=Resampling.average,
            )
        valid = np.isfinite(dst) & (dst > -500) & (dst < 3000)
        if valid.sum() == 0:
            return (x, y, 'empty')
        dst[~valid] = np.nan
        os.makedirs(os.path.dirname(path), exist_ok=True)
        Image.fromarray(encode(dst), 'RGB').save(path, optimize=True, compress_level=9)
        return (x, y, 'ok' if valid.all() else 'partial')
    except Exception as ex:  # network hiccup: leave the tile unwritten so a re-run retries it
        return (x, y, 'err:' + str(ex)[:80])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--areas', default='')
    ap.add_argument('--zoom', type=int, default=0)
    ap.add_argument('--out', default='public/dem')
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--config', default=os.path.join(os.path.dirname(__file__), 'dem-areas.json'))
    ap.add_argument('--max-mb', type=float, default=1800)
    a = ap.parse_args()
    cfg = json.load(open(a.config))
    z = a.zoom or cfg['zoom']
    want = set(filter(None, a.areas.split(',')))
    tiles = []
    for area in cfg['areas']:
        if want and area['id'] not in want:
            continue
        s, w, n, e = area['bbox']
        href = find_dtm_href(area['bbox'])
        if not href:
            print(f"{area['id']}: no HRDEM coverage, skipped"); continue
        x0, y1 = lonlat_to_tile(w, s, z); x1, y0 = lonlat_to_tile(e, n, z)
        for ty in range(int(y0), int(y1) + 1):
            for tx in range(int(x0), int(x1) + 1):
                tiles.append((href, z, tx, ty, a.out))
        print(f"{area['id']}: {len(tiles)} tiles so far")
    stats = {}
    got = {}
    t0 = time.time()
    with ProcessPoolExecutor(a.jobs) as ex:
        for i, (x, y, st) in enumerate(ex.map(bake_tile, tiles, chunksize=4)):
            stats[st.split(':')[0]] = stats.get(st.split(':')[0], 0) + 1
            if st in ('ok', 'partial', 'skip'):
                got.setdefault(y, []).append(x)
            if (i + 1) % 100 == 0:
                print(f'{i + 1}/{len(tiles)} {stats} {time.time() - t0:.0f}s', flush=True)
    # coverage index: rows of [x0, x1] runs, merged with any existing index
    idx_path = os.path.join(a.out, 'index.json')
    rows = {}
    for ty, xs in got.items():
        xs = sorted(set(xs)); runs = []
        for xx in xs:
            if runs and xx == runs[-1][1] + 1: runs[-1][1] = xx
            else: runs.append([xx, xx])
        rows[str(ty)] = runs
    os.makedirs(a.out, exist_ok=True)
    json.dump({'v': 1, 'zoom': z, 'source': 'NRCan HRDEM 1 m DTM mosaic (CanElevation), Open Government Licence - Canada', 'rows': rows}, open(idx_path, 'w'), separators=(',', ':'))
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(a.out) for f in fs)
    print('done', stats, f'{total / 1e6:.1f} MB on disk', f'{time.time() - t0:.0f}s')
    if total / 1e6 > a.max_mb:
        print('WARNING: over the size cap'); sys.exit(2)


if __name__ == '__main__':
    main()
