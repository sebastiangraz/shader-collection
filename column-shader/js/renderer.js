/*
 * WebGL2 renderer. The fragment shader evaluates the column layout per pixel
 * (resolution independent), mixes colours in OKLCH / OKLab, gamut maps into
 * Display P3 (or sRGB) and encodes. The same shader renders the on-screen
 * preview and the tiled high-resolution export.
 */
(function (root) {
  'use strict';

  const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2  u_resolution;   // full image size in px
uniform vec2  u_offset;       // tile offset in px (bottom-left origin)
uniform sampler2D u_panels;   // row 0: x0, x1, sigmaL, sigmaR | row 1: knotStart, knotCount
uniform sampler2D u_knots;    // x, value
uniform int   u_panelCount;

uniform vec3  u_background;   // OKLab
uniform int   u_stopCount;
uniform float u_stopPos[8];
uniform vec3  u_stopLab[8];
uniform float u_rampSmooth;   // 0 = linear segments, 1 = smooth spline through stops
uniform int   u_mixMode;      // 0 oklch, 1 oklab, 2 linear rgb, 3 gamma rgb
uniform float u_profile;      // flute curve shape
uniform float u_peakWidth;    // > 1 widens highlights and narrows shadows
uniform float u_vibrance;     // chroma multiplier
uniform float u_lightness;    // lightness offset

uniform float u_dispAmount;   // displacement, fraction of width
uniform float u_dispScale;
uniform float u_dispStretch;
uniform int   u_dispOctaves;
uniform float u_dispWarp;     // how much the displacement varies horizontally vs vertically
uniform vec2  u_noiseSeed;

uniform float u_grain;
uniform float u_grainSize;    // grain cells across the image width

uniform int   u_outSpace;     // 0 display-p3, 1 srgb
uniform float u_dither;       // 1 = add 8-bit dither (preview / 8-bit fallback)

out vec4 outColor;

// ---------------------------------------------------------------- colour --
vec3 oklabToLinearSrgb(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 linearSrgbToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = sign(l) * pow(abs(l), 1.0 / 3.0);
  m = sign(m) * pow(abs(m), 1.0 / 3.0);
  s = sign(s) * pow(abs(s), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
// column-major: linear sRGB -> linear Display P3
const mat3 SRGB_TO_P3 = mat3(
  0.8224619687, 0.0331941989, 0.0170826307,
  0.1775380313, 0.9668058011, 0.0723974407,
  0.0,          0.0,          0.9105199286);

float encodeTF(float c) {
  float a = abs(c);
  return sign(c) * (a <= 0.0031308 ? a * 12.92 : 1.055 * pow(a, 1.0 / 2.4) - 0.055);
}
float decodeTF(float c) {
  float a = abs(c);
  return sign(c) * (a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4));
}
vec3 encodeTF3(vec3 c) { return vec3(encodeTF(c.r), encodeTF(c.g), encodeTF(c.b)); }
vec3 decodeTF3(vec3 c) { return vec3(decodeTF(c.r), decodeTF(c.g), decodeTF(c.b)); }

// Colours are blended in a "mix space" stored in a vec4:
//   oklch: (L, C, cos h * w, sin h * w)  — hue averaged on the circle
//   oklab: (L, a, b, 0)
//   linear / gamma rgb: (r, g, b, 0)
vec4 toMix(vec3 lab) {
  if (u_mixMode == 0) {
    float C = length(lab.yz);
    float w = smoothstep(0.0, 0.02, C); // achromatic colours have no hue to pull on
    vec2 h = C > 1e-6 ? lab.yz / C : vec2(1.0, 0.0);
    return vec4(lab.x, C, h * w);
  }
  if (u_mixMode == 1) return vec4(lab, 0.0);
  vec3 rgb = oklabToLinearSrgb(lab);
  if (u_mixMode == 3) rgb = encodeTF3(rgb);
  return vec4(rgb, 0.0);
}
vec3 fromMix(vec4 m) {
  if (u_mixMode == 0) {
    float hl = length(m.zw);
    vec2 h = hl > 1e-6 ? m.zw / hl : vec2(1.0, 0.0);
    return vec3(m.x, max(m.y, 0.0) * h);
  }
  if (u_mixMode == 1) return m.xyz;
  vec3 rgb = m.xyz;
  if (u_mixMode == 3) rgb = decodeTF3(rgb);
  return linearSrgbToOklab(rgb);
}

vec4 stopMix(int i) { return toMix(u_stopLab[i]); }

// Colour ramp: piecewise linear in mix space, optionally blended toward a
// cubic Hermite spline through the stops to avoid visible kinks.
vec4 rampMix(float t) {
  int n = u_stopCount;
  if (n <= 1 || t <= u_stopPos[0]) return stopMix(0);
  if (t >= u_stopPos[n - 1]) return stopMix(n - 1);
  int i = 0;
  for (int k = 1; k < 8; k++) {
    if (k >= n) break;
    if (t <= u_stopPos[k]) { i = k - 1; break; }
  }
  float t0 = u_stopPos[i], t1 = u_stopPos[i + 1];
  float h = max(t1 - t0, 1e-6);
  float f = clamp((t - t0) / h, 0.0, 1.0);
  vec4 p0 = stopMix(i), p1 = stopMix(i + 1);
  vec4 lin = mix(p0, p1, f);
  if (u_rampSmooth <= 0.0) return lin;
  // finite-difference tangents (non-uniform Catmull-Rom); ends use the chord
  vec4 m0 = (p1 - p0) / h, m1 = m0;
  if (i > 0) {
    vec4 pm = stopMix(i - 1);
    m0 = (p1 - pm) / max(t1 - u_stopPos[i - 1], 1e-6);
  }
  if (i + 2 < n) {
    vec4 pp = stopMix(i + 2);
    m1 = (pp - p0) / max(u_stopPos[i + 2] - t0, 1e-6);
  }
  float f2 = f * f, f3 = f2 * f;
  vec4 herm = (2.0 * f3 - 3.0 * f2 + 1.0) * p0 + (f3 - 2.0 * f2 + f) * h * m0
            + (-2.0 * f3 + 3.0 * f2) * p1 + (f3 - f2) * h * m1;
  return mix(lin, herm, u_rampSmooth);
}

// ----------------------------------------------------------------- noise --
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// gradient noise, roughly in [-1, 1]
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(i) * 2.0 - 1.0;
  vec2 gb = hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return 1.6 * mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}
float fbm(vec2 p) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= u_dispOctaves) break;
    sum += amp * gnoise(p);
    norm += amp;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.13, 9.71);
    amp *= 0.5;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

