import * as THREE from 'three';
import type { QualitySettings } from './Quality';
import type { TerrainArrays } from './TextureLibrary';
import { NIG_NOISE_GLSL, WATER_RIPPLE_GLSL } from './ShaderChunks';

/**
 * Terrain ring material (v1.3.2).
 * - Vertex shader "hole": an outer ring drops inside the next-inner ring's footprint.
 * - P2 splat: grass / dirt / rock / snow from texture arrays, weights from slope,
 *   road verge, curvature and world-space macro noise; triplanar rock on steep
 *   faces; a second rotated large-scale sample per layer + macro tint so the
 *   tiling isn't visible at 100 m. Falls back to vertex colours until textures load.
 */
export type TerrainVariant = 'near' | 'far';

export interface TerrainMaterialHandle {
  material: THREE.MeshStandardMaterial;
  /** (centerX, centerZ, halfSize, fadeCell) of the inner ring; w = 0 disables. */
  inner: THREE.Vector4;
  setTextures(arrays: TerrainArrays | null, q: QualitySettings): void;
  /** snow 0..1 (snow cover on flats), wet 0..1 (darker, glossier). */
  setWeather(snow: number, wet: number): void;
  /** Seconds, drives water ripples. */
  setTime(t: number): void;
}

/** Metres per texture repeat: grass, dirt, rock, snow. */
const TILE_M = new THREE.Vector4(3.2, 3.0, 6.0, 4.0);

export function createTerrainMaterial(opts: {
  polygonOffsetFactor: number;
  name: string;
  variant: TerrainVariant;
}): TerrainMaterialHandle {
  const inner = new THREE.Vector4(0, 0, 0, 0);
  const uniforms = {
    uInner: { value: inner },
    uAlb: { value: null as THREE.DataArrayTexture | null },
    uNor: { value: null as THREE.DataArrayTexture | null },
    uArm: { value: null as THREE.DataArrayTexture | null },
    uTile: { value: TILE_M.clone() },
    uSnow: { value: 0 },
    uWet: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: opts.polygonOffsetFactor,
    polygonOffsetUnits: opts.polygonOffsetFactor,
  });
  material.name = opts.name;
  let key = 'nig-terrain-v2-vc';
  let active: Record<string, string> = {};
  const matDefs = material as unknown as { defines: Record<string, string> };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 uInner;
attribute vec4 aSplat;
attribute vec2 aLand;
varying vec3 vNigWPos;
varying vec3 vNigWNormal;
varying vec4 vNigSplat;
varying vec2 vNigLand;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
if (uInner.w > 0.0) {
  vec4 ringWp = modelMatrix * vec4(transformed, 1.0);
  vec2 dd = abs(ringWp.xz - uInner.xy);
  float edgeIn = min(uInner.z - dd.x, uInner.z - dd.y);
  float drop = clamp(edgeIn / uInner.w, 0.0, 1.0);
  transformed.y -= drop * (8.0 + max(edgeIn, 0.0) * 0.02);
}
vNigWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vNigWNormal = normalize(mat3(modelMatrix) * objectNormal);
vNigSplat = aSplat;
vNigLand = aLand;`,
      );

    if (!('NIG_SPLAT' in active)) return;

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2DArray uAlb;
uniform sampler2DArray uNor;
uniform sampler2DArray uArm;
uniform vec4 uTile;
uniform float uSnow;
uniform float uWet;
uniform float uTime;
varying vec3 vNigWPos;
varying vec3 vNigWNormal;
varying vec4 vNigSplat;
varying vec2 vNigLand;
${NIG_NOISE_GLSL}
${WATER_RIPPLE_GLSL}
vec2 nigRot(vec2 p) { return vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8); }
vec3 nigAlb(vec2 uv, float layer) {
#ifdef NIG_FAR
  return texture(uAlb, vec3(nigRot(uv) * 0.213 + 0.37, layer)).rgb;
#endif
  vec3 a = texture(uAlb, vec3(uv, layer)).rgb;
#ifdef NIG_ANTITILE
  vec3 b = texture(uAlb, vec3(nigRot(uv) * 0.213 + 0.37, layer)).rgb;
  a = mix(a, b, 0.42);
#endif
  return a;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `
