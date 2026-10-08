/* UI wiring: state, controls, preview rendering and export. */
(function () {
  'use strict';

  const { color: C, generator: G, png: PNG, Renderer } = window.CS;
  const STORAGE_KEY = 'column-shader:v1';

  const DEFAULT_STATE = {
    seed: 1629,
    // layout
    panels: 2,
    coverage: 0.55,
    panelVariance: 0.7,
    flutesMin: 3,
    flutesMax: 3,
    fluteVariance: 0.35,
    symmetry: 0.85,
    skew: 0.12,
    edgeCrop: 0.2,
    // tone
    highlightMin: 0.92,
    highlightMax: 1.0,
    shadowMin: 0.0,
    shadowMax: 0.42,
    centerDepth: 0.8,
    profile: 1.8,
    peakWidth: 1.6,
    // edges
    edgeSoftness: 0.08,
    softnessVariance: 0.6,
    // colour
    background: 'oklch(0.665 0.185 33)',
    stops: [
      { pos: 0, color: 'oklch(0.44 0.195 27)' },
      { pos: 0.38, color: 'oklch(0.52 0.228 27.5)' },
      { pos: 1, color: 'oklch(0.625 0.215 31.5)' },
    ],
    mixMode: 'oklch',
    rampSmooth: 0.6,
    vibrance: 1,
    lightness: 0,
    // noise
    noiseSeed: 1,
    dispAmount: 0.15,
    dispScale: 3,
    dispStretch: 3,
    dispWarp: 0.6,
    dispOctaves: 4,
    grain: 0,
    grainSize: 2000,
    // export
    sizePreset: 'A3',
    orientation: 'landscape',
    dpi: 300,
    width: 4961,
    height: 3508,
    bitDepth: 16,
    colorSpace: 'p3',
  };

  const MIX_MODES = [
    ['oklch', 'OKLCH (vivid, hue-preserving)'],
    ['oklab', 'OKLab (perceptual)'],
    ['linear', 'Linear RGB (physical light)'],
    ['srgb', 'sRGB gamma (classic CSS)'],
  ];
  const MIX_INDEX = { oklch: 0, oklab: 1, linear: 2, srgb: 3 };
  const CSS_INTERP = { oklch: 'in oklch', oklab: 'in oklab', linear: 'in srgb-linear', srgb: 'in srgb' };

  // Sizes in millimetres (portrait); custom keeps the pixel values as typed.
  const SIZE_PRESETS = [
    ['A5', 'A5 · 148 × 210 mm', 148, 210],
    ['A4', 'A4 · 210 × 297 mm', 210, 297],
    ['A3', 'A3 · 297 × 420 mm', 297, 420],
    ['A2', 'A2 · 420 × 594 mm', 420, 594],
    ['A1', 'A1 · 594 × 841 mm', 594, 841],
    ['A0', 'A0 · 841 × 1189 mm', 841, 1189],
    ['30x40', '30 × 40 cm', 300, 400],
    ['50x70', '50 × 70 cm', 500, 700],
    ['70x100', '70 × 100 cm', 700, 1000],
    ['letter', 'US Letter · 8.5 × 11 in', 215.9, 279.4],
    ['tabloid', 'Tabloid · 11 × 17 in', 279.4, 431.8],
    ['custom', 'Custom (pixels)', 0, 0],
  ];

  // Control schema → generated UI. `fmt` formats the readout.
  const pct = (v) => Math.round(v * 100) + '%';
  const SECTIONS = [
    {
      title: 'Layout',
      controls: [
        { key: 'panels', label: 'Panels', min: 1, max: 16, step: 1 },
        { key: 'coverage', label: 'Coverage', min: 0.05, max: 1, step: 0.01, fmt: pct, hint: 'Share of the width covered by panels; the rest is background.' },
        { key: 'panelVariance', label: 'Size variance', min: 0, max: 1.5, step: 0.01 },
        { key: 'flutesMin', label: 'Columns min', min: 1, max: 16, step: 1 },
        { key: 'flutesMax', label: 'Columns max', min: 1, max: 16, step: 1 },
        { key: 'fluteVariance', label: 'Column variance', min: 0, max: 1.2, step: 0.01 },
        { key: 'symmetry', label: 'Symmetry', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Chance a panel is mirrored around its centre.' },
        { key: 'skew', label: 'Skew', min: 0, max: 0.5, step: 0.01 },
        { key: 'edgeCrop', label: 'Edge crop', min: 0, max: 0.5, step: 0.01, hint: 'How far panel edges cut into their outer columns.' },
      ],
    },
    {
      title: 'Shading',
      controls: [
        { key: 'highlightMin', label: 'Highlight min', min: 0, max: 1, step: 0.01 },
        { key: 'highlightMax', label: 'Highlight max', min: 0, max: 1, step: 0.01 },
        { key: 'shadowMin', label: 'Shadow min', min: 0, max: 1, step: 0.01 },
        { key: 'shadowMax', label: 'Shadow max', min: 0, max: 1, step: 0.01 },
        { key: 'centerDepth', label: 'Centre depth', min: 0, max: 1, step: 0.01, hint: 'Pull the deepest shadows to the middle of each panel.' },
        { key: 'profile', label: 'Roundness', min: 1, max: 4, step: 0.01, hint: '1 = sharp creases, higher = rounder columns.' },
        { key: 'peakWidth', label: 'Highlight width', min: 0.4, max: 4, step: 0.01, hint: 'Above 1: broad highlights, narrow shadows. Below 1: the reverse.' },
        { key: 'edgeSoftness', label: 'Edge softness', min: 0, max: 1, step: 0.005, fmt: (v) => v.toFixed(3) + '% w' },
        { key: 'softnessVariance', label: 'Softness variance', min: 0, max: 1.5, step: 0.01 },
      ],
    },
    {
      title: 'Colour',
      custom: 'colour',
      controls: [
        { key: 'mixMode', label: 'Blend space', type: 'select', options: MIX_MODES },
        { key: 'rampSmooth', label: 'Ramp smoothing', min: 0, max: 1, step: 0.01, fmt: pct },
        { key: 'vibrance', label: 'Vibrance', min: 0, max: 1.6, step: 0.01, fmt: (v) => '×' + v.toFixed(2), hint: 'Scales chroma; values above 1 push further into P3 (gamut mapped).' },
        { key: 'lightness', label: 'Lightness', min: -0.2, max: 0.2, step: 0.005, fmt: (v) => (v >= 0 ? '+' : '') + v.toFixed(3) },
      ],
    },
    {
      title: 'Noise',
      controls: [
        { key: 'noiseSeed', label: 'Noise seed', min: 1, max: 999, step: 1 },
        { key: 'dispAmount', label: 'Displacement', min: 0, max: 2, step: 0.005, fmt: (v) => v.toFixed(3) + '% w' },
        { key: 'dispScale', label: 'Scale', min: 0.2, max: 20, step: 0.1 },
        { key: 'dispStretch', label: 'Vertical stretch', min: 0.2, max: 12, step: 0.1 },
        { key: 'dispWarp', label: 'Horizontal variation', min: 0, max: 3, step: 0.01 },
        { key: 'dispOctaves', label: 'Detail', min: 1, max: 8, step: 1 },
        { key: 'grain', label: 'Grain', min: 0, max: 0.05, step: 0.001, fmt: (v) => v.toFixed(3) },
        { key: 'grainSize', label: 'Grain density', min: 200, max: 8000, step: 50, fmt: (v) => v + '/w' },
      ],
    },
  ];

  // ------------------------------------------------------------------ state --
  let state = loadState();

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }
  function normalise(s) {
    const out = Object.assign(clone(DEFAULT_STATE), s || {});
    if (!Array.isArray(out.stops) || out.stops.length < 1) out.stops = clone(DEFAULT_STATE.stops);
    out.stops = out.stops.slice(0, 8).map((st) => ({ pos: +st.pos || 0, color: C.parse(st.color) ? st.color : '#808080' }));
    if (!C.parse(out.background)) out.background = DEFAULT_STATE.background;
    return out;
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalise(JSON.parse(raw));
    } catch (e) {
      /* storage unavailable */
    }
    return clone(DEFAULT_STATE);
  }
  let saveTimer = 0;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        /* ignore */
      }
    }, 250);
  }

  // --------------------------------------------------------------- renderer --
  const canvas = document.getElementById('canvas');
  const stage = document.getElementById('stage');
  const errorBox = document.getElementById('error');
  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    errorBox.hidden = false;
    errorBox.textContent = e.message;
    throw e;
  }

  function lookFromState() {
    const stops = state.stops
      .map((s) => ({ pos: Math.min(1, Math.max(0, s.pos)), lab: C.parse(s.color) || [0.5, 0, 0] }))
      .sort((a, b) => a.pos - b.pos);
    const nr = G.rng(state.noiseSeed, 'noise');
    return {
      background: C.parse(state.background),
      stops,
      mixMode: MIX_INDEX[state.mixMode] ?? 0,
      rampSmooth: state.rampSmooth,
      profile: state.profile,
      peakWidth: state.peakWidth,
      vibrance: state.vibrance,
      lightness: state.lightness,
      dispAmount: state.dispAmount / 100,
      dispScale: state.dispScale,
      dispStretch: state.dispStretch,
      dispOctaves: Math.round(state.dispOctaves),
      dispWarp: state.dispWarp,
      noiseSeed: [nr.range(0, 400), nr.range(0, 400)],
      grain: state.grain,
      grainSize: state.grainSize,
    };
  }

  function layoutParams() {
    const p = {};
    for (const k of Object.keys(G.DEFAULT_PARAMS)) p[k] = state[k];
    return p;
  }

  let layoutDirty = true;
  let frame = 0;
  function requestRender(layoutChanged = true) {
    layoutDirty = layoutDirty || layoutChanged;
    persist();
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    if (layoutDirty) {
      renderer.setLayout(G.pack(G.generate(state.seed, layoutParams())));
      layoutDirty = false;
    }
    renderer.setLook(lookFromState());
    resizeCanvas();
    renderer.renderPreview();
  }

  function resizeCanvas() {
    const pad = 32;
    const availW = Math.max(50, stage.clientWidth - pad * 2);
    const availH = Math.max(50, stage.clientHeight - pad * 2);
    const aspect = state.width / state.height;
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cap = Math.min(renderer.maxSize, 4096);
    let bw = Math.round(w * dpr);
    let bh = Math.round(h * dpr);
    const k = Math.min(1, cap / Math.max(bw, bh));
    bw = Math.max(1, Math.round(bw * k));
    bh = Math.max(1, Math.round(bh * k));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
  }
  new ResizeObserver(() => requestRender(false)).observe(stage);

  // ---------------------------------------------------------------- controls --
  const controlsRoot = document.getElementById('controls');
  const bindings = []; // { key, sync() }

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function rangeControl(def) {
    const id = 'c-' + def.key;
    const fmt = def.fmt || ((v) => (def.step >= 1 ? String(Math.round(v)) : (+v).toFixed(2)));
    const input = el('input', { type: 'range', id, min: def.min, max: def.max, step: def.step });
    const out = el('output', { for: id });
    const sync = () => {
      input.value = state[def.key];
      out.textContent = fmt(+state[def.key]);
    };
    input.addEventListener('input', () => {
      state[def.key] = +input.value;
      out.textContent = fmt(+input.value);
      requestRender(def.layout !== false);
    });
    // double-click resets to default
    input.addEventListener('dblclick', () => {
      state[def.key] = DEFAULT_STATE[def.key];
      sync();
      requestRender();
    });
    bindings.push({ key: def.key, sync });
    const row = el('div', { class: 'row' }, el('label', { for: id, text: def.label }), input, out);
    if (def.hint) row.title = def.hint;
    return row;
  }

  function selectControl(def) {
    const id = 'c-' + def.key;
    const sel = el('select', { id });
    for (const [v, label] of def.options) sel.append(el('option', { value: v, text: label }));
    const sync = () => (sel.value = state[def.key]);
    sel.addEventListener('change', () => {
      state[def.key] = sel.value;
      requestRender(false);
      if (def.key === 'mixMode') updateRampBar();
    });
    bindings.push({ key: def.key, sync });
    return el('div', { class: 'row' }, el('label', { for: id, text: def.label }), sel);
  }

  // --- colour editors ------------------------------------------------------------
  /**
   * A colour row: swatch + text field (any CSS colour incl. oklch() and
   * color(display-p3 …)) and an expandable OKLCH editor with a native picker.
   */
  function colourEditor(get, set, extra) {
    const swatch = el('button', { type: 'button', class: 'swatch', title: 'Edit colour' });
    const text = el('input', { type: 'text', class: 'colour-text', spellcheck: 'false', autocomplete: 'off' });
    const badge = el('span', { class: 'badge', title: 'Outside sRGB: only reproducible on wide-gamut (P3) displays and outputs' });
    const lch = ['L', 'C', 'H'].map((n, i) => {
      const r = el('input', { type: 'range', min: 0, max: [1, 0.37, 360][i], step: [0.001, 0.001, 0.1][i] });
      const o = el('output');
      return { n, r, o };
    });
    const picker = el('input', { type: 'color', title: 'System colour picker (sRGB only)' });
    const p3note = el('span', { class: 'hint' });
    const editor = el(
      'div',
      { class: 'lch-editor', hidden: '' },
      ...lch.map(({ n, r, o }) => el('div', { class: 'row' }, el('label', { text: { L: 'Lightness', C: 'Chroma', H: 'Hue' }[n] }), r, o)),
      el('div', { class: 'row' }, el('label', { text: 'Picker' }), picker, p3note)
    );

    function refresh(skipText) {
      const str = get();
      const lab = C.parse(str);
      if (!lab) return;
      if (!skipText) text.value = str;
      text.classList.remove('invalid');
      swatch.style.background = C.toCss(lab);
      const p3Only = !C.inGamut(lab, 'srgb', 2e-3);
      const outP3 = !C.inGamut(lab, 'p3', 2e-3);
      badge.textContent = outP3 ? 'out of P3' : p3Only ? 'P3' : '';
      badge.className = 'badge' + (outP3 ? ' warn' : '');
      const [L, Cc, H] = C.oklabToOklch(lab);
      [L, Cc, H].forEach((v, i) => {
        if (document.activeElement !== lch[i].r) lch[i].r.value = v;
        lch[i].o.textContent = i === 2 ? v.toFixed(1) + '°' : v.toFixed(3);
      });
      picker.value = C.toHex(lab);
      p3note.textContent = p3Only ? 'Picker shows the nearest sRGB colour' : '';
    }
    text.addEventListener('input', () => {
      if (C.parse(text.value)) {
        set(text.value.trim());
        refresh(true);
      } else text.classList.add('invalid');
    });
    text.addEventListener('blur', () => refresh());
    lch.forEach(({ r }) =>
      r.addEventListener('input', () => {
        const [L, Cc, H] = lch.map((x) => +x.r.value);
        set(`oklch(${L.toFixed(4)} ${Cc.toFixed(4)} ${H.toFixed(2)})`);
        refresh();
      })
    );
    picker.addEventListener('input', () => {
      set(picker.value);
      refresh();
    });
    swatch.addEventListener('click', () => (editor.hidden = !editor.hidden));
    refresh();
    const root = el('div', { class: 'colour' }, el('div', { class: 'colour-line' }, swatch, text, badge, ...(extra || [])), editor);
    return { root, refresh };
  }

  let rampBar;
  function updateRampBar() {
    if (!rampBar) return;
    const stops = state.stops
      .map((s) => ({ pos: s.pos, lab: C.parse(s.color) }))
      .filter((s) => s.lab)
      .sort((a, b) => a.pos - b.pos);
    const list = stops.map((s) => `${C.toCss(s.lab)} ${(s.pos * 100).toFixed(2)}%`).join(', ');
    const fallback = stops.map((s) => `${C.toHex(s.lab)} ${(s.pos * 100).toFixed(2)}%`).join(', ');
    rampBar.style.background = `linear-gradient(to right, ${fallback})`;
    rampBar.style.background = `linear-gradient(${CSS_INTERP[state.mixMode]} to right, ${stops.length > 1 ? list : list + ', ' + list})`;
  }

  function buildColourSection(container) {
    const bg = colourEditor(
      () => state.background,
      (v) => {
        state.background = v;
        requestRender(false);
      }
    );
    container.append(el('h3', { text: 'Background' }), bg.root);

    rampBar = el('div', { class: 'ramp-bar', title: 'Colour ramp: left = shadows, right = highlights' });
    const list = el('div', { class: 'stops' });
    const addBtn = el('button', { type: 'button', text: '+ Add stop' });
    container.append(el('h3', { text: 'Column ramp (shadow → highlight)' }), rampBar, list, addBtn);

    function renderStops() {
      list.textContent = '';
      state.stops.forEach((stop, i) => {
        const pos = el('input', { type: 'number', class: 'stop-pos', min: 0, max: 1, step: 0.01, title: 'Stop position (0–1)' });
        pos.value = stop.pos;
        pos.addEventListener('input', () => {
          const v = parseFloat(pos.value);
          if (!isNaN(v)) {
            stop.pos = Math.min(1, Math.max(0, v));
            updateRampBar();
            requestRender(false);
          }
        });
        const rm = el('button', { type: 'button', class: 'icon', title: 'Remove stop', text: '×' });
        rm.disabled = state.stops.length <= 1;
        rm.addEventListener('click', () => {
          state.stops.splice(i, 1);
          renderStops();
          requestRender(false);
        });
        const ed = colourEditor(
          () => stop.color,
          (v) => {
            stop.color = v;
            updateRampBar();
            requestRender(false);
          },
          [pos, rm]
        );
        list.append(ed.root);
      });
      addBtn.disabled = state.stops.length >= 8;
      updateRampBar();
    }
    addBtn.addEventListener('click', () => {
      // insert midway in the widest gap, colour mixed in OKLab
      const s = state.stops.slice().sort((a, b) => a.pos - b.pos);
      let best = 0;
      let gap = -1;
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i + 1].pos - s[i].pos > gap) {
          gap = s[i + 1].pos - s[i].pos;
          best = i;
        }
      }
      let pos = 0.5;
      let lab = C.parse(s[0].color);
      if (s.length > 1) {
        const a = C.parse(s[best].color);
        const b = C.parse(s[best + 1].color);
        lab = a.map((v, k) => (v + b[k]) / 2);
        pos = (s[best].pos + s[best + 1].pos) / 2;
      }
      state.stops.push({ pos: +pos.toFixed(3), color: C.toOklchString(lab) });
      state.stops.sort((a, b) => a.pos - b.pos);
      renderStops();
      requestRender(false);
    });
    renderStops();
    return () => {
      bg.refresh();
      renderStops();
    };
  }

  let refreshColours = () => {};
  for (const section of SECTIONS) {
    const body = el('div', { class: 'group-body' });
    const det = el('details', { class: 'group', open: '' }, el('summary', { text: section.title }), body);
    if (section.custom === 'colour') refreshColours = buildColourSection(body);
    for (const def of section.controls) {
      const isLayout = def.key in G.DEFAULT_PARAMS;
      body.append(def.type === 'select' ? selectControl(def) : rangeControl(Object.assign({ layout: isLayout }, def)));
    }
    controlsRoot.append(det);
  }

  // ------------------------------------------------------------------- seed --
  const seedInput = document.getElementById('seed');
  function setSeed(v) {
    state.seed = Math.max(0, Math.floor(v)) || 0;
    seedInput.value = state.seed;
    requestRender();
  }
  seedInput.addEventListener('input', () => {
    const v = parseInt(seedInput.value, 10);
    if (!isNaN(v)) setSeed(v);
  });
  document.getElementById('seed-prev').addEventListener('click', () => setSeed(state.seed - 1));
  document.getElementById('seed-next').addEventListener('click', () => setSeed(state.seed + 1));
  document.getElementById('seed-random').addEventListener('click', () => setSeed(Math.floor(Math.random() * 1e6)));
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowLeft') setSeed(state.seed - 1);
    else if (e.key === 'ArrowRight') setSeed(state.seed + 1);
    else if (e.key === 'r' || e.key === 'R') setSeed(Math.floor(Math.random() * 1e6));
  });

  // ----------------------------------------------------------------- export --
  const ex = {
    preset: document.getElementById('ex-preset'),
    orient: document.getElementById('ex-orient'),
    dpi: document.getElementById('ex-dpi'),
    w: document.getElementById('ex-w'),
    h: document.getElementById('ex-h'),
    depth: document.getElementById('ex-depth'),
    space: document.getElementById('ex-space'),
    info: document.getElementById('ex-info'),
    btn: document.getElementById('btn-export'),
    cancel: document.getElementById('btn-cancel'),
    progress: document.getElementById('ex-progress'),
    status: document.getElementById('ex-status'),
  };
  for (const [v, label] of SIZE_PRESETS) ex.preset.append(el('option', { value: v, text: label }));

  function applyPreset() {
    const p = SIZE_PRESETS.find((x) => x[0] === state.sizePreset);
    if (!p || p[0] === 'custom') return;
    let wmm = p[2];
    let hmm = p[3];
    if (state.orientation === 'landscape') [wmm, hmm] = [hmm, wmm];
    state.width = Math.round((wmm / 25.4) * state.dpi);
    state.height = Math.round((hmm / 25.4) * state.dpi);
  }
  function syncExport() {
    ex.preset.value = state.sizePreset;
    ex.orient.value = state.orientation;
    ex.dpi.value = state.dpi;
    ex.w.value = state.width;
    ex.h.value = state.height;
    ex.depth.value = String(state.bitDepth);
    ex.space.value = state.colorSpace;
    const mp = (state.width * state.height) / 1e6;
    const wcm = (state.width / state.dpi) * 2.54;
    const hcm = (state.height / state.dpi) * 2.54;
    let info = `${state.width} × ${state.height} px · ${mp.toFixed(1)} MP · ${wcm.toFixed(1)} × ${hcm.toFixed(1)} cm at ${state.dpi} dpi`;
    if (mp > 150) info += ' — very large, may take a while and a lot of memory';
    ex.info.textContent = info;
  }
  ex.preset.addEventListener('change', () => {
    state.sizePreset = ex.preset.value;
    applyPreset();
    syncExport();
    requestRender(false);
  });
  ex.orient.addEventListener('change', () => {
    const prev = state.orientation;
    state.orientation = ex.orient.value;
    if (state.sizePreset === 'custom' && prev !== state.orientation) [state.width, state.height] = [state.height, state.width];
    applyPreset();
    syncExport();
    requestRender(false);
  });
  ex.dpi.addEventListener('change', () => {
    const v = parseInt(ex.dpi.value, 10);
    if (v > 0) state.dpi = v;
    applyPreset();
    syncExport();
    requestRender(false);
  });
  for (const [input, key] of [
    [ex.w, 'width'],
    [ex.h, 'height'],
  ]) {
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      if (v >= 16) {
        state[key] = v;
        state.sizePreset = 'custom';
      }
      syncExport();
      requestRender(false);
    });
  }
  ex.depth.addEventListener('change', () => {
    state.bitDepth = parseInt(ex.depth.value, 10);
    persist();
  });
  ex.space.addEventListener('change', () => {
    state.colorSpace = ex.space.value;
    persist();
  });

  let exportAbort = null;
  ex.cancel.addEventListener('click', () => exportAbort && exportAbort.abort());
  ex.btn.addEventListener('click', async () => {
    if (exportAbort) return;
    exportAbort = new AbortController();
    ex.btn.disabled = true;
    ex.cancel.hidden = false;
    ex.progress.hidden = false;
    ex.progress.value = 0;
    ex.status.textContent = 'Rendering…';
    const t0 = performance.now();
    try {
      const look = lookFromState();
      renderer.setLook(look);
      renderer.setLayout(G.pack(G.generate(state.seed, layoutParams())));
      let bitDepth = state.bitDepth;
      if (!renderer.floatExport && bitDepth === 16) {
        bitDepth = 8;
        ex.status.textContent = 'This GPU cannot render float targets; exporting 8-bit.';
      }
      const enc = await PNG.createEncoder({
        width: state.width,
        height: state.height,
        bitDepth,
        colorSpace: state.colorSpace,
        dpi: state.dpi,
        text: {
          Software: 'Column Shader',
          Title: `Columns seed ${state.seed}`,
          'column-shader': JSON.stringify(state),
        },
      });
      await renderer.renderTiled({
        width: state.width,
        height: state.height,
        bitDepth,
        colorSpace: state.colorSpace,
        signal: exportAbort.signal,
        onStrip: (bytes, rows) => enc.writeRows(bytes, rows),
        onProgress: (f) => (ex.progress.value = f * 0.97),
      });
      ex.status.textContent = 'Compressing…';
      const blob = await enc.finish();
      ex.progress.value = 1;
      const name = `columns-seed${state.seed}-${state.width}x${state.height}-${state.colorSpace}-${bitDepth}bit.png`;
      download(blob, name);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      ex.status.textContent = `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB, ${secs}s)`;
    } catch (e) {
      ex.status.textContent = e.name === 'AbortError' ? 'Export cancelled.' : 'Export failed: ' + e.message;
      if (e.name !== 'AbortError') console.error(e);
    } finally {
      exportAbort = null;
      ex.btn.disabled = false;
      ex.cancel.hidden = true;
      setTimeout(() => (ex.progress.hidden = true), 1500);
      layoutDirty = true;
      requestRender(false);
    }
  });

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ------------------------------------------------------ save / load / reset --
  const fileInput = document.getElementById('file-load');
  document.getElementById('btn-save').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    download(blob, `columns-seed${state.seed}.json`);
  });
  document.getElementById('btn-load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      setState(JSON.parse(await f.text()));
    } catch (e) {
      alert('Could not read settings: ' + e.message);
    }
    fileInput.value = '';
  });
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm('Reset all settings to defaults?')) setState(clone(DEFAULT_STATE));
  });

  function setState(s) {
    state = normalise(s);
    syncAll();
    requestRender();
  }
  function syncAll() {
    seedInput.value = state.seed;
    bindings.forEach((b) => b.sync());
    refreshColours();
    syncExport();
  }

  // -------------------------------------------------------------- environment --
  const env = [];
  env.push(renderer.p3Canvas ? 'Preview: Display P3 canvas' : 'Preview: sRGB canvas (browser has no P3 WebGL)');
  if (window.matchMedia) env.push(matchMedia('(color-gamut: p3)').matches ? 'P3 display detected' : 'sRGB display');
  if (!renderer.floatExport) env.push('8-bit export only (no float render targets)');
  document.getElementById('env-info').textContent = env.join(' · ');

  if (state.sizePreset !== 'custom') applyPreset();
  syncAll();
  requestRender();

  // handy for scripting / debugging from the console
  window.columnShader = {
    get state() {
      return state;
    },
    setState,
    renderer,
  };
})();