// ---------------------------------------------------------------- layout --
float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
// A box [a, b] blurred by a Gaussian with different widths at each edge.
float softBox(float x, float a, float b, float sa, float sb) {
  return 0.5 * (erfApprox((x - a) / (sa * 1.41421356)) - erfApprox((x - b) / (sb * 1.41421356)));
}
// Ease between knots; u_profile = 1 gives V-shaped creases, higher rounds them.
float ease(float t) {
  float a = pow(t, u_profile);
  return a / (a + pow(1.0 - t, u_profile));
}
float panelSignal(int pi, float x) {
  vec4 meta = texelFetch(u_panels, ivec2(pi, 1), 0);
  int ks = int(meta.x + 0.5);
  int kc = int(meta.y + 0.5);
  vec2 prev = texelFetch(u_knots, ivec2(ks, 0), 0).xy;
  if (x <= prev.x) return prev.y;
  for (int k = 1; k < 256; k++) {
    if (k >= kc) break;
    vec2 cur = texelFetch(u_knots, ivec2(ks + k, 0), 0).xy;
    if (x <= cur.x) {
      float t = clamp((x - prev.x) / max(cur.x - prev.x, 1e-7), 0.0, 1.0);
      // linger near the higher knot so highlights get wider than shadows
      t = prev.y >= cur.y ? pow(t, u_peakWidth) : 1.0 - pow(1.0 - t, u_peakWidth);
      return mix(prev.y, cur.y, ease(t));
    }
    prev = cur;
  }
  return prev.y;
}

