/*
 * Colour maths: parsing CSS colours, OKLab / OKLCH, sRGB and Display P3,
 * gamut mapping. All colours are stored internally as OKLab triples [L, a, b].
 */
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // --- transfer functions (sRGB and Display P3 share the same curve) ---------
  function toLinear(c) {
    const a = Math.abs(c);
    const v = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
    return Math.sign(c) * v;
  }
  function fromLinear(c) {
    const a = Math.abs(c);
    const v = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
    return Math.sign(c) * v;
  }

  // --- matrices --------------------------------------------------------------
  const mul = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];

  // Linear sRGB <-> linear Display P3 (both D65).
  const SRGB_TO_P3 = [
    [0.8224619687, 0.1775380313, 0.0],
    [0.0331941989, 0.9668058011, 0.0],
    [0.0170826307, 0.0723974407, 0.9105199286],
  ];
  const P3_TO_SRGB = [
    [1.2249401763, -0.2249401763, 0.0],
    [-0.0420569547, 1.0420569547, 0.0],
    [-0.0196375546, -0.0786360456, 1.0982736002],
  ];

  function linearSrgbToOklab(c) {
    const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
    const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
    const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }
  function oklabToLinearSrgb(c) {
    const l = (c[0] + 0.3963377774 * c[1] + 0.2158037573 * c[2]) ** 3;
    const m = (c[0] - 0.1055613458 * c[1] - 0.0638541728 * c[2]) ** 3;
    const s = (c[0] - 0.0894841775 * c[1] - 1.291485548 * c[2]) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  function oklabToOklch(lab) {
    const C = Math.hypot(lab[1], lab[2]);
    let h = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
    if (h < 0) h += 360;
    return [lab[0], C, C < 1e-6 ? 0 : h];
  }
  function oklchToOklab(lch) {
    const h = (lch[2] * Math.PI) / 180;
    return [lch[0], lch[1] * Math.cos(h), lch[1] * Math.sin(h)];
  }

  const linearP3ToOklab = (p3) => linearSrgbToOklab(mul(P3_TO_SRGB, p3));
  const oklabToLinearP3 = (lab) => mul(SRGB_TO_P3, oklabToLinearSrgb(lab));

  function toLinearIn(lab, space) {
    return space === 'srgb' ? oklabToLinearSrgb(lab) : oklabToLinearP3(lab);
  }

  function inGamut(lab, space = 'p3', eps = 1e-4) {
    return toLinearIn(lab, space).every((v) => v >= -eps && v <= 1 + eps);
  }

  /** Reduce chroma (keeping lightness and hue) until the colour fits `space`. */
  function gamutMap(lab, space = 'p3') {
    if (inGamut(lab, space)) return lab.slice();
    const L = clamp(lab[0], 0, 1);
    if (L <= 0) return [0, 0, 0];
    if (L >= 1) return [1, 0, 0];
    const C = Math.hypot(lab[1], lab[2]);
    const ca = lab[1] / C;
    const cb = lab[2] / C;
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut([L, ca * mid, cb * mid], space)) lo = mid;
      else hi = mid;
    }
    return [L, ca * lo, cb * lo];
  }

  /** Encoded (gamma) RGB in [0,1] for the given space, gamut mapped. */
  function toEncoded(lab, space = 'p3') {
    return toLinearIn(gamutMap(lab, space), space).map((v) => clamp(fromLinear(v), 0, 1));
  }

  // --- parsing ---------------------------------------------------------------
  function parseNumber(tok, percentScale = 1) {
    if (tok == null) return NaN;
    tok = tok.trim();
    if (tok === 'none') return 0;
    if (tok.endsWith('%')) return (parseFloat(tok) / 100) * percentScale;
    if (tok.endsWith('deg')) return parseFloat(tok);
    if (tok.endsWith('turn')) return parseFloat(tok) * 360;
    if (tok.endsWith('rad')) return (parseFloat(tok) * 180) / Math.PI;
    return parseFloat(tok);
  }

  function fnArgs(str, name) {
    const re = new RegExp('^' + name + '\\s*\\((.*)\\)$', 'i');
    const m = str.match(re);
    if (!m) return null;
    // ignore alpha after "/" and allow commas or whitespace
    return m[1].split('/')[0].trim().split(/[\s,]+/).filter(Boolean);
  }

  /** Parse a CSS colour string into OKLab. Returns null when unrecognised. */
  function parse(input) {
    if (typeof input !== 'string') return null;
    const str = input.trim().toLowerCase();
    if (!str) return null;
    let args;

    if (str[0] === '#') {
      let hex = str.slice(1);
      if (!/^[0-9a-f]+$/.test(hex)) return null;
      if (hex.length === 3 || hex.length === 4) hex = hex.slice(0, 3).split('').map((c) => c + c).join('');
      else if (hex.length === 8) hex = hex.slice(0, 6);
      if (hex.length !== 6) return null;
      const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return linearSrgbToOklab(rgb.map(toLinear));
    }
    if ((args = fnArgs(str, 'rgba?'))) {
      const rgb = args.slice(0, 3).map((t) => parseNumber(t, 255) / 255);
      if (rgb.length < 3 || rgb.some(isNaN)) return null;
      return linearSrgbToOklab(rgb.map(toLinear));
    }
    if ((args = fnArgs(str, 'oklch'))) {
      const L = parseNumber(args[0], 1);
      const C = parseNumber(args[1], 0.4);
      const H = parseNumber(args[2], 360);
      if ([L, C, H].some(isNaN)) return null;
      return oklchToOklab([L, C, H]);
    }
    if ((args = fnArgs(str, 'oklab'))) {
      const v = [parseNumber(args[0], 1), parseNumber(args[1], 0.4), parseNumber(args[2], 0.4)];
      if (v.some(isNaN)) return null;
      return v;
    }
    if ((args = fnArgs(str, 'color'))) {
      const space = args[0];
      const v = args.slice(1, 4).map((t) => parseNumber(t, 1));
      if (v.length < 3 || v.some(isNaN)) return null;
      if (space === 'display-p3') return linearP3ToOklab(v.map(toLinear));
      if (space === 'srgb') return linearSrgbToOklab(v.map(toLinear));
      if (space === 'srgb-linear') return linearSrgbToOklab(v);
      return null;
    }
    return null;
  }

  // --- formatting --------------------------------------------------------------
  const r = (v, d) => {
    const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
    return s === '-0' || /^-0\.0+$/.test(s) ? s.slice(1) : s;
  };

  function toHex(lab) {
    return '#' + toEncoded(lab, 'srgb').map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  }
  function toOklchString(lab) {
    const [L, C, H] = oklabToOklch(lab);
    return `oklch(${r(L, 4)} ${r(C, 4)} ${r(H, 2)})`;
  }
  function toP3String(lab) {
    const v = toEncoded(lab, 'p3');
    return `color(display-p3 ${v.map((x) => r(x, 4)).join(' ')})`;
  }
  /** CSS for on-screen swatches: P3 mapped so the browser shows what we render. */
  function toCss(lab) {
    return toP3String(lab);
  }

  const api = {
    clamp,
    toLinear,
    fromLinear,
    SRGB_TO_P3,
    P3_TO_SRGB,
    linearSrgbToOklab,
    oklabToLinearSrgb,
    linearP3ToOklab,
    oklabToLinearP3,
    oklabToOklch,
    oklchToOklab,
    inGamut,
    gamutMap,
    toEncoded,
    parse,
    toHex,
    toOklchString,
    toP3String,
    toCss,
  };

  root.CS = root.CS || {};
  root.CS.color = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
