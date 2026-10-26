# Nig Drives

A browser driving game on real **OpenStreetMap** roads with **real elevation**, streamed in
chunks as you drive across North America. Pick a stylized **VW Golf** (1.8 carb, 2.0, 1.9 TDI
or VR6), a **New Flyer–style transit bus** (diesel or hybrid) or a **Tesla Model 3 Long Range
AWD**. Each one runs on a sim-cade tyre and drivetrain model built from real spec sheets.

Built with **Vite + TypeScript + Three.js**. No Google Maps or Earth data, no API keys.

## Changelog

### v1.4.2 (package 1.4.2) — Code Critic's v1.4.1 findings

- **No kick when you let go of a key.** Keyboard steering at speed now asks for about 0.8 of the
  grip-limited cornering force (using each car's own understeer), so a held key no longer drags
  the rear past its grip and there is nothing to catch on release. The countersteer helper only
  acts on a real slide: the car yawing more than you asked for, the rear axle past its peak and
  the tail swinging out further. Steer kick on release at 125 and 170 km/h: up to −0.61 → 0.00.
- **Tesla settles hands-off with assists off,** like the Golfs (beta 43.7° and a spin → 2.6°).
  It was a linear oversteerer (negative understeer gradient); the rear tyres now have a smaller
  peak slip angle (stiffer rear axle). Regen splits front/rear by motor power (0.43 front) and
  each axle's regen stays inside the grip it has left after cornering.
- **Gamepad flick at speed.** A full stick's slip-angle allowance shrinks with speed like the
  keyboard's: Golf 2.0 pad flick at 110 km/h with assists off 57.2° (spin) → 10.7°. An unlocked
  torque converter no longer passes stale engine inertia to the wheels.
- **Pedal.** The pedal map is progressive and adds to the idle fuelling, so every petrol and
  diesel car pulls smoothly from about 10 % pedal (the TDI needed 30 %). Full-pedal times are
  unchanged within 0.1 s.
- **UI.** Telemetry+ moves below the Assists panel while it is open (they overlapped at 1600×900).
- Menu, HUD badge and window title read v1.4.2.

Known limitation: a full-stick pendulum flick with assists off can still spin the Golfs at
120–130 km/h and up, and the Tesla at 80–100 and 130 km/h and up (25 of 50 speed/car cases,
down from 37 in 1.4.0 and 34 in 1.4.1). With ESC on, none spin.

### v1.4.1 (package 1.4.1) — Handling and assist fixes, Dyno and menu fixes

- **ESC** no longer brakes in steady cornering (it was active the whole time on some cars). At
  full lock and low speed, traction control brakes the spinning inner wheel instead of cutting
  the engine.
- **Steering and stability.** Keyboard steering limits lock at speed, so a quick flick no longer
  spins the car. The countersteer helper no longer kicks the wheel the other way when you let go
  of a key. Buses get twin rear tyres and the Tesla has a more realistic yaw inertia.
- **Low frame rates.** Physics catches up to real time down to 5 fps (it used to slow down
  at 15 fps and below). A NaN in the physics now resets the car in place instead of breaking it.
- **Automatics creep** in D like a real torque converter, and hold on a gentle slope.
- **Gamepad and keyboard.** A drifting stick no longer blocks the keys, and a held key no longer
  locks out the stick.
- **Real power figures.** VR6 128 kW (174 PS) and 1.8 66 kW (90 PS) with realistic weights; the
  VR6 uses its real 5-speed ratios. The Tesla card shows the 350 kW the sim uses.
- **Dyno.** Peak wheel power is a steady reading, so shift spikes no longer count. The roller run
  goes on until the car reaches its real top speed.
- **UI.** F1 switches all assists off or back on; single assists are in the HUD Assists panel.
  Telemetry+ sits below the open Assists panel. At 1600×900 the menu fits, with Start and Dyno
  always visible.

Bench numbers (flat dry road, auto box, assists on):

| Car | 0-50 | 0-100 | 400 m | Top | 100-0 | Skidpad |
|-----|------|-------|-------|-----|-------|---------|
| Tesla Model 3 LR AWD | 2.3 s | 4.4 s | 12.4 s | 200 km/h | 43.0 m | 0.93 g |
| Golf 1.8 carb | 4.9 s | 12.7 s | 19.1 s | 177 km/h | 44.4 m | 0.87 g |
| Golf 2.0 | 4.6 s | 12.2 s | 18.8 s | 190 km/h | 43.0 m | 0.87 g |
| Golf 1.9 TDI | 4.9 s | 13.1 s | 19.3 s | 186 km/h | 43.0 m | 0.86 g |
| Golf VR6 | 3.9 s | 9.2 s | 16.8 s | 222 km/h | 44.7 m | 0.86 g |
| Bus diesel | 10.7 s | 42.3 s | 27.0 s | 103 km/h | 71.0 m | 0.66 g |
| Bus hybrid | 8.5 s | 29.8 s | 24.7 s | 113 km/h | 58.5 m | 0.66 g |

VW quotes 9.0 s for the VR6 automatic (7.6 s manual). The current Model 3 LR AWD tops out at
200 km/h (the sim measures 200.4); the 233 km/h figure is for the 2021–23 car.

### v1.4.0 (package 1.4.0) — Real vehicle physics, Tesla Model 3, assists, Telemetry+, Dyno

The "Mario Kart" handling is gone. The car is now a proper sim-cade model at a
fixed 120 Hz step, with spec sheets taken from real manufacturer data.

- **Tyres and chassis.** Per-wheel suspension and load (weight transfer front/rear
  and side to side, anti-roll split), a combined-slip tyre model (slip ratio and
  slip angle share one friction circle), yaw inertia and aero drag/downforce.
  Weather and surface grip still apply on top.
- **Powertrain.** Engine torque tables, friction, idle governor and rev limiter,
  turbo spool and lag for the turbo engines, an auto-clutch that launches
  and shifts like a driver's left foot, and real gear ratios and final drives.
- **Brakes and assists.** Brake torque per axle, ABS, traction control and
  stability control. Each can be switched on or off on the start menu or in game
  (**F1** or the HUD Assists button); the choice is remembered. HUD lights show
  when ABS, TCS or ESC are working and when the car is sliding.
- **Tesla Model 3 Long Range AWD (EV class).** Dual-motor drive with per-motor
  torque/power limits, a single-speed reduction, battery power and state of
  charge, one-pedal regen that backs off when the tyres slide, a new low-poly
  body and an electric motor sound. HUD shows power, regen and battery.
- **Golfs and buses** keep their four engines and two drivetrains, now with real
  spec sheets; the 1.9 TDI got a launch/shift tune (0-100 km/h about 12.9 s,
  still 90 PS). Generated/procedural vehicles stay drivable.
- **Telemetry+ (F2).** Per-wheel load, slip ratio, slip angle and grip use, a
  friction circle with trail, pedals and steering.
- **Dyno.** A Dyno button on the start menu shows torque and power curves (and
  boost, or per-motor and battery power for the EV), plus a rolling-road pull.
- Menu, HUD badge and window title read v1.4.0.

Bench numbers (flat dry road, assists on):

| Car | 0-50 | 0-100 | 400 m | Top | 100-0 | Skidpad |
|-----|------|-------|-------|-----|-------|---------|
| Tesla Model 3 LR AWD | 2.3 s | 4.4 s | 12.4 s | 200 km/h | 43.0 m | 0.94 g |
| Golf 1.8 carb | 6.5 s | 18.7 s | 21.9 s | 160 km/h | 44.4 m | 0.86 g |
| Golf 2.0 | 5.0 s | 12.7 s | 19.2 s | 190 km/h | 43.1 m | 0.85 g |
| Golf 1.9 TDI | 4.6 s | 12.9 s | 19.1 s | 186 km/h | 43.6 m | 0.85 g |
| Golf VR6 | 4.8 s | 10.4 s | 17.9 s | 218 km/h | 45.7 m | 0.87 g |
| Bus diesel | 11.1 s | 42.7 s | 27.3 s | 103 km/h | 70.9 m | 0.65 g |
| Bus hybrid | 8.8 s | 30.2 s | 25.0 s | 113 km/h | 62.0 m | 0.69 g |

### v1.3.6 (package 1.3.11) — Stream OSM after ready, water agreement, dry roads

- **Ready first, OSM after.** The start tile no longer waits on Overpass: it
  uses the cached tile if there is one, otherwise the bundled/offline map, and
  the game is ready immediately. Real OSM streams in afterwards and is swapped
  in place (built off-screen, children swapped in one frame); the car is lifted
  or snapped to the nearest road if the swap would leave it in water or inside
  a building.
- **Overpass client:** ~55 s per attempt (server timeout 45 s), at most 2
  requests in flight, one hedge after 35 s, losing requests aborted, kumi and
  coffee mirrors only when the primaries are cooling, per-mirror exponential
  cooldowns. Every complete *and* partial result is cached (IndexedDB), so the
  second load comes straight from the cache.
- **Water:** physics water now follows the drawn lake plane (no more wet land
  or dry water at the shoreline); river polygons that meet the lake are sunk to
  lake level; roads and bridges are never water; filler grids and filler
  buildings keep a margin from water.
- **Piers:** the bundled shoreline keeps piers and breakwaters that stand in
  open water (e.g. the Hamilton canal breakwater).
- **Buildings:** walls left hanging after a later road carved the ground under
  them are re-heighted.
- **HUD:** the place name comes from a gazetteer with several anchors per city
  (no more "Toronto" at Hamilton).

### v1.3.5 (package 1.3.10) — Overpass resilience, bundled shoreline, load hitch
- Overpass: 30 s attempts, `[timeout:25]`, identifying User-Agent (dev/preview proxy + Electron), mirror order de → mail.ru → kumi → coffee with backoff/cooldown on 429/5xx, 30 s spawn budget, and a 24 h IndexedDB last-good cache (stale cache used when every mirror fails).
- Bundled western Lake Ontario shoreline (Hamilton → Toronto, plus Silver Lake / Laurel Creek / Columbia Lake), rasterised with an exact even-odd fill; piers stamped as land. Data © OpenStreetMap contributors, ODbL — see CREDITS.md. Humber shoreline offset 29.2 m → ~1.3 m median.
- Terrain (ring, skirts and physics) is kept ≥ 17 cm off the water plane: 0 cells / 0 ring vertices within 15 cm.
- No more sinking on mis-flagged shore cells: a DEM-only mask is ignored and physics follows the drawn mesh near the water.
- Time button: the first click jumps to the next preset with a different label (Day → Dusk) and changes the sky.
- Load freeze 1.4–1.7 s → ≤ ~0.3 s: cached road-texture noise, deferred road materials, and shaders precompiled behind the loading screen.

### v1.3.4 (package 1.3.9) — Water stops the car, shoreline and QA fixes
- **Street labels:** only major roads (motorway/trunk/primary/secondary/tertiary, as in 1.3.1e) get labels. Residential, living_street, service and unclassified names are never shown.
- **Water:** lakes, the sea and rivers are a `Water` surface (grip 10 %, heavy drag, splash). After 2.2 s the car is put back on the last dry road point.
- **HUD:** the top row leaves room for the minimap, so the Weather and Time buttons take mouse clicks whether the map is collapsed or expanded.
- **Offline grid:** fallback roads are cut against water every ~6 m and fillers skip wet ground, so no grid is laid over Lake Ontario.
- **Shoreline:** a 2.5 m Great-Lake shore mask near the camera. OSM shore lines (lake multipolygon members, piers, breakwaters) set the boundary when Overpass answers; otherwise the fine DEM is used.
- **Shore z-fighting:** terrain is kept ≥ 15 cm off the water plane.
- **Buildings:** each wall vertex has its own foundation (walls no longer sink or float). Fillers stay ≥ 3 m clear of every road, and the car is pushed out of building walls.
- `<title>` now reads v1.3.4.

### v1.3.3 (package 1.3.8) — Textured buildings and real water

- Buildings: shared facade texture-array material (brick, concrete, glass curtain wall), procedural whole-storey windows with faint night lights, styles from OSM tags (type, levels, colour, material), gable roofs on small houses.
- Water: OSM lakes, rivers and multipolygons rasterised into the terrain (lake beds sunk under the surface), Great Lakes level plane for Lake Ontario, ripple water shader, landuse tints; buildings and offline grid roads skipped on water.
- Known gaps: no arched bridges or tunnel interiors.

### v1.3.2 (package 1.3.7) — Real hills, terrain correctness, photoreal CC0 textures

- **World orientation fixed:** the map was mirrored north↔south. Now X = east, Z = south (right-handed), so streets sit on the correct side; the minimap arrow and city spawn headings use compass bearings.
- **Elevation:** Terrarium z14 (was z12) with pixel-centre bilinear sampling (half-pixel fix), no "last sampled" plateau fill, and roads/buildings re-heighted when a late DEM tile arrives.
- **Roads follow real grades:** each way is densified, smoothed and grade-capped by class (motorway 8 %, links 10 %, primary/secondary 15 %, tertiary 22 %, residential 35 % — SF's 22nd St reads ~32 %), junctions pinned so ways meet, bridges/tunnels level between their ends.
- **Terrain:** near (1.2 km, carved), mid (4.8 km) and far (16 km) rings, built in time slices; road corridors flattened ~1 m past the edge with blended shoulders (replaces the old −0.62 m sink); sea-level water plane (SF Bay); fog pushed out to ~7 km so the next hill and skyline read.
- **Car on slopes:** body pitch/roll from four wheel contacts, gravity along the grade, engine braking in gear, brake/Park hold, and a hold after spawn/teleport until you touch a control. Buildings get foundations sized to the slope.
- **Photoreal CC0 textures** (Poly Haven + ambientCG, ~6 MB WebP + 0.5 MB HDRI, see `public/textures/CREDITS.md`): grass/dirt/rock/snow terrain splat (slope, verge, curvature, macro noise; triplanar rock; anti-tiling), photo asphalt/concrete/paving/gravel/dirt roads with world-space UVs, rain puddles/gloss, snow cover; sky HDRI lighting with lower ambient.
- **Graphics preset** in the start menu: Low / **Medium (default)** / High — pixel ratio 1.0/1.25/1.5, shadow map, near-terrain resolution, normal/triplanar/ARM maps, bloom. Saved locally; `?quality=low|medium|high` overrides. **FPS counter** on the HUD.
- **Performance:** buildings merged into one mesh per material per tile and built in 5 ms slices; road surface/nearest-road lookups use a spatial index; geometry disposed on unload.
- QA: `?spawn=lat,lon[,heading]` spawns anywhere (e.g. `?spawn=37.7553,-122.4290,90` for 22nd St). `?fallback=1` unchanged. Web build only (no Electron rebuild).

### v1.3.1e (package 1.3.6) — Overpass mirror failover

- **Online OSM on Cursor box / flaky TLS:** `overpass-api.de` often fails with TLS unexpected EOF here; **kumi** and **maps.mail.ru** respond. Vite primary `/api/overpass` now proxies **kumi**; secondary `/api/overpass-mailru` → mail.ru; `/api/overpass-de` last-resort only. Legacy `/api/overpass-kumi` kept as kumi alias. Exact `^…$` proxy contexts so `/api/overpass` does not steal `/api/overpass-*`.
- **Client:** race same-origin proxies first (no CORS), then healthy directs; do not let dead de burn the first race. Offline grid fallback still applies on true outages.
- Does not change street-label logic from 1.3.1d. Web build only (no Electron rebuild).

### v1.3.1d (package 1.3.5) — Online OSM street labels

- **Street labels (online fix):** OSM ways are often short intersection fragments — 1.3.1c’s first sample at ~64 m skipped most named ways. Short ways now get a mid-segment pin; named residential/unclassified/living_street included; slightly larger curb-scale sprites + softer view-cone so labels stay visible along roads without windshield takeover. `?fallback=1` grids still label.
- Web build only (no Windows exe rebuild).

### v1.3.1c (package 1.3.4) — Labels, fallback QA, denser buildings

- **Street labels:** Smaller world scale, curb-height anchors (less floaty), mid-range distance fade + view-cone attenuation so windshield/drive view stays clear.
- **Fallback roads QA:** Force offline grids with **`?fallback=1`** (or `?offline=1`) — skips Overpass. Grid mix includes primary/secondary/residential with names, asphalt, center dashes, edge paint, and curbs. Sparse tiles get procedural block-fill buildings.
- **Buildings:** Lower min footprint, higher per-tile Overpass cap (prefer larger footprints when trimming), procedural roadside fillers when OSM density is sparse (~220+ target feel) without floaters.
- Web build only (no Windows exe rebuild).

### v1.3.1b (package 1.3.3) — Critic playtest fixes

- **Fallback / paved roads:** Lane + curb ribbons no longer silently dropped (thin-ribbon width guard was rejecting ~0.1–0.3 m marks). Center dashes + edge paint + curbs on residential-scale paved ways — same visual language as OSM roads (no more featureless slabs).
- **Minimap:** Expanded map stays a **semi-transparent corner panel** (~220 px) instead of a centered takeover; ✕ / Esc / click to dismiss.
- **Buildings + labels:** Higher per-tile building cap; smaller footprints allowed. Street labels anchored nearer sign height, distance-faded, less snap/jitter.
- **P pause:** Large on-screen **PAUSED** banner when the day-cycle clock is paused (plus HUD time cue).
- **Accel / audio:** Stick modes start in **1st** (was Neutral — felt like 0–2 km/h). Auto downshifts when crawling in a tall gear; slightly higher drive-force cap; clearer procedural load/RPM under throttle.
- Web build only (no Windows exe rebuild).

### v1.3.1a (package 1.3.2) — Gears, telemetry, map UX

- **Gears:** Auto (P/R/N/D with shift points, **G** cycles selector) or stick — sequential (**Q/E**) or H-pattern (**1–6**, **N**, **B**=reverse). Optional-lite clutch (**Shift**). Gear shown on HUD + speedo; RPM linked to gear × speed.
- **Audio:** Richer procedural Web Audio (RPM harmonics, load, per-engine / bus diesel·hybrid character). Optional sample layout documented under `public/audio-samples/` (not required).
- **Minimap:** Corner map; click to expand/collapse. Player + nearby roads.
- **Street signs:** OSM `name`/`ref` as floating world labels on major ways (capped, distance-faded).
- **Buildings:** Prefer `height` / `building:levels`; clearer window facades; enabled by default.
- **Day length:** ~**30 min** full cycle by default (was ~3 min); still pausable with **P**.
- **Telemetry:** Panel by speedometer — RPM, gear, engine, throttle/brake, fake boost (TDI/VR6), coolant.
- **Curbs:** Raised edge curb strips along paved roads (more visible).
- **Scale:** Lane/carriageway widths recalibrated (~3–3.5 m lanes) so the ~1.8 m Golf sits naturally.
- Web build only this release (Electron files kept; no Windows rebuild).

### v1.3.1 — Windows desktop (Electron)

- **Windows portable `.exe`** via Electron + electron-builder (loads the Vite `dist/` build locally — not a remote URL).
- Scripts: `electron:dev`, `electron:build` / `dist:win`. Browser `npm run build` / `npm run dev` unchanged.
- Vite `base: './'` so assets resolve under `file://` in Electron and still work for static hosting.

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

**Offline / fallback road QA:** append `?fallback=1` (e.g. `http://localhost:5173/?fallback=1`) to skip Overpass and drive the synthetic asphalt grid (lanes, curbs, names).

```bash
npm run build
npm run preview
```

## Windows desktop build

Download a ready-made **portable** executable from [GitHub Releases](https://github.com/nigelrmccoy-oss/nig-drives/releases) (asset like `NigDrives-*-portable.exe`). Latest gameplay features are in the web build (**v1.4.0**).

**Run:** double-click the `.exe` — no installer. Windows SmartScreen may warn on first run (unsigned build); choose *More info* → *Run anyway* if you trust the release.

### Rebuild the Windows `.exe`

```bash
npm install
npm run dist:win
# or: npm run electron:build
```

Artifact lands in `release/NigDrives-<version>-portable.exe`.

**From Linux** (this CI/box): wine is used by electron-builder for the win target:

```bash
# wine / wine64 should be on PATH
npm run dist:win
```

**Dev (Electron + Vite):** start Vite in one terminal (`npm run dev`), then:

```bash
npm run electron:dev
```

That loads `http://localhost:5173`. Production Electron always loads packaged `dist/index.html`.

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
| G | Cycle auto selector P→R→N→D |
| Q / E | Downshift / upshift (stick) |
| 1–6 | H-pattern gears |
| N | Neutral (stick) |
| B | Reverse gear (stick; R is weather) |
| Shift | Clutch (optional-lite) |
| F1 | All assists off / back on (single switches: HUD Assists button) |
| F2 | Telemetry+ overlay |

HUD buttons also switch weather and time of day. Click the **minimap** to expand/collapse.

## OSM vs Google

- Roads and buildings come from **OpenStreetMap** via the **Overpass API**.
- **Do not** use Google Maps/Earth road data.
- Attribution is on the HUD, start menu, and here.

© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Overpass API.

## Elevation / terrain

- **Source:** [AWS Open Data Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) in **Terrarium** PNG encoding (Mapzen/Joerd lineage).
- **URL pattern:** `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
- **Decode:** `(R * 256 + G + B / 256) - 32768` → meters.
- No API key. z14 for roads and the near terrain, z12 mid ring, z11 far ring (to ~8 km). Pixel-centre bilinear sampling; nothing is built from guessed heights — provisional tiles are re-heighted when the fine DEM arrives.
- Roads use smoothed, grade-capped profiles; the near terrain is carved to the road corridor. Sea level is drawn as water.
- Heights are relative to the spawn city’s elevation so the vehicle starts near y≈0.

## Weather & day/night

- **Presets (not live weather APIs):** clear/dry, rain, snow.
- Visuals: sky/fog/lights, rain or snow particles, wet/snowy road & ground tint.
- **Grip:** clear ≈ full mu; rain/snow reduce by **surface retention** (asphalt motorway holds better than dirt/grass). Off-asphalt also lowers grip. HUD shows surface + grip %.
- Day/night cycle (~**30 min** real time by default, configurable in code) with darker night lighting; T jumps phases, P pauses.

## Driving feel (sim-cade)

Inspired by **Forza Motorsport 4 / Gran Turismo 5** feel — not a full sim claim:

- Weight transfer on brake/accel
- Combined-slip tyre model per wheel (slip ratio and slip angle share a friction circle)
- Progressive understeer/oversteer at the limit; switchable ABS / TCS / ESC (F1 or the HUD Assists panel)
- Golf engines change torque band / weight / top speed; Bus diesel vs hybrid (regen); Tesla Model 3 dual-motor EV with regen; all use weather & surface grip
- Weather and surface meaningfully change grip

## Streaming architecture

1. Spawn sets a lat/lon **geo origin** (X east, Y up, Z south, meters — right-handed; fixed in v1.3.2, it used to be mirrored).
2. **~0.01° tiles** load in a 5×5 neighborhood; distant tiles unload.
3. Each tile: Terrarium DEM preload → Overpass highways + buildings → road ribbons + extruded footprints on elevation.
4. In-memory tile cache; Overpass calls rate-limited; Vite proxies `/api/overpass` (kumi), `/api/overpass-mailru`, optional `/api/overpass-de` if CORS/TLS fails.
5. Per-tile offline road grid if Overpass times out (~10s); spawn never waits on the full 5×5 ring.

## Start cities

San Francisco · Chicago · New York City · Toronto · **Kitchener–Waterloo**

## Project layout

```
src/game/
  Game.ts
  weather/Environment.ts
  map/{geo,OverpassClient,ElevationSampler,RoadBuilder,RoadSurface,BuildingBuilder,TileManager}.ts
  vehicles/{Vehicle,VehicleFactory,Transmission,EngineSound}.ts
  map/{RoadProfile,RoadIndex,Terrain}.ts
  visuals/{Textures,PostFX,Quality,TextureLibrary,TerrainMaterial,ShaderChunks}.ts
  camera/ChaseCamera.ts
  input/Input.ts
  ui/{HUD,StartMenu,Minimap}.ts
  map/StreetLabels.ts
  cities.ts
```

## Known limitations

- Arcade/sim-cade physics, not FM/GT fidelity.
- Visuals are Forza-**inspired**: CC0 photo textures on terrain/roads, but no satellite imagery, real car scans or landuse (parks, lakes) polygons yet.
- Building count capped per tile for performance; no full city collision.
- Overpass public instances can be slow, rate-limit, or TLS-fail (notably overpass-api.de on some clouds); v1.3.1e prefers kumi/mail.ru mirrors, then falls back to offline grids on true outages.
- Not all OSM ways have `surface=*`; missing tags infer asphalt (or dirt for tracks).
- Terrarium is a ~10 m bare-earth DEM — road grades are smoothed estimates, not surveyed pavement. Bridges are level between their ends (no arch); tunnels have no interior.
- Inland lakes aren't drawn (only sea level); Lake Ontario shoreline in Toronto shows as terrain.
- Local ENU projection is for regional driving, not continental precision.

## License note

Game code for this project. Map data © OpenStreetMap contributors (ODbL). Elevation © contributors to the AWS Terrain Tiles / Mapzen Terrarium dataset. Textures and HDRI: CC0 (Poly Haven, ambientCG) — see `public/textures/CREDITS.md`.