void main() {
  vec2 px = gl_FragCoord.xy + u_offset;
  // x in [0, 1] across the width; y uses the same unit so noise isn't stretched
  vec2 uv = vec2(px.x / u_resolution.x, px.y / u_resolution.x);
  float pixel = 1.0 / u_resolution.x;

  // --- subtle noise displacement of the columns -------------------------
  vec2 np = vec2(uv.x * u_dispScale * u_dispWarp, uv.y * u_dispScale / max(u_dispStretch, 0.01));
  float x = uv.x + u_dispAmount * fbm(np + u_noiseSeed);

  // --- accumulate panels over the background -------------------------------
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= u_panelCount) break;
    vec4 p = texelFetch(u_panels, ivec2(i, 0), 0);
    float sa = max(p.z, 0.5 * pixel);
    float sb = max(p.w, 0.5 * pixel);
    if (x < p.x - 5.0 * sa || x > p.y + 5.0 * sb) continue;
    float w = softBox(x, p.x, p.y, sa, sb);
    if (w <= 1e-5) continue;
    float v = panelSignal(i, clamp(x, p.x, p.y));
    acc += w * rampMix(v);
    wsum += w;
  }
  float bgw = max(1.0 - wsum, 0.0);
  acc += bgw * toMix(u_background);
  vec3 lab = fromMix(acc / max(wsum + bgw, 1e-6));

  // --- vibrance, lightness, grain ------------------------------------------------
  lab.yz *= u_vibrance;
  lab.x += u_lightness;
  if (u_grain > 0.0) {
    vec2 gp = px / u_resolution.x * u_grainSize;
    float g = valueNoise(gp) + valueNoise(gp * 2.03 + 31.7) - 1.0;
    lab.x += g * u_grain;
  }

  // --- gamut map (reduce chroma at constant L and hue) -----------------------------
  lab.x = clamp(lab.x, 0.0, 1.0);
  vec3 rgb = oklabToLinearSrgb(lab);
  if (u_outSpace == 0) rgb = SRGB_TO_P3 * rgb;
  if (any(lessThan(rgb, vec3(-1e-5))) || any(greaterThan(rgb, vec3(1.0 + 1e-5)))) {
    float C = length(lab.yz);
    vec2 h = C > 1e-7 ? lab.yz / C : vec2(0.0);
    float lo = 0.0, hi = C;
    for (int it = 0; it < 18; it++) {
      float mid = 0.5 * (lo + hi);
      vec3 t = oklabToLinearSrgb(vec3(lab.x, h * mid));
      if (u_outSpace == 0) t = SRGB_TO_P3 * t;
      if (all(greaterThanEqual(t, vec3(-1e-5))) && all(lessThanEqual(t, vec3(1.0 + 1e-5)))) lo = mid; else hi = mid;
    }
    rgb = oklabToLinearSrgb(vec3(lab.x, h * lo));
    if (u_outSpace == 0) rgb = SRGB_TO_P3 * rgb;
  }
  vec3 enc = encodeTF3(clamp(rgb, 0.0, 1.0));

  if (u_dither > 0.0) {
    // triangular-PDF dither, +/- 1 LSB at 8 bit
    float d = hash12(px + 0.37) + hash12(px.yx + 11.13) - 1.0;
    enc += d / 255.0;
  }
  outColor = vec4(enc, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile error:\n' + log);
    }
    return s;
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl;

      // Ask for a Display P3 drawing buffer so the preview shows P3 colours.
      this.p3Canvas = false;
      if ('drawingBufferColorSpace' in gl) {
        try {
          gl.drawingBufferColorSpace = 'display-p3';
          this.p3Canvas = gl.drawingBufferColorSpace === 'display-p3';
        } catch (e) {
          this.p3Canvas = false;
        }
      }
      this.floatExport = !!gl.getExtension('EXT_color_buffer_float');
      this.maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.bindAttribLocation(prog, 0, 'a_pos');
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error:\n' + gl.getProgramInfoLog(prog));
      this.prog = prog;

      this.uniforms = {};
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        const name = info.name.replace(/\[0\]$/, '');
        this.uniforms[name] = gl.getUniformLocation(prog, info.name);
      }

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.vao = vao;

      this.panelTex = this._dataTexture();
      this.knotTex = this._dataTexture();
    }

    _dataTexture() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    /** Upload a packed layout (see generator.pack). */
    setLayout(packed) {
      const gl = this.gl;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindTexture(gl.TEXTURE_2D, this.panelTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, packed.panelTexWidth, 2, 0, gl.RGBA, gl.FLOAT, packed.panelData);
      gl.bindTexture(gl.TEXTURE_2D, this.knotTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, packed.knotCount, 1, 0, gl.RGBA, gl.FLOAT, packed.knotData);
      this.panelCount = packed.panelCount;
    }

    /**
     * Set look uniforms.
     * look: { background:[L,a,b], stops:[{pos, lab}], mixMode, rampSmooth, profile, peakWidth, vibrance, lightness,
     *         dispAmount, dispScale, dispStretch, dispOctaves, dispWarp, noiseSeed:[x,y], grain, grainSize }
     */
    setLook(look) {
      this.look = look;
    }

    _applyUniforms(width, height, offsetX, offsetY, outSpace, dither) {
      const gl = this.gl;
      const u = this.uniforms;
      const L = this.look;
      gl.useProgram(this.prog);
      gl.uniform2f(u.u_resolution, width, height);
      gl.uniform2f(u.u_offset, offsetX, offsetY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.panelTex);
      gl.uniform1i(u.u_panels, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.knotTex);
      gl.uniform1i(u.u_knots, 1);
      gl.uniform1i(u.u_panelCount, this.panelCount || 0);

      gl.uniform3fv(u.u_background, L.background);
      const stops = L.stops.slice(0, 8);
      const pos = new Float32Array(8);
      const labs = new Float32Array(24);
      stops.forEach((s, i) => {
        pos[i] = s.pos;
        labs.set(s.lab, i * 3);
      });
      gl.uniform1i(u.u_stopCount, stops.length);
      gl.uniform1fv(u.u_stopPos, pos);
      gl.uniform3fv(u.u_stopLab, labs);
      gl.uniform1f(u.u_rampSmooth, L.rampSmooth);
      gl.uniform1i(u.u_mixMode, L.mixMode);
      gl.uniform1f(u.u_profile, L.profile);
      gl.uniform1f(u.u_peakWidth, L.peakWidth);
      gl.uniform1f(u.u_vibrance, L.vibrance);
      gl.uniform1f(u.u_lightness, L.lightness);
      gl.uniform1f(u.u_dispAmount, L.dispAmount);
      gl.uniform1f(u.u_dispScale, L.dispScale);
      gl.uniform1f(u.u_dispStretch, L.dispStretch);
      gl.uniform1i(u.u_dispOctaves, L.dispOctaves);
      gl.uniform1f(u.u_dispWarp, L.dispWarp);
      gl.uniform2fv(u.u_noiseSeed, L.noiseSeed);
      gl.uniform1f(u.u_grain, L.grain);
      gl.uniform1f(u.u_grainSize, L.grainSize);
      gl.uniform1i(u.u_outSpace, outSpace === 'srgb' ? 1 : 0);
      gl.uniform1f(u.u_dither, dither ? 1 : 0);
      gl.bindVertexArray(this.vao);
    }

    /** Draw the preview into the canvas (whose size the caller has set). */
    renderPreview() {
      const gl = this.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      this._applyUniforms(w, h, 0, 0, this.p3Canvas ? 'p3' : 'srgb', true);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /**
     * Render a width x height image in horizontal strips. For every strip calls
     * `onStrip(bytes, rowCount)` with packed, big-endian RGB rows (top to bottom).
     */
    async renderTiled({ width, height, bitDepth = 16, colorSpace = 'p3', onStrip, onProgress, signal }) {
      const gl = this.gl;
      const useFloat = this.floatExport;
      if (!useFloat && bitDepth === 16) bitDepth = 8;
      const tileW = Math.min(width, this.maxSize, 4096);
      const tileH = Math.min(height, this.maxSize, Math.max(64, Math.floor((1 << 21) / tileW)));

      const fbo = gl.createFramebuffer();
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, useFloat ? gl.RGBA32F : gl.RGBA8, tileW, tileH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteRenderbuffer(rb);
        throw new Error('Could not create the export framebuffer.');
      }

      const bpp = bitDepth === 16 ? 6 : 3;
      const readBuf = useFloat ? new Float32Array(tileW * tileH * 4) : new Uint8Array(tileW * tileH * 4);
      const strip = new Uint8Array(width * tileH * bpp);
      const stripView = new DataView(strip.buffer);
      const tilesX = Math.ceil(width / tileW);
      const totalTiles = tilesX * Math.ceil(height / tileH);
      let done = 0;

      try {
        for (let top = 0; top < height; top += tileH) {
          const rows = Math.min(tileH, height - top);
          // GL origin is bottom-left; this strip spans [height - top - rows, height - top).
          const offY = height - top - rows;
          for (let left = 0; left < width; left += tileW) {
            if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
            const cols = Math.min(tileW, width - left);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.viewport(0, 0, cols, rows);
            this._applyUniforms(width, height, left, offY, colorSpace, !useFloat);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.readPixels(0, 0, cols, rows, gl.RGBA, useFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, readBuf);

            for (let r = 0; r < rows; r++) {
              const srcRow = (rows - 1 - r) * cols * 4; // flip vertically
              let o = (r * width + left) * bpp;
              if (useFloat && bitDepth === 16) {
                for (let c = 0; c < cols; c++) {
                  const s = srcRow + c * 4;
                  for (let k = 0; k < 3; k++) {
                    const v = readBuf[s + k];
                    stripView.setUint16(o, v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));
                    o += 2;
                  }
                }
              } else if (useFloat) {
                // 8 bit from float: triangular dither before quantising
                for (let c = 0; c < cols; c++) {
                  const s = srcRow + c * 4;
                  for (let k = 0; k < 3; k++) {
                    const v = readBuf[s + k] * 255 + (Math.random() + Math.random() - 1);
                    strip[o++] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
                  }
                }
              } else {
                for (let c = 0; c < cols; c++) {
                  const s = srcRow + c * 4;
                  strip[o++] = readBuf[s];
                  strip[o++] = readBuf[s + 1];
                  strip[o++] = readBuf[s + 2];
                }
              }
            }
            done++;
            if (onProgress) onProgress(done / totalTiles);
          }
          await onStrip(strip.subarray(0, rows * width * bpp), rows);
          // let the UI breathe between strips
          await new Promise((res) => setTimeout(res, 0));
        }
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteRenderbuffer(rb);
      }
      return { bitDepth };
    }
  }

  root.CS = root.CS || {};
  root.CS.Renderer = Renderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
