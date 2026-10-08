/*
 * Seeded layout generator.
 *
 * The image is split horizontally into "panels" (groups of fluted columns)
 * separated by flat background gaps. Inside a panel every column ("flute")
 * is a smooth valley: a highlight at each column boundary and a shadow at
 * its core. The generator outputs, per panel, its extent, edge softness and a
 * list of knots (x, value). The shader eases between knots and maps the value
 * through the colour ramp.
 *
 * Every random decision draws from a sub-stream keyed by seed + purpose, so
 * tweaking one control (e.g. flute count) doesn't reshuffle unrelated parts
 * (e.g. where the panels sit).
 */
(function (root) {
  'use strict';

  // xmur3 string hash -> 32-bit seeds, sfc32 generator.
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function sfc32(a, b, c, d) {
    return function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      t = (t + d) | 0;
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
  }

  /** Random stream for `seed` + `key`, with a few helpers attached. */
  function rng(seed, key) {
    const h = xmur3(String(seed) + '::' + key);
    const next = sfc32(h(), h(), h(), h());
    for (let i = 0; i < 12; i++) next(); // warm up
    const r = () => next();
    r.range = (lo, hi) => lo + (hi - lo) * next();
    r.int = (lo, hi) => Math.floor(r.range(lo, hi + 1 - 1e-9));
    r.gauss = () => {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    };
    // log-normal weight: 1 on average-ish, spread controlled by `v`
    r.weight = (v) => Math.exp(v * r.gauss());
    return r;
  }

  const DEFAULT_PARAMS = {
    panels: 2,
    coverage: 0.55,
    panelVariance: 0.7,
    flutesMin: 3,
    flutesMax: 3,
    fluteVariance: 0.35,
    symmetry: 0.85,
    skew: 0.12,
    edgeCrop: 0.2,
    highlightMin: 0.92,
    highlightMax: 1.0,
    shadowMin: 0.0,
    shadowMax: 0.42,
    centerDepth: 0.8,
    edgeSoftness: 0.08, // % of image width
    softnessVariance: 0.6,
  };

  function generate(seed, p) {
    p = Object.assign({}, DEFAULT_PARAMS, p);
    const L = rng(seed, 'layout');
    const nPanels = Math.max(1, Math.round(p.panels));
    const coverage = Math.min(1, Math.max(0.02, p.coverage));

    // Panel and gap widths (gaps include the outer margins).
    const panelW = [];
    for (let i = 0; i < nPanels; i++) panelW.push(L.weight(p.panelVariance));
    const gapW = [];
    for (let i = 0; i <= nPanels; i++) gapW.push(L.weight(p.panelVariance) * (i === 0 || i === nPanels ? 0.8 : 1));
    const sumP = panelW.reduce((a, b) => a + b, 0);
    const sumG = gapW.reduce((a, b) => a + b, 0);
    const pw = panelW.map((w) => (w / sumP) * coverage);
    const gw = gapW.map((w) => (w / sumG) * (1 - coverage));

    // Edge softness per boundary (shared by both sides of a boundary).
    const S = rng(seed, 'softness');
    const soft = () => (p.edgeSoftness / 100) * S.weight(p.softnessVariance);

    const panels = [];
    let x = gw[0];
    for (let i = 0; i < nPanels; i++) {
      const x0 = x;
      const x1 = x + pw[i];
      x = x1 + gw[i + 1];
      panels.push(buildPanel(seed, i, x0, x1, p, soft(), soft()));
    }
    // Panels that touch (coverage = 100%) share their boundary softness.
    for (let i = 1; i < panels.length; i++) {
      if (Math.abs(panels[i].x0 - panels[i - 1].x1) < 1e-9) panels[i].sigmaL = panels[i - 1].sigmaR;
    }
    return { panels };
  }

  function buildPanel(seed, index, x0, x1, p, sigmaL, sigmaR) {
    const R = rng(seed, 'panel-' + index);
    const fMin = Math.max(1, Math.round(Math.min(p.flutesMin, p.flutesMax)));
    const fMax = Math.max(fMin, Math.round(Math.max(p.flutesMin, p.flutesMax)));
    const n = R.int(fMin, fMax);
    const symmetric = R() < p.symmetry;
    const shadowLo = Math.min(p.shadowMin, p.shadowMax);
    const shadowHi = Math.max(p.shadowMin, p.shadowMax);
    const hiLo = Math.min(p.highlightMin, p.highlightMax);
    const hiHi = Math.max(p.highlightMin, p.highlightMax);

    // Per-flute widths, shadow depth, and skew of the shadow inside the flute.
    const widths = [];
    const depths = [];
    const skews = [];
    const half = symmetric ? Math.ceil(n / 2) : n;
    for (let j = 0; j < half; j++) {
      widths.push(R.weight(p.fluteVariance));
      skews.push(R.range(-1, 1) * p.skew);
      // deeper shadows towards the centre of the panel
      const centre = n > 1 ? 1 - Math.abs(j - (n - 1) / 2) / ((n - 1) / 2) : 1;
      const base = R.range(shadowLo, shadowHi);
      depths.push(base + (shadowLo - base) * p.centerDepth * centre);
    }
    if (symmetric) {
      for (let j = half; j < n; j++) {
        const m = n - 1 - j;
        widths.push(widths[m]);
        depths.push(depths[m]);
        skews.push(-skews[m]);
      }
      if (n % 2 === 1) skews[(n - 1) / 2] = 0;
    }
    // Highlights at the n+1 flute boundaries.
    const highs = [];
    for (let j = 0; j <= n; j++) highs.push(R.range(hiLo, hiHi));
    if (symmetric) for (let j = 0; j <= n; j++) highs[n - j] = highs[j];

    // Lay flutes out in local units, then crop the outer flutes so the panel
    // edges cut into them (like a pane of reeded glass).
    const bounds = [0];
    for (let j = 0; j < n; j++) bounds.push(bounds[j] + widths[j]);
    const cropL = p.edgeCrop * R.range(0.6, 1);
    const cropR = symmetric ? cropL : p.edgeCrop * R.range(0.6, 1);
    const start = bounds[0] + widths[0] * cropL;
    const end = bounds[n] - widths[n - 1] * cropR;
    const scale = (x1 - x0) / Math.max(1e-9, end - start);
    const toX = (u) => x0 + (u - start) * scale;

    const knots = [];
    for (let j = 0; j < n; j++) {
      knots.push([toX(bounds[j]), highs[j]]);
      knots.push([toX(bounds[j] + widths[j] * (0.5 + skews[j] * 0.8)), depths[j]]);
    }
    knots.push([toX(bounds[n]), highs[n]]);

    return { x0, x1, sigmaL, sigmaR, knots, symmetric, flutes: n };
  }

  /** Pack layout for upload as float textures. */
  function pack(layout) {
    const panels = layout.panels;
    const totalKnots = panels.reduce((a, pnl) => a + pnl.knots.length, 0);
    const panelData = new Float32Array(Math.max(1, panels.length) * 2 * 4);
    const knotData = new Float32Array(Math.max(1, totalKnots) * 4);
    const w = Math.max(1, panels.length);
    let k = 0;
    panels.forEach((pnl, i) => {
      panelData.set([pnl.x0, pnl.x1, pnl.sigmaL, pnl.sigmaR], i * 4);
      panelData.set([k, pnl.knots.length, 0, 0], (w + i) * 4);
      for (const [kx, kv] of pnl.knots) {
        knotData.set([kx, kv, 0, 0], k * 4);
        k++;
      }
    });
    return { panelData, panelCount: panels.length, panelTexWidth: w, knotData, knotCount: Math.max(1, totalKnots) };
  }

  const api = { rng, generate, pack, DEFAULT_PARAMS };
  root.CS = root.CS || {};
  root.CS.generator = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
