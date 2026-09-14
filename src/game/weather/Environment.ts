import * as THREE from 'three';

export type WeatherPreset = 'clear' | 'rain' | 'snow';

export const WEATHER_LABELS: Record<WeatherPreset, string> = {
  clear: 'Clear / dry',
  rain: 'Rain',
  snow: 'Snow',
};

const WEATHER_ORDER: WeatherPreset[] = ['clear', 'rain', 'snow'];

/**
 * Full day cycle length in real seconds.
 * Default ~30 min (was 3 min — too fast). Configurable via Environment.dayLengthSec.
 */
export const DEFAULT_DAY_LENGTH_SEC = 30 * 60; // 30 minutes
export const DAY_LENGTH_OPTIONS_SEC = [20 * 60, 30 * 60, 40 * 60, 60 * 60] as const;

const PARTICLE_COUNT = 900;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 bottomColor;
varying vec3 vDir;
void main() {
  float h = vDir.y;
  vec3 col = mix(horizonColor, topColor, smoothstep(0.02, 0.62, h));
  col = mix(bottomColor, col, smoothstep(-0.22, 0.06, h));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Environment {
  weather: WeatherPreset = 'clear';
  /** 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
  timeOfDay = 0.35;
  timePaused = false;
  /** Real seconds for a full day/night cycle (default 30 min). */
  dayLengthSec = DEFAULT_DAY_LENGTH_SEC;

  private scene: THREE.Scene;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ambient: THREE.AmbientLight;
  private fill: THREE.DirectionalLight;
  private rain: THREE.Points;
  private snow: THREE.Points;
  private rainVel: Float32Array;
  private snowVel: Float32Array;
  private tmpColor = new THREE.Color();
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private onWeatherChange?: (w: WeatherPreset) => void;
  private _night = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    this.hemi = new THREE.HemisphereLight(0xb8d4ff, 0x3a4a32, 0.9);
    scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x4a5a6a, 0.18);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff3d8, 1.25);
    this.sun.position.set(60, 120, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.near = 8;
    this.sun.shadow.camera.far = 380;
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0xa8c4e8, 0.18);
    this.fill.position.set(-40, 30, -20);
    scene.add(this.fill);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a90d9) },
        horizonColor: { value: new THREE.Color(0xd4e4f2) },
        bottomColor: { value: new THREE.Color(0x6a7a58) },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 18), this.skyMat);
    this.sky.name = 'sky-dome';
    this.sky.frustumCulled = false;
    scene.add(this.sky);

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

  setDayLengthSec(sec: number): void {
    this.dayLengthSec = Math.max(60, sec);
  }

  cycleDayLength(): number {
    const opts = DAY_LENGTH_OPTIONS_SEC;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < opts.length; i++) {
      const d = Math.abs(this.dayLengthSec - opts[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    this.dayLengthSec = opts[(best + 1) % opts.length];
    return this.dayLengthSec;
  }

  getDayLengthMinutes(): number {
    return Math.round(this.dayLengthSec / 60);
  }

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

  /** 0 at noon, 1 at night — for headlights / bloom / window glow. */
  getNightFactor(): number {
    return this._night;
  }

  getEnvIntensity(): number {
    return 0.18 + (1 - this._night) * 0.42;
  }

  update(dt: number, followX: number, followZ: number, followY = 0): void {
    if (!this.timePaused) {
      const len = Math.max(60, this.dayLengthSec);
      this.timeOfDay = (this.timeOfDay + dt / len) % 1;
    }
    this.applyVisuals();

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
    this.fill.position.set(followX - 50, followY + 28, followZ - 30);

    this.sky.position.set(followX, followY, followZ);

    this.updateParticles(dt, followX, followZ, followY);
  }

  private applyVisuals(): void {
    const dayFactor = this.dayFactor();
    this._night = THREE.MathUtils.clamp(1 - dayFactor * 1.2, 0, 1);
    const night = this._night;

    const top = this.tmpColor.setRGB(
      0.06 + 0.22 * dayFactor,
      0.1 + 0.42 * dayFactor,
      0.18 + 0.62 * dayFactor,
    );
    if (this.weather === 'rain') top.multiplyScalar(0.7);
    if (this.weather === 'snow') top.lerp(new THREE.Color(0xb8c6d6), 0.35);
    if (night > 0.45) top.lerp(new THREE.Color(0x050814), (night - 0.45) * 1.6);

    const horizon = new THREE.Color().copy(top);
    if (dayFactor > 0.15 && dayFactor < 0.45) {
      // dawn / dusk warmth
      horizon.lerp(new THREE.Color(0xff8a4a), 0.35 * (1 - Math.abs(dayFactor - 0.3) * 4));
    } else {
      horizon.lerp(new THREE.Color(0xdce8f4), 0.45 * dayFactor);
    }
    if (this.weather === 'rain') horizon.multiplyScalar(0.75);
    if (this.weather === 'snow') horizon.lerp(new THREE.Color(0xd0dae6), 0.4);
    if (night > 0.5) horizon.lerp(new THREE.Color(0x101828), night);

    const bottom = new THREE.Color(this.weather === 'snow' ? 0xb8c4b8 : 0x4a5a3a);
    bottom.multiplyScalar(0.35 + 0.65 * dayFactor);

    (this.skyMat.uniforms.topColor.value as THREE.Color).copy(top);
    (this.skyMat.uniforms.horizonColor.value as THREE.Color).copy(horizon);
    (this.skyMat.uniforms.bottomColor.value as THREE.Color).copy(bottom);

    this.scene.background = top.clone();
    if (!this.scene.fog) {
      this.scene.fog = new THREE.Fog(horizon.getHex(), 160, 900);
    } else if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(horizon);
      this.scene.fog.near = this.weather === 'snow' ? 80 : this.weather === 'rain' ? 110 : 180;
      this.scene.fog.far = this.weather === 'snow' ? 500 : this.weather === 'rain' ? 620 : 980;
    }

    this.hemi.intensity = 0.22 + 0.72 * dayFactor;
    this.hemi.color.set(dayFactor > 0.28 ? 0xb8d4ff : 0x1a2448);
    this.hemi.groundColor.set(dayFactor > 0.28 ? 0x3a4a32 : 0x0a100c);

    this.sun.intensity = Math.max(0.04, dayFactor * (this.weather === 'clear' ? 1.35 : 0.72));
    this.sun.color.set(dayFactor > 0.38 ? 0xfff3d8 : dayFactor > 0.18 ? 0xffb070 : 0x8899cc);
    this.sun.castShadow = dayFactor > 0.12;
    this.ambient.intensity = 0.08 + night * 0.22 + (this.weather !== 'clear' ? 0.04 : 0);
    this.fill.intensity = 0.08 + 0.16 * dayFactor;

    this.rain.visible = this.weather === 'rain';
    this.snow.visible = this.weather === 'snow';
  }

  private dayFactor(): number {
    const t = this.timeOfDay;
    const elev = Math.sin((t - 0.25) * Math.PI * 2);
    return THREE.MathUtils.clamp(elev * 0.5 + 0.5, 0, 1);
  }

  private updateParticles(dt: number, x: number, z: number, groundY: number): void {
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

  getOwnedObjects(): THREE.Object3D[] {
    return [this.hemi, this.sun, this.sun.target, this.ambient, this.fill, this.sky, this.rain, this.snow];
  }

  dispose(): void {
    this.rain.geometry.dispose();
    (this.rain.material as THREE.Material).dispose();
    this.snow.geometry.dispose();
    (this.snow.material as THREE.Material).dispose();
    this.sky.geometry.dispose();
    this.skyMat.dispose();
  }
}