vec3 nWp = vNigWPos;
vec3 nWn = normalize(vNigWNormal);
float nSlope = 1.0 - nWn.y;
float m1 = nigNoise(nWp.xz / 97.0);
float m2 = nigNoise(nWp.xz / 23.0 + 17.3);
float m3 = nigNoise(nWp.xz / 410.0 - 3.1);
float nMacro = m1 * 0.5 + m2 * 0.3 + m3 * 0.2;
// Layer weights (layered lerp: grass → dirt → rock → snow)
float wDirt = max(vNigSplat.x * 0.9, smoothstep(0.68, 0.86, m1 * 0.6 + m3 * 0.4) * 0.4);
wDirt = max(wDirt, smoothstep(0.12, 0.22, nSlope) * 0.45);
wDirt = clamp(wDirt + max(vNigSplat.y, 0.0) * 0.2 + (m2 - 0.5) * 0.2, 0.0, 1.0);
float wRock = smoothstep(0.22, 0.40, nSlope + (m2 - 0.5) * 0.10);
float wSnow = uSnow * smoothstep(0.42, 0.12, nSlope) * clamp(0.75 + m2 * 0.5, 0.0, 1.0);
vec2 uvG = vec2(nWp.x, -nWp.z) / uTile.x;
vec2 uvD = vec2(nWp.x, -nWp.z) / uTile.y;
vec2 uvR = vec2(nWp.x, -nWp.z) / uTile.z;
vec2 uvS = vec2(nWp.x, -nWp.z) / uTile.w;
vec3 cG = nigAlb(uvG, 0.0);
// sun-dried / lush variation across the landscape
cG = mix(cG, cG * vec3(1.12, 1.04, 0.8), smoothstep(0.45, 0.85, m3) * 0.35);
// v1.3.3 landuse from OSM: parks lusher, woods darker with litter, farmland in rows
float nForest = clamp(vNigSplat.w, 0.0, 1.0);
float nPark = clamp(vNigLand.x, 0.0, 1.0);
float nFarm = clamp(vNigLand.y, 0.0, 1.0);
cG = mix(cG, cG * vec3(0.9, 1.1, 0.8), nPark * 0.6);
cG = mix(cG, cG * vec3(0.6, 0.72, 0.52), nForest * 0.8);
float nRows = 0.5 + 0.5 * sin(dot(nWp.xz, vec2(0.6, 0.8)) * 1.7);
cG = mix(cG, cG * mix(vec3(1.2, 1.08, 0.7), vec3(0.98, 0.96, 0.72), nRows), nFarm * 0.7);
wDirt = max(wDirt, nForest * 0.4 * smoothstep(0.35, 0.7, m2));
vec3 cD = nigAlb(uvD, 1.0);
#ifdef NIG_TRIPLANAR
vec3 tpw = pow(abs(nWn), vec3(4.0));
tpw /= (tpw.x + tpw.y + tpw.z);
vec3 cR = texture(uAlb, vec3(vec2(nWp.x, -nWp.z) / uTile.z, 2.0)).rgb * tpw.y
        + texture(uAlb, vec3(vec2(-nWp.z, nWp.y) / uTile.z, 2.0)).rgb * tpw.x
        + texture(uAlb, vec3(vec2(nWp.x, nWp.y) / uTile.z, 2.0)).rgb * tpw.z;
