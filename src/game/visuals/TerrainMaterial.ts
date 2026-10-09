import * as THREE from 'three';

/**
 * Terrain ring material (v1.3.2).
 * P1: vertex-coloured MeshStandardMaterial plus a vertex-shader "hole" that
 * pushes an outer ring down inside the next-inner ring's footprint.
 */
export interface TerrainMaterialHandle {
  material: THREE.MeshStandardMaterial;
  /** (centerX, centerZ, halfSize, fadeCell) of the inner ring; w = 0 disables. */
  inner: THREE.Vector4;
}

export function createTerrainMaterial(opts: {
  map?: THREE.Texture;
  polygonOffsetFactor: number;
  name: string;
}): TerrainMaterialHandle {
  const inner = new THREE.Vector4(0, 0, 0, 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: opts.map ?? null,
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: opts.polygonOffsetFactor,
    polygonOffsetUnits: opts.polygonOffsetFactor,
  });
  material.name = opts.name;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uInner = { value: inner };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec4 uInner;`,
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
}`,
      );
  };
  material.customProgramCacheKey = () => 'nig-terrain-v1';
  return { material, inner };
}
