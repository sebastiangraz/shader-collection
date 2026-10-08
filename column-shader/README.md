# Column Shader

A seeded WebGL2 shader for vertical gradient columns that look like light through reeded glass. Each panel of columns is shaded with a smooth highlight-to-shadow profile, mapped through a colour ramp you can edit, and set against a flat background. Exports are high-resolution 16-bit PNGs in Display P3, ready for print.

## Run it

There's no build step. Either open `index.html` directly in a browser, or serve the folder:

```sh
cd column-shader
npm start            # → http://localhost:5173
```

Use a recent Chrome, Edge or Safari. These browsers can draw the WebGL preview in Display P3, so wide-gamut screens show the real colours.

## How it's generated

1. **Layout (seeded).** The seed splits the width into *panels* and background gaps. Every random choice comes from its own sub-stream (`seed + "layout"`, `seed + "panel-3"`, …), so changing the column count leaves panel positions where they are.
2. **Columns.** Each panel holds a number of columns. Each column is a valley: highlights sit at the column boundaries and a shadow sits at the core. *Symmetry* mirrors a panel around its centre. *Centre depth* puts the darkest shadows in the middle. *Edge crop* lets the panel edge cut into the outer columns, the way a pane of reeded glass would.
3. **Shading → colour.** A shadow/highlight value in the range 0–1 is mapped through the **column ramp** (up to 8 stops). Panel edges are blurred analytically with a Gaussian, so the image is resolution-independent and the preview matches the export.
4. **Noise displacement.** fBm noise shifts each pixel horizontally before the column lookup, so the edges wobble slightly. *Vertical stretch* makes the wobble longer and slower. *Horizontal variation* controls whether neighbouring columns wobble together or separately.
5. **Colour pipeline.** Colours are blended in **OKLCH** by default. OKLCH keeps hue and chroma through transitions, so a red-to-orange blend stays vivid instead of going muddy. OKLab, linear RGB and sRGB blending are also available for comparison. The result is gamut-mapped into Display P3 (or sRGB) by lowering chroma while keeping lightness and hue, then encoded.

## Controls

| Section | Control | What it does |
| --- | --- | --- |
| Seed | ‹ › Shuffle | Step or randomise the layout. Shortcuts: `←` `→` `R`. |
| Layout | Panels, Coverage, Size variance | Number of panels, share of the width they cover, and how much their sizes vary. |
| | Columns min/max, Column variance | Columns per panel and how much their widths vary. |
| | Symmetry, Skew, Edge crop | Mirroring probability, off-centre shadows, and how far edges cut into the outer columns. |
| Shading | Highlight / Shadow min–max | Where the highlights and shadows land on the ramp. |
| | Centre depth | Pulls the deepest shadow to the middle of each panel. |
| | Roundness, Highlight width | Shape of the column profile. Wider highlights give the broad flat bands from the reference. |
| | Edge softness (+ variance) | Gaussian blur of panel edges, as a % of image width. |
| Colour | Background, Column ramp | Accepts any CSS colour: `#hex`, `rgb()`, `oklch()`, `oklab()`, `color(display-p3 …)`. Click a swatch for OKLCH sliders and a system picker. **P3** marks colours outside sRGB. |
| | Blend space, Ramp smoothing | Interpolation space. Smoothing switches the ramp from linear segments to a spline through the stops, which removes the visible kinks at each stop. |
| | Vibrance, Lightness | Global chroma multiplier and lightness offset. |
| Noise | Displacement, Scale, Vertical stretch, Horizontal variation, Detail | The subtle wobble described above. The noise seed is separate from the layout seed. |
| | Grain, Grain density | Optional fine grain in lightness. |

Double-click any slider to reset it. Settings save automatically in the browser. **Save** and **Load** write and read the settings as JSON, so a print can be reproduced exactly.

## Export for print

- **Size presets** (A5–A0, 30×40, 50×70, 70×100 cm, Letter, Tabloid) at any DPI, in portrait or landscape. You can also type exact pixel dimensions.
- **16-bit PNG** by default. The shader renders into a 32-bit float target and the result is quantised to 16 bits per channel, so smooth gradients don't band. 8-bit export uses triangular dithering instead.
- **Display P3** by default, with an embedded ICC profile (plus a `cICP` tag). Choose sRGB if your print shop asks for it.
- **DPI** is written to the file (`pHYs`), so layout apps import it at the right physical size.
- The full settings JSON is stored in a `tEXt` chunk, so every file records how it was made.
- Rendering runs in tiles, and rows are streamed through a compressor, so large prints work. A3 at 300 dpi is 17 MP. A0 at 300 dpi is about 140 MP and needs a lot of memory.

> **Print tip:** the most vivid P3 reds and oranges are outside what CMYK presses can reproduce. Soft-proof against your printer's profile, or ask the print shop for a proof. Lowering *Vibrance* slightly gives you control over how those colours get compressed.

## Files

```
index.html        UI shell
styles.css
js/color.js       CSS colour parsing, OKLab/OKLCH, sRGB ↔ P3, gamut mapping
js/generator.js   seeded panel/column layout → knot data
js/renderer.js    WebGL2 shader, preview + tiled float export
js/png.js         streaming PNG encoder (8/16-bit, ICC, DPI, metadata)
js/app.js         controls, state, export flow
tests/            node tests (npm test)
```