#else
vec3 cR = nigAlb(uvR, 2.0);
#endif
vec3 nAlbedo = mix(cG, cD, wDirt);
nAlbedo = mix(nAlbedo, cR, wRock);
if (uSnow > 0.001) {
  vec3 cS = texture(uAlb, vec3(uvS, 3.0)).rgb;
  nAlbedo = mix(nAlbedo, cS, wSnow);
}
nAlbedo *= mix(0.80, 1.14, nMacro);
// hollows a touch darker (cheap AO from curvature)
nAlbedo *= 1.0 + min(vNigSplat.y, 0.0) * 0.18;
nAlbedo *= mix(1.0, 0.68, uWet * (1.0 - wSnow));
// v1.3.3 inland water (OSM lakes / rivers rasterised into the ring vertices)
float nWat = smoothstep(0.42, 0.56, vNigSplat.z);
float nShore = smoothstep(0.15, 0.45, vNigSplat.z) * (1.0 - nWat);
nAlbedo = mix(nAlbedo, nAlbedo * vec3(0.6, 0.58, 0.52), nShore);
nAlbedo = mix(nAlbedo, vec3(0.045, 0.085, 0.10), nWat);
diffuseColor.rgb *= nAlbedo;
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
#ifdef NIG_ARM
vec3 aG = texture(uArm, vec3(uvG, 0.0)).rgb;
vec3 aD = texture(uArm, vec3(uvD, 1.0)).rgb;
vec3 aR = texture(uArm, vec3(uvR, 2.0)).rgb;
vec3 nArm = mix(mix(aG, aD, wDirt), aR, wRock);
// photo roughness maps run glossy for a ground seen at grazing angles; keep it matte
roughnessFactor *= mix(0.82, 1.0, nArm.g);
diffuseColor.rgb *= mix(1.0, nArm.r, 0.6);
#else
roughnessFactor *= mix(mix(0.92, 0.97, wDirt), 0.82, wRock);
#endif
roughnessFactor = mix(roughnessFactor, 0.55, wSnow * 0.6);
roughnessFactor = mix(roughnessFactor, 0.32, uWet * 0.7);
roughnessFactor = mix(roughnessFactor, 0.45, nShore);
// far water: a bit rougher so the sub-pixel ripples don't alias into white frost
roughnessFactor = mix(roughnessFactor, mix(0.05, 0.2, smoothstep(120.0, 700.0, length(vViewPosition))), nWat);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `if (nWat > 0.001) {
  vec3 nWn3 = nigWaterNormal(nWp.xz, uTime, length(vViewPosition));
  normal = normalize(mix(normal, (viewMatrix * vec4(nWn3, 0.0)).xyz, nWat));
  // small ponds seen at grazing angles mirrored the white horizon (looked frozen):
  // lean the normal toward the viewer a little to tame the Fresnel term
  normal = normalize(normal + normalize(vViewPosition) * -0.45 * nWat);
}
#include <emissivemap_fragment>`,
      );

    if ('NIG_NORMALS' in active) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `{
  vec3 tG = texture(uNor, vec3(uvG, 0.0)).xyz * 2.0 - 1.0;
  vec3 tD = texture(uNor, vec3(uvD, 1.0)).xyz * 2.0 - 1.0;
  vec3 tR = texture(uNor, vec3(uvR, 2.0)).xyz * 2.0 - 1.0;
  vec3 tn = mix(mix(tG, tD, wDirt), tR, wRock);
  tn.xy *= mix(0.9, 1.4, wRock) * (1.0 - wSnow * 0.6);
  // Tangent frame for top-down uv = (x, -z): T = +X, B = -Z, N = +Y (Gram-Schmidt to the surface)
  vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - nWn * nWn.x);
  vec3 Bw = cross(nWn, Tw);
  vec3 nW = normalize(Tw * tn.x + Bw * tn.y + nWn * max(tn.z, 0.05));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
}`,
      );
    }
  };
  material.customProgramCacheKey = () => key;

  return {
    material,
    inner,
    setTextures(arrays, q) {
      const defs: Record<string, string> = {};
      if (arrays) {
        uniforms.uAlb.value = arrays.albedo;
        uniforms.uNor.value = arrays.normal;
        uniforms.uArm.value = arrays.arm;
        defs.NIG_SPLAT = '';
        if (opts.variant === 'near') {
          if (q.antiTile) defs.NIG_ANTITILE = '';
          if (q.triplanar) defs.NIG_TRIPLANAR = '';
          if (q.normals) defs.NIG_NORMALS = '';
          if (q.arm) defs.NIG_ARM = '';
        } else {
          // distant rings: one large-scale albedo sample per layer is plenty
          defs.NIG_FAR = '';
        }
      }
      active = defs;
      // keep three's own STANDARD define
      matDefs.defines = { ...(matDefs.defines ?? {}), ...defs };
      for (const k of Object.keys(matDefs.defines)) {
        if (k.startsWith('NIG_') && !(k in defs)) delete matDefs.defines[k];
      }
      material.vertexColors = !arrays;
      key = `nig-terrain-v2-${Object.keys(defs).sort().join('-') || 'vc'}`;
      material.needsUpdate = true;
    },
    setTime(t) {
      uniforms.uTime.value = t;
    },
    setWeather(snow, wet) {
      uniforms.uSnow.value = snow;
      uniforms.uWet.value = wet;
    },
  };
}
