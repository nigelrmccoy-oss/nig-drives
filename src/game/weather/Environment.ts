import * as THREE from 'three';

export type WeatherPreset = 'clear' | 'rain' | 'snow';

export const WEATHER_LABELS: Record<WeatherPreset, string> = {
  clear: 'Clear / dry',
  rain: 'Rain',
  snow: 'Snow',
};

const WEATHER_ORDER: WeatherPreset[] = ['clear', 'rain', 'snow'];

/** Full day cycle length in real seconds. */
const DAY_LENGTH_SEC = 180;

const PARTICLE_COUNT = 900;

export class Environment {
  weather: WeatherPreset = 'clear';
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
  timeOfDay = 0.35;
  timePaused = false;

  private scene: THREE.Scene;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private rain: THREE.Points;
  private snow: THREE.Points;
  private rainVel: Float32Array;
  private snowVel: Float32Array;
  private tmpColor = new THREE.Color();
  private onWeatherChange?: (w: WeatherPreset) => void;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.hemi = new THREE.HemisphereLight(0xb1d0ff, 0x3d5a3d, 0.85);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x405060, 0.15);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff2d6, 1.15);
    this.sun.position.set(60, 120, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    scene.add(this.sun);
    scene.add(this.sun.target);

    const rainGeo = new THREE.BufferGeometry();
    const rainPos = new Float32Array(PARTICLE_COUNT * 3);
    this.rainVel = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      rainPos[i * 3] = (Math.random() - 0.5) * 60;
      rainPos[i * 3 + 1] = Math.random() * 40;
      rainPos[i * 3 + 2] = (Math.random() - 0.5) * 60;
      this.rainVel[i] = 28 + Math.random() * 18;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rain = new THREE.Points(
      rainGeo,
      new THREE.PointsMaterial({
        color: 0xa8c8e8,
        size: 0.08,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    this.rain.visible = false;
    scene.add(this.rain);

    const snowGeo = new THREE.BufferGeometry();
    const snowPos = new Float32Array(PARTICLE_COUNT * 3);
    this.snowVel = new Float32Array(PARTICLE_COUNT);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      snowPos[i * 3] = (Math.random() - 0.5) * 70;
      snowPos[i * 3 + 1] = Math.random() * 35;
      snowPos[i * 3 + 2] = (Math.random() - 0.5) * 70;
      this.snowVel[i] = 4 + Math.random() * 5;
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    this.snow = new THREE.Points(
      snowGeo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.22,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    this.snow.visible = false;
    scene.add(this.snow);

    this.applyVisuals();
  }

  setWeatherChangeListener(fn: (w: WeatherPreset) => void): void {
    this.onWeatherChange = fn;
  }

  cycleWeather(): WeatherPreset {
    const i = WEATHER_ORDER.indexOf(this.weather);
    this.weather = WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length];
    this.applyVisuals();
    this.onWeatherChange?.(this.weather);
    return this.weather;
  }

  setWeather(w: WeatherPreset): void {
    this.weather = w;
    this.applyVisuals();
    this.onWeatherChange?.(this.weather);
  }

  /** Jump time: morning → noon → dusk → night → morning… */
  cycleTimePreset(): void {
    const presets = [0.28, 0.5, 0.72, 0.92];
    let best = 0;
    let bestDist = 1;
    for (let i = 0; i < presets.length; i++) {
      const d = Math.abs(this.timeOfDay - presets[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    this.timeOfDay = presets[(best + 1) % presets.length];
    this.applyVisuals();
  }

  toggleTimePause(): void {
    this.timePaused = !this.timePaused;
  }

  /**
   * Friction / drivability multipliers for the tire model.
   * clear: high grip; rain: reduced; snow: much reduced + weaker accel/brake.
   */
  getGripMultiplier(): number {
    switch (this.weather) {
      case 'clear':
        return 1.0;
      case 'rain':
        return 0.62;
      case 'snow':
        return 0.38;
    }
  }

  getAccelBrakeMultiplier(): number {
    switch (this.weather) {
      case 'clear':
        return 1.0;
      case 'rain':
        return 0.85;
      case 'snow':
        return 0.65;
    }
  }

  getTimeLabel(): string {
    if (this.timeOfDay < 0.2 || this.timeOfDay >= 0.85) return 'Night';
    if (this.timeOfDay < 0.35) return 'Dawn';
    if (this.timeOfDay < 0.65) return 'Day';
    if (this.timeOfDay < 0.8) return 'Dusk';
    return 'Night';
  }

  update(dt: number, followX: number, followZ: number, followY = 0): void {
    if (!this.timePaused) {
      this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH_SEC) % 1;
    }
    this.applyVisuals();

    // Sun orbits with time; stay roughly above the player
    const angle = this.timeOfDay * Math.PI * 2 - Math.PI / 2;
    const sunHeight = Math.sin(angle);
    const sunDist = 140;
    this.sun.position.set(
      followX + Math.cos(angle) * sunDist,
      Math.max(followY + 8, sunHeight * 120 + 20),
      followZ + Math.sin(angle) * 40,
    );
    this.sun.target.position.set(followX, followY, followZ);
    this.sun.target.updateMatrixWorld();

    this.updateParticles(dt, followX, followZ, followY);
  }

  private applyVisuals(): void {
    const dayFactor = this.dayFactor();
    const night = 1 - dayFactor;

    // Sky / fog by time + weather
    let sky = this.tmpColor.setRGB(
      0.15 + 0.4 * dayFactor,
      0.18 + 0.55 * dayFactor,
      0.28 + 0.65 * dayFactor,
    );
    if (this.weather === 'rain') {
      sky.multiplyScalar(0.72);
      sky.offsetHSL(0, -0.05, -0.05);
    } else if (this.weather === 'snow') {
      sky.offsetHSL(0, -0.15, 0.08);
      sky.lerp(new THREE.Color(0xb8c4d4), 0.35);
    }
    if (night > 0.5) {
      sky.lerp(new THREE.Color(0x050814), (night - 0.5) * 2 * 0.85);
    }
    this.scene.background = sky.clone();
    if (!this.scene.fog) {
      this.scene.fog = new THREE.Fog(sky.getHex(), 160, 850);
    } else if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(sky);
      this.scene.fog.near = this.weather === 'snow' ? 90 : this.weather === 'rain' ? 120 : 160;
      this.scene.fog.far = this.weather === 'snow' ? 520 : this.weather === 'rain' ? 650 : 900;
    }

    this.hemi.intensity = 0.25 + 0.7 * dayFactor;
    this.hemi.color.set(dayFactor > 0.3 ? 0xb1d0ff : 0x1a2040);
    this.hemi.groundColor.set(dayFactor > 0.3 ? 0x3d5a3d : 0x0a120a);

    this.sun.intensity = Math.max(0.05, dayFactor * (this.weather === 'clear' ? 1.2 : 0.7));
    this.sun.color.set(dayFactor > 0.4 ? 0xfff2d6 : 0x8899cc);
    this.ambient.intensity = 0.08 + night * 0.25 + (this.weather !== 'clear' ? 0.05 : 0);

    this.rain.visible = this.weather === 'rain';
    this.snow.visible = this.weather === 'snow';
  }

  /** 0 at night, 1 at noon-ish. */
  private dayFactor(): number {
    // Smooth bump around midday
    const t = this.timeOfDay;
    const elev = Math.sin((t - 0.25) * Math.PI * 2);
    return THREE.MathUtils.clamp(elev * 0.5 + 0.5, 0, 1);
  }

  private updateParticles(dt: number, x: number, z: number, groundY: number): void {
    // Particles live in local space with y=0 at groundY so they don't fall underground on hills
    if (this.rain.visible) {
      const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      this.rain.position.set(x, groundY, z);
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        let y = pos.getY(i) - this.rainVel[i] * dt;
        if (y < 0) {
          y = 25 + Math.random() * 20;
          pos.setX(i, (Math.random() - 0.5) * 60);
          pos.setZ(i, (Math.random() - 0.5) * 60);
        }
        pos.setY(i, y);
        // slight wind drift
        pos.setX(i, pos.getX(i) + dt * 2);
      }
      pos.needsUpdate = true;
    }

    if (this.snow.visible) {
      const pos = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
      this.snow.position.set(x, groundY, z);
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        let y = pos.getY(i) - this.snowVel[i] * dt;
        const wobble = Math.sin(y * 0.4 + i) * 3 * dt;
        if (y < 0) {
          y = 20 + Math.random() * 18;
          pos.setX(i, (Math.random() - 0.5) * 70);
          pos.setZ(i, (Math.random() - 0.5) * 70);
        }
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) + wobble);
      }
      pos.needsUpdate = true;
    }
  }

  /** Keep particles when clearing world (lights + particles are env-owned). */
  getOwnedObjects(): THREE.Object3D[] {
    return [this.hemi, this.sun, this.sun.target, this.ambient, this.rain, this.snow];
  }

  dispose(): void {
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
    this.snow.geometry.dispose();
    (this.snow.material as THREE.Material).dispose();
  }
}
