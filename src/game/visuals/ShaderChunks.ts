/** Small GLSL helpers shared by the v1.3.2 terrain / road shaders. */
export const NIG_NOISE_GLSL = /* glsl */ `
float nigHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float nigNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = nigHash(i);
  float b = nigHash(i + vec2(1.0, 0.0));
  float c = nigHash(i + vec2(0.0, 1.0));
  float d = nigHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/**
 * v1.3.3 water ripples: analytic gradient of a few directional waves (no
 * textures), flattened with distance so far water doesn't shimmer.
 * Returns a world-space normal.
 */
export const WATER_RIPPLE_GLSL = /* glsl */ `
vec2 nigWave(vec2 p, vec2 d, float len, float steep, float t) {
  float k = 6.2831853 / len;
  float c = sqrt(9.81 / k);
  return d * steep * cos(dot(d, p) * k - t * c * k);
}
vec3 nigWaterNormal(vec2 p, float t, float dist) {
  vec2 g = nigWave(p, vec2(0.80, 0.60), 11.0, 0.035, t);
  g += nigWave(p, vec2(-0.39, 0.92), 6.3, 0.03, t);
  g += nigWave(p, vec2(0.97, -0.24), 3.7, 0.025, t);
  g += nigWave(p, vec2(-0.71, -0.70), 2.1, 0.02, t);
  g += nigWave(p, vec2(0.18, 0.98), 1.3, 0.015, t);
  g *= 1.0 / (1.0 + dist * 0.015);
  return normalize(vec3(-g.x, 1.0, -g.y));
}
`;
