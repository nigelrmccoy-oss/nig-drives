import * as THREE from 'three';
import { ChaseCamera } from './camera/ChaseCamera';
import { getCityById } from './cities';
import { Input } from './input/Input';
import { TileManager } from './map/TileManager';
import { HUD } from './ui/HUD';
import { Minimap } from './ui/Minimap';
import { createVehicle } from './vehicles/VehicleFactory';
import { EngineSound } from './vehicles/EngineSound';
import type { Vehicle } from './vehicles/Vehicle';
import type { VehicleId } from './vehicles/Vehicle';
import type { TransmissionMode } from './vehicles/Transmission';
import { Environment, WEATHER_LABELS } from './weather/Environment';
import { PostFX } from './visuals/PostFX';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export interface GameStartOptions {
  vehicle: VehicleId;
  cityId: string;
  transmission?: TransmissionMode;
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
  constructor(parent: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    this.scene.fog = new THREE.Fog(0x87b5e5, 180, 980);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.35, 2800);
    this.chase = new ChaseCamera(this.camera);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment = this.pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.48;
    room.dispose();

    this.env = new Environment(this.scene);
    this.post = new PostFX(this.renderer, this.scene, this.camera);

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

  async start(opts: GameStartOptions): Promise<void> {
    this.stopLoop();
    this.clearWorld();
    const trans: TransmissionMode = opts.transmission ?? 'auto';
    this.engineSound.start(opts.vehicle);

    const city = getCityById(opts.cityId);
    this.cityName = city.name;
    this.region = city.region;

    this.loadingEl.classList.add('visible');
    const loadingText = this.loadingEl.querySelector('#loading-text')!;
    loadingText.textContent = `Loading ${city.name}: OSM roads + Terrarium elevation…`;

    this.tiles = new TileManager(this.scene, city.lat, city.lon);
    this.tiles.setWeatherSurface(this.env.weather);
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
    const heading = (city.headingDeg * Math.PI) / 180;
    if (snap && Number.isFinite(snap.x) && Number.isFinite(snap.z) && Number.isFinite(snap.y)) {
      this.vehicle.setPose(snap.x, snap.z, heading);
      this.vehicle.position.y = snap.y;
      this.vehicle.mesh.position.y = snap.y;
    } else {
      let y = this.tiles.getHeight(0, 0);
      if (!Number.isFinite(y)) y = 0;
      this.vehicle.setPose(0, 0, heading);
      this.vehicle.position.y = y;
      this.vehicle.mesh.position.y = y;
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
    const dt = Math.min(0.05, (t - this.lastT) / 1000);
    this.lastT = t;

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

    const surface = this.tiles.sampleSurface(this.vehicle.position.x, this.vehicle.position.z);
    let h = surface.height;
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
    this.vehicle.position.y = h;
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
    this.tiles.streetLabels.update(
      dt,
      lines,
      this.vehicle.position.x,
      this.vehicle.position.z,
      h,
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

    this.minimap.draw(lines, this.vehicle.position.x, this.vehicle.position.z, this.vehicle.heading);

    this.post.render();
    this.raf = requestAnimationFrame(this.frame);
  };

  private stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  dispose(): void {
    this.stopLoop();
    this.engineSound.dispose();
    this.minimap.dispose();
    this.input.dispose();
    this.env.dispose();
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }
}
