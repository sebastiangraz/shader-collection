// Run with: npm test (or node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const C = require('../js/color.js');
const G = require('../js/generator.js');
const PNG = require('../js/png.js');

test('colour parsing round-trips through OKLab', () => {
  assert.strictEqual(C.toHex(C.parse('#e14830')), '#e14830');
  assert.strictEqual(C.toHex(C.parse('rgb(225 72 48)')), '#e14830');
  const lab = C.parse('oklch(0.6 0.2 30)');
  assert.ok(Math.abs(lab[0] - 0.6) < 1e-9);
  assert.strictEqual(C.toHex(C.parse(C.toOklchString(lab))), C.toHex(lab));
  // P3 red sits outside sRGB but inside P3
  const p3red = C.parse('color(display-p3 1 0 0)');
  assert.ok(!C.inGamut(p3red, 'srgb'));
  assert.ok(C.inGamut(p3red, 'p3'));
  assert.strictEqual(C.parse('nonsense'), null);
});

test('generator is deterministic per seed and stays in bounds', () => {
  const a = G.generate(1629, {});
  const b = G.generate(1629, {});
  assert.deepStrictEqual(a, b);
  assert.notDeepStrictEqual(a, G.generate(1630, {}));
  for (const seed of [1, 2, 3, 99, 12345]) {
    const { panels } = G.generate(seed, { panels: 6, coverage: 1, flutesMin: 1, flutesMax: 9 });
    assert.strictEqual(panels.length, 6);
    let prev = 0;
    for (const p of panels) {
      assert.ok(p.x0 >= prev - 1e-9 && p.x1 > p.x0 && p.x1 <= 1 + 1e-9);
      for (let i = 1; i < p.knots.length; i++) assert.ok(p.knots[i][0] >= p.knots[i - 1][0]);
      prev = p.x1;
    }
  }
});

test('layout of panels does not move when only column params change', () => {
  const a = G.generate(5, { flutesMin: 2, flutesMax: 2 }).panels.map((p) => [p.x0, p.x1]);
  const b = G.generate(5, { flutesMin: 7, flutesMax: 7 }).panels.map((p) => [p.x0, p.x1]);
  assert.deepStrictEqual(a, b);
});

test('ICC profile has Display P3 colorants (D50 adapted)', () => {
  const icc = PNG.buildIcc('p3');
  const dv = new DataView(icc.buffer);
  assert.strictEqual(dv.getUint32(0), icc.length);
  assert.strictEqual(String.fromCharCode(...icc.subarray(36, 40)), 'acsp');
  const { matrix } = PNG.rgbToXyzD50(
    { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: [0.3127, 0.329] }
  );
  // Apple's Display P3 profile: rXYZ = 0.5151, 0.2412, -0.0011
  assert.ok(Math.abs(matrix[0][0] - 0.5151) < 1e-3);
  assert.ok(Math.abs(matrix[1][0] - 0.2412) < 1e-3);
});

test('streaming PNG encoder writes valid 16-bit data', async () => {
  const W = 19, H = 11;
  const enc = await PNG.createEncoder({ width: W, height: H, bitDepth: 16, dpi: 300 });
  const px = new Uint8Array(W * H * 6);
  const dv = new DataView(px.buffer);
  for (let i = 0; i < W * H * 3; i++) dv.setUint16(i * 2, (i * 2654435761) & 0xffff);
  await enc.writeRows(px.subarray(0, 4 * W * 6), 4);
  await enc.writeRows(px.subarray(4 * W * 6), H - 4);
  const buf = Buffer.from(await (await enc.finish()).arrayBuffer());

  let o = 8;
  const idat = [];
  const types = [];
  while (o < buf.length) {
    const n = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    types.push(type);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + n));
    o += 12 + n;
  }
  assert.deepStrictEqual([types[0], types.at(-1)], ['IHDR', 'IEND']);
  assert.ok(types.includes('iCCP') && types.includes('pHYs'));
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rb = W * 6;
  let prev = new Uint8Array(rb);
  for (let y = 0; y < H; y++) {
    assert.strictEqual(raw[y * (rb + 1)], 2);
    const row = new Uint8Array(rb);
    for (let i = 0; i < rb; i++) row[i] = (raw[y * (rb + 1) + 1 + i] + prev[i]) & 0xff;
    assert.deepStrictEqual(row, px.subarray(y * rb, (y + 1) * rb));
    prev = row;
  }
});
