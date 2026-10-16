import type { ArenaShape } from '../game/config';

export function shapeIndex(shape: ArenaShape) {
  return shape === 'square' ? 0 : shape === 'hex' ? 1 : 2;
}

/** GLSL signed distance to the arena boundary (positive inside), mirrors Arena.distanceToEdge. */
export const arenaGLSL = /* glsl */ `
uniform float uShape;
uniform float uSize;
float arenaDist(vec2 p) {
  if (uShape < 0.5) {
    vec2 a = abs(p);
    return uSize - max(a.x, a.y);
  } else if (uShape < 1.5) {
    vec2 a = abs(p);
    float ap = uSize * 0.8660254;
    return ap - max(dot(a, vec2(0.8660254, 0.5)), a.y);
  }
  return uSize - length(p);
}
`;

/** Cheap hash for shaders. */
export const hashGLSL = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
