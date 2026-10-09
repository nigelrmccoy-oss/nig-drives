import * as THREE from 'three';
import { ChaseCamera } from './camera/ChaseCamera';
import { CITIES, getCityById } from './cities';
import { Input } from './input/Input';
import { TileManager } from './map/TileManager';
import { HUD } from './ui/HUD';
import { Minimap } from './ui/Minimap';
import { createVehicle } from './vehicles/VehicleFactory';
import { EngineSound } from './vehicles/EngineSound';
import { Vehicle } from './vehicles/Vehicle';
import type { VehicleId } from './vehicles/Vehicle';
import type { TransmissionMode } from './vehicles/Transmission';
import { Environment, WEATHER_LABELS } from './weather/Environment';
import { PostFX } from './visuals/PostFX';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { QUALITY, loadQualityLevel, saveQualityLevel, type QualityLevel, type QualitySettings } from './visuals/Quality';
import { TextureLibrary } from './visuals/TextureLibrary';

export interface GameStartOptions {
  vehicle: VehicleId;
  cityId: string;
  transmission?: TransmissionMode;
  quality?: QualityLevel;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private chase: ChaseCamera;
  private input = new Input();
  private hud: HUD;
  private minimap: Minimap;
  private env: Environment;
  private loadingEl: HTMLElement;
  private vehicle: Vehicle | null = null;
  private tiles: TileManager | null = null;
  private engineSound = new EngineSound();
  private running = false;
  private lastT = 0;
  private cityName = '';
  private region = '';
  private raf = 0;
  private post: PostFX;
  private pmrem: THREE.PMREMGenerator;
  private lastGroundY = 0;
  private quality: QualitySettings;
  readonly textures: TextureLibrary;
  private fpsFrames = 0;
  private fpsAcc = 0;
  private fps = 0;
  constructor(parent: HTMLElement) {
    this.quality = QUALITY[loadQualityLevel()];
    // SMAA in PostFX does the anti-aliasing (the composer renders off-screen)
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.classList.add('game-canvas');
    parent.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87b5e5);
    this.scene.fog = new THREE.Fog(0x87b5e5, 350, 7000);

