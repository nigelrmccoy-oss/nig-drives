# Nig Drives

Playable browser 3D driving game: take a stylized **VW Golf** (four engine options) or **New Flyer–style transit bus** (diesel / hybrid) onto real **OpenStreetMap** roads with **real elevation**, streaming chunks as you drive across North America.

Built with **Vite + TypeScript + Three.js**. No Google Maps/Earth data. No API keys.

## Changelog

### v1.3.0 — Forza-inspired visuals

- **Look:** ACES tone mapping, hemisphere + sun with PCF soft shadows, sky-dome gradient, matching fog, light bloom + SMAA. Night headlights glow; building windows emit after dusk.
- **Golf:** extruded hatchback silhouette (hood, greenhouse, C-pillar/hatch, arches, rims, swept lights) — not a fridge box. Wheels spin and steer. Engines still differ in stats only.
- **Bus:** New Flyer–style raked windshield, destination sign, beltline, window bays, dual-rear tires, HVAC / hybrid pack.
- **Roads:** procedural asphalt/normal/roughness, dashed lanes, curb shoulders. Long OSM/fallback ways are densified so they follow DEM instead of becoming giant sloped slabs. Tighter miters at sharp junctions.
- **World:** terrain vertex color + grass tint; smaller hidden ground plane; buildings use a window atlas.
- **UI:** darker automotive HUD (bottom speedo) and start menu.
- **Kept:** OSM streaming, KW + other cities, Golf engines, diesel/hybrid buses, weather, surface friction, stability guards.

### v1.2c (1.2.3) — surface-aware roads + stability hardening

- **OSM surface → friction & look:** parse `surface` (asphalt, concrete, paving_stones, gravel, dirt, grass, cobblestone, compacted, …) and `highway` class; light `maxspeed` bias. Maps to material color/roughness **and** tire grip / noise. Wet/snow multiply by surface retention (ice-like on untreated dirt/grass; motorway asphalt loses less). Offline fallback roads use plausible asphalt grip.
- **HUD:** small surface / grip hint under assists.
- **Stability:** Overpass concurrency cap + cancel on dispose; max pending tiles; NaN height/camera/vehicle guards; clamped miters & merge vert caps; DEM tile cache LRU; terrain rebuild chunked (yields); road mesh build yields every N ways; speed/yaw clamps; EngineSound only after Start gesture with safe resume.
- **Tracks:** `highway=track` included in Overpass filter (dirt default when untagged).

### v1.2.0 — spawn reliability, KW, engines & transit buses

- **Overpass hang fix:** 10s per-attempt timeouts, parallel endpoint race, limited retries; **per-tile offline road-grid fallback** kicks in immediately on fail/timeout so spawn is playable within ~15s even when Overpass is down
- **Streaming:** load spawn tile first and dismiss the spinner; stream the 5×5 ring in the background with the same timeout+fallback policy
- **DEM / terrain:** Terrarium fetches abort after ~8s (flat / last-known height); denser heightfield (96²) recenters more often (~120 m) so grades rebuild as you drive
- **Cities:** added **Kitchener–Waterloo** (King St W @ University Ave, Waterloo — 43.4728, −80.5235)
- **VW Golf engines** (start menu): 1.8 carb · 2.0 ABA · 1.9 TDI · 2.8 VR6 — distinct mass, torque curve, top speed, and engine-note pitch
- **Transit buses:** stylized New Flyer–style body (white / blue belt / green accent); **diesel** vs **hybrid** (roof pack, regen braking, different mass/power)
- Simple Web Audio engine note scales with RPM × drivetrain pitch

### v1.1.0 — polygon & stability

- **Roads:** clamped miters at sharp OSM angles (no more exploding junctions); asphalt/lane `polygonOffset`; consistent height bias above DEM so vehicles sit on pavement
- **Terrain:** bilinear Terrarium sampling across tile edges (fewer DEM seams/cracks); heightfield recenters with the player; terrain depth bias vs roads
- **Buildings:** CCW winding cleanup, duplicate-vertex strip, centroid elevation, deterministic heights, polygon offset vs ground
- **Streaming:** tile unload disposes geometries and releases way/building IDs so tiles can reload; fewer orphan meshes / leaks
- **Driving:** surface height uses road grade only near asphalt (off-road follows DEM); spawn sits on road elevation
- **Camera / weather:** camera stays above terrain; near plane tweak; rain/snow particles follow ground height; wet/snow road materials refresh correctly


