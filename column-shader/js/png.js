/*
 * Streaming PNG encoder (8 or 16 bit RGB) with an embedded ICC profile,
 * cICP colour tag, physical resolution (DPI) and text metadata.
 * Rows are compressed incrementally with CompressionStream so very large
 * print exports never need the whole raw image in memory.
 */
(function (root) {
  'use strict';

  // --- CRC32 -------------------------------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes, crc = 0xffffffff) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(ascii(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    return out;
  }

  async function zlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // --- ICC profile (v4, matrix/TRC display profile) -----------------------------
  const solve3 = (m) => {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
    ];
  };
  const mm = (A, B) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  const mv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
  const xyY = (x, y) => [x / y, 1, (1 - x - y) / y];

  /** RGB -> XYZ(D50) matrix for given primaries, Bradford-adapted from D65. */
  function rgbToXyzD50(prim) {
    const R = xyY(...prim.r), G = xyY(...prim.g), B = xyY(...prim.b), W = xyY(...prim.w);
    const M = [[R[0], G[0], B[0]], [R[1], G[1], B[1]], [R[2], G[2], B[2]]];
    const S = mv(solve3(M), W);
    const rgbToXyz = M.map((row) => row.map((v, i) => v * S[i]));
    const chad = bradford(W, D50);
    return { matrix: mm(chad, rgbToXyz), chad };
  }
  const D50 = [0.9642, 1.0, 0.8249];
  function bradford(src, dst) {
    const Mb = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
    const s = mv(Mb, src), d = mv(Mb, dst);
    const D = [[d[0] / s[0], 0, 0], [0, d[1] / s[1], 0], [0, 0, d[2] / s[2]]];
    return mm(mm(solve3(Mb), D), Mb);
  }

  const PRIMARIES = {
    p3: { name: 'Display P3', r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: [0.3127, 0.329] },
    srgb: { name: 'sRGB IEC61966-2.1', r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: [0.3127, 0.329] },
  };

  function buildIcc(space = 'p3') {
    const prim = PRIMARIES[space];
    const { matrix, chad } = rgbToXyzD50(prim);
    const s15 = (v) => Math.round(v * 65536) | 0;

    const mluc = (text) => {
      const b = new Uint8Array(28 + text.length * 2);
      const dv = new DataView(b.buffer);
      b.set(ascii('mluc'), 0);
      dv.setUint32(8, 1);
      dv.setUint32(12, 12);
      b.set(ascii('enUS'), 16);
      dv.setUint32(20, text.length * 2);
      dv.setUint32(24, 28);
      for (let i = 0; i < text.length; i++) dv.setUint16(28 + i * 2, text.charCodeAt(i));
      return b;
    };
    const xyz = (v) => {
      const b = new Uint8Array(20);
      const dv = new DataView(b.buffer);
      b.set(ascii('XYZ '), 0);
      v.forEach((x, i) => dv.setInt32(8 + i * 4, s15(x)));
      return b;
    };
    const para = () => {
      // sRGB transfer: Y = ((X + 0.055)/1.055)^2.4 for X >= 0.04045, else X/12.92
      const b = new Uint8Array(32);
      const dv = new DataView(b.buffer);
      b.set(ascii('para'), 0);
      dv.setUint16(8, 3);
      [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].forEach((x, i) => dv.setInt32(12 + i * 4, s15(x)));
      return b;
    };
    const sf32 = (m) => {
      const b = new Uint8Array(8 + 36);
      const dv = new DataView(b.buffer);
      b.set(ascii('sf32'), 0);
      m.flat().forEach((x, i) => dv.setInt32(8 + i * 4, s15(x)));
      return b;
    };
    const col = (i) => [matrix[0][i], matrix[1][i], matrix[2][i]];
    const trc = para();
    const tags = [
      ['desc', mluc(prim.name)],
      ['cprt', mluc('No copyright, use freely')],
      ['wtpt', xyz(D50)],
      ['rXYZ', xyz(col(0))],
      ['gXYZ', xyz(col(1))],
      ['bXYZ', xyz(col(2))],
      ['rTRC', trc],
      ['gTRC', trc],
      ['bTRC', trc],
      ['chad', sf32(chad)],
    ];

    const pad4 = (n) => (n + 3) & ~3;
    let offset = 128 + 4 + tags.length * 12;
    const placed = new Map();
    const entries = tags.map(([sig, data]) => {
      if (!placed.has(data)) {
        placed.set(data, offset);
        offset += pad4(data.length);
      }
      return [sig, placed.get(data), data.length];
    });
    const size = offset;
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, size);
    dv.setUint32(8, 0x04300000); // v4.3
    out.set(ascii('mntr'), 12);
    out.set(ascii('RGB '), 16);
    out.set(ascii('XYZ '), 20);
    const now = new Date();
    [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()].forEach(
      (v, i) => dv.setUint16(24 + i * 2, v)
    );
    out.set(ascii('acsp'), 36);
    dv.setUint32(64, 0); // perceptual
    D50.forEach((v, i) => dv.setInt32(68 + i * 4, s15(v)));
    dv.setUint32(128, tags.length);
    entries.forEach(([sig, off, len], i) => {
      out.set(ascii(sig), 132 + i * 12);
      dv.setUint32(136 + i * 12, off);
      dv.setUint32(140 + i * 12, len);
    });
    for (const [data, off] of placed) out.set(data, off);
    return out;
  }

  // --- PNG writer -------------------------------------------------------------------
  /**
   * Create a streaming encoder. Call `await enc.writeRows(bytes, rowCount)` with
   * packed big-endian RGB rows (top to bottom), then `await enc.finish()` -> Blob.
   */
  async function createEncoder({ width, height, bitDepth = 16, colorSpace = 'p3', dpi = 300, text = {} }) {
    const bpp = bitDepth === 16 ? 6 : 3;
    const rowBytes = width * bpp;
    const head = [];
    head.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width);
    hv.setUint32(4, height);
    ihdr[8] = bitDepth;
    ihdr[9] = 2; // truecolour RGB
    head.push(chunk('IHDR', ihdr));

    // cICP: primaries (1 = BT.709/sRGB, 12 = P3-D65), transfer 13 (sRGB), RGB, full range
    head.push(chunk('cICP', new Uint8Array([colorSpace === 'srgb' ? 1 : 12, 13, 0, 1])));

    const iccName = colorSpace === 'srgb' ? 'sRGB' : 'Display P3';
    const icc = await zlib(buildIcc(colorSpace));
    const iccp = new Uint8Array(iccName.length + 2 + icc.length);
    iccp.set(ascii(iccName), 0);
    iccp.set(icc, iccName.length + 2);
    head.push(chunk('iCCP', iccp));

    const ppm = Math.round(dpi / 0.0254);
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    pv.setUint32(0, ppm);
    pv.setUint32(4, ppm);
    phys[8] = 1;
    head.push(chunk('pHYs', phys));

    for (const [k, v] of Object.entries(text)) {
      const kb = ascii(k.slice(0, 79));
      const vb = ascii(String(v));
      const d = new Uint8Array(kb.length + 1 + vb.length);
      d.set(kb, 0);
      d.set(vb, kb.length + 1);
      head.push(chunk('tEXt', d));
    }

    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const idat = [];
    let pending = [];
    let pendingLen = 0;
    const flush = () => {
      if (!pendingLen) return;
      const buf = new Uint8Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        buf.set(p, o);
        o += p.length;
      }
      idat.push(chunk('IDAT', buf));
      pending = [];
      pendingLen = 0;
    };
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending.push(value);
        pendingLen += value.length;
        if (pendingLen >= 1 << 20) flush();
      }
      flush();
    })();

    let prevRow = new Uint8Array(rowBytes);
    let rowsWritten = 0;

    async function writeRows(bytes, rowCount) {
      // Filter type 2 ("Up") — columns change little vertically, so this packs well.
      const out = new Uint8Array(rowCount * (rowBytes + 1));
      for (let y = 0; y < rowCount; y++) {
        const src = bytes.subarray(y * rowBytes, (y + 1) * rowBytes);
        const o = y * (rowBytes + 1);
        out[o] = 2;
        for (let i = 0; i < rowBytes; i++) out[o + 1 + i] = (src[i] - prevRow[i]) & 0xff;
        prevRow = src;
      }
      prevRow = prevRow.slice();
      rowsWritten += rowCount;
      await writer.ready;
      await writer.write(out);
    }

    async function finish() {
      if (rowsWritten !== height) throw new Error(`PNG expected ${height} rows, got ${rowsWritten}`);
      await writer.close();
      await pump;
      return new Blob([...head, ...idat, chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
    }

    return { writeRows, finish, rowBytes };
  }

  const api = { crc32, buildIcc, createEncoder, rgbToXyzD50 };
  root.CS = root.CS || {};
  root.CS.png = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