    // v1.3.2: far plane covers the ±8 km far terrain ring (near 0.4 keeps depth precision OK)
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.4, 12000);
    this.chase = new ChaseCamera(this.camera);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = this.pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.48;
    room.dispose();
    this.loadSkyHdri();

    this.env = new Environment(this.scene);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.textures = new TextureLibrary(this.quality);
    // Start fetching the CC0 photo textures while the menu is up
    void this.textures.load();
    this.applyQuality(this.quality);

    this.hud = new HUD(parent);
    this.minimap = new Minimap(parent);
    this.minimap.setVisible(false);
    this.hud.setEnvHandlers(
      () => this.cycleWeather(),
      () => this.cycleTime(),
    );

    this.loadingEl = document.createElement('div');
    this.loadingEl.id = 'loading-overlay';
    this.loadingEl.innerHTML = `<div class="spinner"></div><div id="loading-text">Loading OpenStreetMap roads…</div>`;
    parent.appendChild(this.loadingEl);

    window.addEventListener('resize', this.onResize);
  }

  /** Cheap Poly Haven sky (CC0) as image-based lighting; RoomEnvironment until it arrives. */
  private loadSkyHdri(): void {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? './';
    new HDRLoader().load(
      `${base.endsWith('/') ? base : base + '/'}hdri/sky_512.hdr`,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const env = this.pmrem.fromEquirectangular(tex).texture;
        const old = this.scene.environment;
        this.scene.environment = env;
        old?.dispose();
        tex.dispose();
      },
      undefined,
      (err) => console.warn('Sky HDRI unavailable — keeping RoomEnvironment', err),
    );
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  /** Pixel ratio, shadow map, bloom and texture sizes; near-ring resolution applies on next start. */
  applyQuality(q: QualitySettings): void {
    this.quality = q;
    const pr = Math.min(window.devicePixelRatio, q.pixelRatioCap);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.post.setSize(window.innerWidth, window.innerHeight, pr);
    this.post.setBloomEnabled(q.bloom);
    this.env.setShadowMapSize(q.shadowMapSize);
    this.textures?.setQuality(q);
  }

  async start(opts: GameStartOptions): Promise<void> {
    this.stopLoop();
    this.clearWorld();
    if (opts.quality && opts.quality !== this.quality.level) {
      saveQualityLevel(opts.quality);
      this.applyQuality(QUALITY[opts.quality]);
    }
    const trans: TransmissionMode = opts.transmission ?? 'auto';
    this.engineSound.start(opts.vehicle);

    const city = { ...getCityById(opts.cityId) };
    // QA: ?spawn=lat,lon[,headingDeg] overrides the city spawn point (play-tests, hill checks)
    const spawn = wantsSpawnOverride();
    if (spawn) {
      city.lat = spawn.lat;
      city.lon = spawn.lon;
      if (spawn.heading !== undefined) city.headingDeg = spawn.heading;
      // v1.3.3: HUD names the nearest known city to the override, not the menu pick
      const km = (c: { lat: number; lon: number }) =>
        Math.hypot(c.lat - spawn.lat, (c.lon - spawn.lon) * Math.cos((spawn.lat * Math.PI) / 180)) * 111.32;
      const near = [...CITIES].sort((a, b) => km(a) - km(b))[0];
      if (near && km(near) < 60) {
        city.name = near.name;
        city.region = near.region;
      } else {
        city.name = 'Custom spawn';
        city.region = `${spawn.lat.toFixed(3)}, ${spawn.lon.toFixed(3)}`;
      }
    }
    this.cityName = city.name;
    this.region = city.region;

    this.loadingEl.classList.add('visible');
    const loadingText = this.loadingEl.querySelector('#loading-text')!;
    loadingText.textContent = `Loading ${city.name}: OSM roads + Terrarium elevation…`;

    this.tiles = new TileManager(this.scene, city.lat, city.lon, this.textures, this.quality);
    this.tiles.setWeatherSurface(this.env.weather);
    if (wantsForcedFallback()) {
      this.tiles.setForceOffline(true);
      loadingText.textContent = 'Forced offline roads (?fallback=1)…';
    }
    this.tiles.setStatusListener((info) => {
      loadingText.textContent = info.message;
      this.hud.setStatus(info.message);
    });
    this.chase.setGroundSampler((x, z) => this.tiles!.getHeight(x, z));
    this.chase.reset();

    this.vehicle = createVehicle(opts.vehicle, trans);
    this.scene.add(this.vehicle.mesh);
    this.engineSound.setVehicle(opts.vehicle);

    try {
      await this.tiles.warmStart();
    } catch (err) {
      console.error(err);
      this.hud.setStatus('Map load issue — offline / partial tiles');
    }

    const snap = this.tiles.findNearestRoadPoint(0, 0);
    // cities.ts headings are compass bearings (0 = north, clockwise)
    const heading = Vehicle.compassToYaw((city.headingDeg * Math.PI) / 180);
    if (snap && Number.isFinite(snap.x) && Number.isFinite(snap.z) && Number.isFinite(snap.y)) {
      this.vehicle.setPose(snap.x, snap.z, heading);
      this.vehicle.position.y = snap.y;
      this.vehicle.mesh.position.y = snap.y;
      this.lastGroundY = snap.y;
    } else {
      let y = this.tiles.getHeight(0, 0);
      if (!Number.isFinite(y)) y = 0;
      this.vehicle.setPose(0, 0, heading);
      this.vehicle.position.y = y;
      this.vehicle.mesh.position.y = y;
      this.lastGroundY = y;
    }

    this.hud.setVehicleName(this.vehicle.spec.name);
    this.hud.setPlace(this.cityName, this.region);
    this.hud.setCameraMode('chase');
    this.hud.setWeather(this.env.weather);
    this.hud.setTime(this.env.getTimeLabel(), this.env.timePaused, this.env.getDayLengthMinutes());
    this.hud.show();
    this.minimap.setVisible(true);
    this.loadingEl.classList.remove('visible');

    this.running = true;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private cycleWeather(): void {
    const w = this.env.cycleWeather();
    this.tiles?.setWeatherSurface(w);
    this.hud.setWeather(w);
    this.hud.setStatus(
      `Weather: ${WEATHER_LABELS[w]} — base grip ${Math.round(this.env.getGripMultiplier() * 100)}% (surface modulates)`,
    );
  }

  private cycleTime(): void {
    this.env.cycleTimePreset();
    this.hud.setTime(this.env.getTimeLabel(), this.env.timePaused, this.env.getDayLengthMinutes());
  }

  private clearWorld(): void {
    this.chase.setGroundSampler(null);
    this.minimap.setVisible(false);
    if (this.vehicle) {
      this.scene.remove(this.vehicle.mesh);
      this.vehicle = null;
    }
    if (this.tiles) {
      const keep = new Set<THREE.Object3D>(this.env.getOwnedObjects());
      this.tiles.dispose();
      this.tiles = null;
      for (const child of [...this.scene.children]) {
        if (!keep.has(child)) {
          this.scene.remove(child);
          child.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
            }
            if (obj instanceof THREE.Points) {
              obj.geometry.dispose();
            }
          });
        }
      }
    }
  }

  private frame = (t: number): void => {
    if (!this.running || !this.vehicle || !this.tiles) return;
    const rawDt = Math.max(0, (t - this.lastT) / 1000);
    const dt = Math.min(0.05, rawDt);
    this.lastT = t;
    this.fpsFrames++;
    this.fpsAcc += rawDt;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsFrames = 0;
      this.fpsAcc = 0;
      this.hud.setFps(this.fps, this.quality.label);
    }

    if (this.input.consumeCameraToggle()) {
      this.chase.toggle();
      this.hud.setCameraMode(this.chase.mode);
    }
    if (this.input.consumeWeatherCycle()) this.cycleWeather();
    if (this.input.consumeTimeCycle()) this.cycleTime();
    if (this.input.consumeTimePause()) {
      this.env.toggleTimePause();
      this.hud.setTime(this.env.getTimeLabel(), this.env.timePaused, this.env.getDayLengthMinutes());
    }

    const v = this.vehicle;
    const surface = this.tiles.sampleSurface(v.position.x, v.position.z, v.position.y);
    // v1.3.2: ground under the four wheels → body pitch/roll + gravity along the grade
    const contact = this.sampleWheelContacts(v, surface.height, dt);
    let h = contact.bodyY;
    if (!Number.isFinite(h)) h = 0;
    this.vehicle.update(
      dt,
      this.input,
      {
        weather: this.env.weather,
        gripMul: this.env.getGripMultiplier(),
        accelBrakeMul: this.env.getAccelBrakeMultiplier(),
      },
      {
        roadFactor: surface.roadFactor,
        grip: surface.grip,
        noise: surface.noise,
      },
    );
    h = this.applyVertical(v, h, dt);
    this.vehicle.mesh.position.y = h;

    if (
      !Number.isFinite(this.vehicle.position.x) ||
      !Number.isFinite(this.vehicle.position.z) ||
      !Number.isFinite(this.vehicle.heading)
    ) {
      this.vehicle.setPose(0, 0, 0);
      this.vehicle.position.y = this.tiles.getHeight(0, 0) || 0;
      this.hud.setStatus('Recovered from invalid vehicle state');
    }

    this.tiles.update(this.vehicle.position.x, this.vehicle.position.z);
    const lines = this.tiles.getCenterlines();
    const camFwdX = Math.sin(this.vehicle.heading);
    const camFwdZ = Math.cos(this.vehicle.heading);
    this.tiles.streetLabels.update(
      dt,
      lines,
      this.vehicle.position.x,
      this.vehicle.position.z,
      h,
      {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
        fx: camFwdX,
        fz: camFwdZ,
      },
    );
    this.env.update(dt, this.vehicle.position.x, this.vehicle.position.z, h);
    const night = this.env.getNightFactor();
    this.vehicle.updateVisuals(dt, night);
    this.scene.environmentIntensity = this.env.getEnvIntensity();
    this.post.setNight(night);
    this.tiles.setNightGlow(night);
    this.chase.update(dt, this.vehicle);
    this.engineSound.update(this.vehicle);

    this.hud.setSpeed(this.vehicle.getSpeedKmh());
    this.hud.setAssists(this.vehicle.getAssistFlags());
    this.hud.setSurface(surface.label, surface.grip);
    this.hud.setTime(this.env.getTimeLabel(), this.env.timePaused, this.env.getDayLengthMinutes());
    const showBoost =
      this.vehicle.spec.id.includes('tdi') || this.vehicle.spec.id.includes('vr6');
    this.hud.setTelemetry({
      rpm: this.vehicle.getEngineRpmDisplay(),
      rpmNorm: this.vehicle.getEngineRpmNorm(),
      gear: this.vehicle.getGearLabel(),
      engineName: this.vehicle.spec.variantLabel,
      throttle: this.vehicle.throttleInput,
      brake: this.vehicle.brakeInput,
      boost: this.vehicle.boost,
      coolant: this.vehicle.coolant,
      showBoost,
    });

    this.minimap.draw(lines, this.vehicle.position.x, this.vehicle.position.z, this.vehicle.getCompassHeading());

    this.post.render();
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Heights under the 4 wheel contacts (road-aware), feeding pitch/roll/grade. */
  private sampleWheelContacts(v: Vehicle, centerY: number, dt: number): { bodyY: number } {
    const tiles = this.tiles!;
    const yaw = v.heading;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const lx = Math.cos(yaw); // model +X (left side) in world
    const lz = -Math.sin(yaw);
    const hb = v.spec.wheelbase * 0.5;
    const ht = v.spec.track * 0.5;
    const px = v.position.x;
    const pz = v.position.z;
    const prefer = v.position.y;
    const h = (ox: number, oz: number) => {
      const y = tiles.sampleSurface(px + ox, pz + oz, prefer).height;
      return Number.isFinite(y) ? y : centerY;
    };
    const hF = h(fx * hb, fz * hb);
    const hR = h(-fx * hb, -fz * hb);
    const hL = h(lx * ht, lz * ht);
    const hRt = h(-lx * ht, -lz * ht);
    const dy = hF - hR;
    const pitch = -Math.atan2(dy, hb * 2);
    const roll = Math.atan2(hL - hRt, ht * 2);
    const gradeSin = dy / Math.hypot(hb * 2, dy);
    v.setGroundContact(pitch, roll, gradeSin, dt);
    const body = centerY * 0.5 + (hF + hR + hL + hRt) * 0.125;
    return { bodyY: Number.isFinite(body) ? body : centerY };
  }

  /** Light vertical model: stick to the ground going up, fly briefly off crests. */
  private applyVertical(v: Vehicle, target: number, dt: number): number {
    let y = v.position.y;
    if (!Number.isFinite(y) || Math.abs(y - target) > 6) {
      v.vy = 0;
      v.position.y = target;
      return target;
    }
    const groundVel = (target - this.lastGroundY) / Math.max(dt, 1e-3);
    this.lastGroundY = target;
    if (y <= target + 0.002) {
      y = target;
      v.vy = THREE.MathUtils.clamp(groundVel, -8, 5);
    } else {
      v.vy -= 9.81 * dt;
      y += v.vy * dt;
      if (y <= target) {
        y = target;
        v.vy = THREE.MathUtils.clamp(groundVel, -8, 5);
      }
    }
    v.position.y = y;
    return y;
  }

  private stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.post.setSize(window.innerWidth, window.innerHeight, this.renderer.getPixelRatio());
  };

  dispose(): void {
    this.stopLoop();
    this.engineSound.dispose();
    this.minimap.dispose();
    this.input.dispose();
    this.env.dispose();
    window.removeEventListener('resize', this.onResize);
    this.textures.dispose();
    this.renderer.dispose();
  }

  /** Last measured frame rate (QA). */
  getFps(): number {
    return this.fps;
  }
}

/** QA / offline: ?fallback=1 or ?offline=1 forces synthetic road grids (no Overpass). */
function wantsForcedFallback(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    const v = (q.get('fallback') ?? q.get('offline') ?? '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

/** QA: ?spawn=lat,lon[,headingDeg] */
function wantsSpawnOverride(): { lat: number; lon: number; heading?: number } | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('spawn');
    if (!raw) return null;
    const [lat, lon, h] = raw.split(',').map((v) => parseFloat(v));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
    return { lat, lon, heading: Number.isFinite(h) ? h : undefined };
  } catch {
    return null;
  }
}