## Quick start

```bash
cd /workspace/nig-drives
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

```bash
npm run build
npm run preview
```

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Accelerate |
| S / ↓ | Reverse |
| A/D or ←/→ | Steer |
| Space | Brake |
| C | Chase ↔ first-person camera |
| R | Cycle weather: clear / rain / snow |
| T | Jump time of day: dawn → day → dusk → night |
| P | Pause / resume day-night clock |

HUD buttons also switch weather and time of day.

## OSM vs Google

- Roads and buildings come from **OpenStreetMap** via the **Overpass API**.
- **Do not** use Google Maps/Earth road data.
- Attribution is on the HUD, start menu, and here.

© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Overpass API.

## Elevation / terrain

- **Source:** [AWS Open Data Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) in **Terrarium** PNG encoding (Mapzen/Joerd lineage).
- **URL pattern:** `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
- **Decode:** `(R * 256 + G + B / 256) - 32768` → meters.
- No API key. Tiles stream with map chunks; roads/buildings follow DEM grades; a local heightfield mesh shows surrounding hills.
- Heights are relative to the spawn city’s elevation so the vehicle starts near y≈0.

## Weather & day/night

- **Presets (not live weather APIs):** clear/dry, rain, snow.
- Visuals: sky/fog/lights, rain or snow particles, wet/snowy road & ground tint.
- **Grip:** clear ≈ full mu; rain/snow reduce by **surface retention** (asphalt motorway holds better than dirt/grass). Off-asphalt also lowers grip. HUD shows surface + grip %.
- Day/night cycle (~3 min) with darker night lighting; T jumps phases, P pauses.

## Driving feel (sim-cade)

Inspired by **Forza Motorsport 4 / Gran Turismo 5** feel — not a full sim claim:

- Weight transfer on brake/accel
- Simplified tire grip circle (lateral vs longitudinal tradeoff)
- Progressive understeer/oversteer at the limit; subtle ABS/TCS
- Golf engines change torque band / weight / top speed; Bus diesel vs hybrid (regen); both use weather & surface grip
- Weather and surface meaningfully change grip

## Streaming architecture

1. Spawn sets a lat/lon **geo origin** (X east, Y up, Z north, meters).
2. **~0.01° tiles** load in a 5×5 neighborhood; distant tiles unload.
3. Each tile: Terrarium DEM preload → Overpass highways + buildings → road ribbons + extruded footprints on elevation.
4. In-memory tile cache; Overpass calls rate-limited; Vite proxies `/api/overpass*` if CORS fails.
5. Per-tile offline road grid if Overpass times out (~10s); spawn never waits on the full 5×5 ring.

## Start cities

San Francisco · Chicago · New York City · Toronto · **Kitchener–Waterloo**

## Project layout

```
src/game/
  Game.ts
  weather/Environment.ts
  map/{geo,OverpassClient,ElevationSampler,RoadBuilder,RoadSurface,BuildingBuilder,TileManager}.ts
  vehicles/{Vehicle,VehicleFactory}.ts
  visuals/{Textures,PostFX}.ts
  camera/ChaseCamera.ts
  input/Input.ts
  ui/{HUD,StartMenu}.ts
  cities.ts
```

## Known limitations

- Arcade/sim-cade physics, not FM/GT fidelity.
- Visuals are Forza-**inspired** (ACES, hatch silhouette, wet roads), not FM photogrammetry — no real car scans or photo terrain.
- Building count capped per tile for performance; no full city collision.
- Overpass public instances can be slow or rate-limit; v1.2 / v1.2c fall back to offline grids quickly so you can still drive.
- Not all OSM ways have `surface=*`; missing tags infer asphalt (or dirt for tracks).
- Terrarium is bare-earth DEM — roads use a small height bias above it (v1.1), not surveyed pavement.
- Single moving heightfield patch (not full streaming LOD terrain); distant hills may look flatter until recentered.
- Local ENU projection is for regional driving, not continental precision.

## License note

Game code for this project. Map data © OpenStreetMap contributors (ODbL). Elevation © contributors to the AWS Terrain Tiles / Mapzen Terrarium dataset.
