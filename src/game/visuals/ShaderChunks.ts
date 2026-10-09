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
