import * as THREE from 'three';
import { NIG_NOISE_GLSL } from './ShaderChunks';

/**
 * v1.3.3 shared building material (one per world → one draw call per tile).
 *
 * Per-vertex data (see BuildingBuilder):
 *   color      wall / roof tint (linear)
 *   uv         walls: (perimeter metres, metres above the lowest ground); roofs: metres
 *   aBldg      (facade layer, floor height m, bay width + fract seed, kind)
 *              kind 0 wall with windows · 1 flat roof · 2 pitched roof · 3 plain wall
 *   aWin       metres above ground where the window grid stops (parapet)
 *
 * Facade layers come from a texture array (CC0 photos, see CREDITS.md); the
 * window grid is procedural and anti-aliased (fades to an average when a
 * window is only a few pixels), glass reflects the sky env map, and a seeded
 * subset of windows glows at night.
 */
export const FACADE_LAYERS = [
  'brick_red',
  'brick_light',
  'concrete',
  'plaster',
  'siding',
  'metal',
  'glass',
  'roof_flat',
  'roof_pitched',
] as const;
export type FacadeLayer = (typeof FACADE_LAYERS)[number];
export const LAYER_INDEX: Record<FacadeLayer, number> = Object.fromEntries(
  FACADE_LAYERS.map((n, i) => [n, i]),
) as Record<FacadeLayer, number>;

export interface BuildingMaterialHandle {
  material: THREE.MeshStandardMaterial;
  setFacades(tex: THREE.DataArrayTexture | null): void;
  setNight(n: number): void;
}

export function createBuildingMaterial(): BuildingMaterialHandle {
  const uniforms = {
    uFac: { value: null as THREE.DataArrayTexture | null },
    uHasTex: { value: 0 },
    uNight: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
    envMapIntensity: 1.0,
    emissive: 0x000000,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  material.name = 'buildings';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aBldg;
attribute float aWin;
varying vec4 vBldg;
varying float vWin;
varying vec2 vBUv;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vBldg = aBldg;
vWin = aWin;
vBUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uFac;
uniform float uHasTex;
uniform float uNight;
varying vec4 vBldg;
varying float vWin;
varying vec2 vBUv;
${NIG_NOISE_GLSL}
vec3 nigFac(vec2 uv, float layer) {
  return uHasTex > 0.5 ? texture(uFac, vec3(uv, layer)).rgb : vec3(0.72);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `
float bLayer = floor(vBldg.x + 0.5);
float bFloor = max(vBldg.y, 2.4);
float bBay = max(floor(vBldg.z), 1.5);
float bSeed = fract(vBldg.z);
float bKind = floor(vBldg.w + 0.5);
float nigWin = 0.0;
float nigLit = 0.0;
float nigRough = 0.86;
vec3 bCol;
if (bKind == 1.0) {
  bCol = nigFac(vBUv / 4.0, 7.0);
  nigRough = 0.95;
} else if (bKind == 2.0) {
  bCol = nigFac(vBUv / 2.5, 8.0);
  nigRough = 0.8;
} else if (bLayer == 6.0) {
  // curtain wall: photo facade, one texture row per storey
  vec2 guv = vec2(vBUv.x, vBUv.y) / (bFloor * 8.0);
  bCol = nigFac(guv, 6.0);
  vec2 cellG = floor(vec2(vBUv.x / (bFloor * 0.8), vBUv.y / bFloor));
  nigWin = (vBUv.y > 0.3 && vBUv.y < vWin + 0.6) ? 0.85 : 0.0;
  nigLit = 0.55 * step(nigHash(cellG + bSeed * 61.0), 0.2);
  nigRough = 0.2;
} else {
  float tile = bLayer <= 1.0 ? 2.4 : (bLayer == 4.0 ? 2.0 : 3.0);
  bCol = nigFac(vBUv / tile, bLayer);
  if (bLayer == 5.0) bCol *= 0.86 + 0.14 * sin(vBUv.x * 31.4159); // corrugation
  if (bKind == 0.0 && vBUv.y > 0.0) {
    float fy = vBUv.y / bFloor;
    vec2 c = vec2(fract(vBUv.x / bBay), fract(fy));
    vec2 aa = max(fwidth(vec2(vBUv.x / bBay, fy)), vec2(1e-4));
    // ground floor of tall buildings: shop fronts
    float shop = (vBldg.y >= 3.6 && fy < 1.0) ? 1.0 : 0.0;
    vec2 lo = shop > 0.5 ? vec2(0.08, 0.08) : vec2(0.22, 0.3);
    vec2 hi = shop > 0.5 ? vec2(0.92, 0.82) : vec2(0.78, 0.84);
    vec2 w2 = smoothstep(lo, lo + aa * 1.5, c) * (1.0 - smoothstep(hi - aa * 1.5, hi, c));
    float w = w2.x * w2.y;
    // whole windows only: drop a storey whose window would poke into the parapet
    w *= step((floor(fy) + 0.85) * bFloor, vWin);
    // far away: average coverage instead of shimmering stripes
    float far = smoothstep(0.18, 0.45, max(aa.x, aa.y));
    w = mix(w, 0.32 * step(vBUv.y, vWin), far);
    nigWin = w;
    vec2 cell = vec2(floor(vBUv.x / bBay), floor(fy));
    nigLit = step(nigHash(cell + bSeed * 97.0), 0.32 + 0.1 * shop);
  }
  nigRough = bLayer == 5.0 ? 0.55 : 0.86;
}
// subtle per-building grime / weathering
bCol *= mix(0.9, 1.06, nigNoise(vBUv * 0.15 + bSeed * 40.0));
vec3 glass = vec3(0.07, 0.09, 0.12);
bCol = mix(bCol * vColor.rgb, glass, nigWin);
diffuseColor.rgb = bCol;
`,
      )
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(nigRough, 0.08, nigWin);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = mix(bLayer == 5.0 && bKind == 0.0 ? 0.35 : 0.0, 0.7, nigWin * (1.0 - nigLit * uNight));`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += nigWin * nigLit * uNight * vec3(1.0, 0.76, 0.46) * 1.6;`,
      );
  };
  material.customProgramCacheKey = () => 'nig-buildings-v1';
  return {
    material,
    setFacades(tex) {
      uniforms.uFac.value = tex;
      uniforms.uHasTex.value = tex ? 1 : 0;
    },
    setNight(n) {
      uniforms.uNight.value = Math.max(0, Math.min(1, n));
    },
  };
}
