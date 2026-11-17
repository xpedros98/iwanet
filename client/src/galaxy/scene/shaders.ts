// GLSL for the galaxy. ShaderMaterial (not RawShaderMaterial): three.js adds the
// standard matrices and the `position` attribute. These shaders skip three's
// tone-mapping and colour-space chunks on purpose: colours are written as-is,
// so every object in the scene looks the same regardless of renderer settings.

/**
 * Glowing points: user stars and the decorative background (two materials,
 * same program). Size shrinks with distance like a real object, but is
 * clamped in screen pixels: never invisible, and never a screen-filling glow
 * when the camera is close (that would cost fill rate, see the cost table).
 */
export const starVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aPhase;

  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uScale;     // CSS pixels per world unit at distance 1
  uniform float uBaseSize;  // world size of a star with aSize = 1
  uniform float uMinPx;     // clamp, CSS pixels
  uniform float uMaxPx;
  uniform float uPulse;     // 0 = steady, 1 = full pulse
  uniform float uFade;      // 0..1 fade-in

  varying vec3 vColor;
  varying float vBright;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float pulse = sin(uTime * 0.9 + aPhase) * uPulse;
    float px = aSize * uBaseSize * uScale / -mv.z * (1.0 + 0.06 * pulse);
    gl_PointSize = clamp(px, uMinPx, uMaxPx) * uPixelRatio;
    gl_Position = projectionMatrix * mv;
    vColor = aColor;
    vBright = (0.88 + 0.12 * pulse) * uFade;
  }
`;

// A white core inside a coloured glow. No discard: with additive blending a
// black pixel adds nothing, and discard can disable early depth optimisations
// on mobile GPUs. The glow reaches exactly 0 at the sprite's edge.
export const starFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vBright;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;   // 0 centre, 1 edge
    float edge = clamp(1.0 - r, 0.0, 1.0);
    float core = smoothstep(0.22, 0.0, r);
    float glow = exp(-r * r * 7.0) * edge;
    vec3 col = vColor * glow + vec3(core * 0.9);
    gl_FragColor = vec4(col * vBright, 1.0);
  }
`;

/** Friendship lines: the star positions and colours, drawn faint. */
export const lineVertex = /* glsl */ `
  attribute vec3 aColor;
  varying vec3 vColor;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vColor = aColor;
  }
`;

export const lineFragment = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor * uOpacity, 1.0);
  }
`;

/** Your-star marker: a thin ring of fixed screen size around your star. */
export const ringVertex = /* glsl */ `
  uniform float uPixelRatio;
  uniform float uPx;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uPx * uPixelRatio;
  }
`;

export const ringFragment = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float ring = smoothstep(0.70, 0.78, r) * smoothstep(0.94, 0.86, r);
    float a = ring * (0.65 + 0.2 * sin(uTime * 1.6)) * uFade;
    gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * a, 1.0);
  }
`;
