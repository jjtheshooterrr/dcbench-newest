# DC Bench

Dimensional control survey software. Desktop app (Windows / macOS) built with Tauri 2 and TypeScript.
Leica-first: imports GSI8/GSI16, talks GeoCOM live over RS232 or Bluetooth, plots to DXF.

## What it does

| Area | Routines |
|---|---|
| Fits | 2D and 3D best-fit (3/4/6/7-parameter, Horn least squares), plane fit, circle fit (3D, optional fixed radius), cylinder / pipe fit (works on a partial arc, optional fixed radius), sphere fit, line/axis fit, corner fit (three-plane intersection) |
| Piping | Flange: PCD, face angle to design axis, tilt and skew (or pitch & roll for a face looking up), hole spacing error, two-holing rotation with bolt-hole clock angles, face flatness, holes-to-face offset |
| Geometry | COGO: inverse, point-to-line chainage and offset, line-line intersection, point-to-plane offset. Translate / rotate / scale about origin, centroid or a point; pitch & roll levelling to a plane or axis |
| View | Orbitable 3D view of points and saved fits (circles, cylinders, spheres, planes, lines) |
| Instrument | Leica GeoCOM: connect, station setup, resection from known points, measure & store, ATR on/off, laser pointer, turn-to-point (robotic), read-back of prism constant and atmospheric settings |
| Import | Leica GSI8 / GSI16 (coordinates or polar + station blocks), CSV/TXT, Trimble JobXML (.jxl) |
| Export | DXF R12 (points, labels, fitted circles, cylinders, spheres, plane outlines, residual vectors), CSV, GSI, text report |
| Jobs | `.dcj` job file: points, saved fits with full reports, history |

Internally everything is metres; the job's display units (mm / m / in) and tolerance drive the tables, flags and reports.

## Build

Requirements: Node 20+, Rust stable, and the Tauri 2 prerequisites for your OS
(<https://tauri.app/start/prerequisites/>). On Windows that is the MSVC build tools and WebView2 (preinstalled on Win 11).

```bash
npm install
npm test            # core maths / parser / protocol tests
npm run tauri dev   # run the desktop app
npm run tauri build # produces installers in src-tauri/target/release/bundle/
```

The app opens empty; **Load sample job** on the Job screen fills it with example points for every routine.

Installers from CI: push a tag like `v0.2.0` and `.github/workflows/release.yml` builds the Windows MSI/NSIS and macOS DMG into a draft GitHub release.

Replace `src-tauri/icons/*` with real artwork before shipping (`npm run tauri icon path/to/icon.png` generates all sizes).

## Connecting a Leica total station

1. On the instrument, set the interface to **GeoCOM** (Captivate: *Settings → Connections → GeoCOM*; Viva/SmartWorx: *Instrument → Interfaces*). Match the baud rate (115200 default) on both ends.
2. Cable (GEV serial/USB) or Bluetooth pairing: Windows exposes it as a COM port.
3. In DC Bench: *Instrument → Port → Connect*. The status bar shows the instrument model and serial number.
4. Set up the station (type coordinates, pick a job point, or run **Resection** on 3+ known points), then **Measure & store**.

Measuring, station setup and reading angles work on any GeoCOM-capable Leica. Turning the instrument, ATR and PowerSearch need the GeoCOM Robotic licence on the instrument (TS13/TS16/MS60 licensing varies by region; ask your Leica dealer). Without it those buttons return "not licensed".

The **Simulator** port lets you exercise the whole workflow with no hardware.

RPC numbers are in `src/core/geocom.ts`. They follow the Leica GeoCOM Reference Manual (TPS1200/Viva/Captivate core set). If your firmware reports "not implemented" for a call, check that firmware's manual and adjust the constant.

## Layout

```
src/core/geom.ts     vectors, Jacobi eigen, rotations
src/core/fits.ts     best-fit, plane, circle, cylinder, sphere, flange, corner, line, levelling
src/core/cogo.ts     inverse, point-to-line, point-to-plane, line-line
src/core/formats.ts  GSI / CSV / JobXML read-write
src/core/geocom.ts   GeoCOM client + simulator
src/core/serial.ts   serial transport (tauri-plugin-serialplugin)
src/core/dxf.ts      DXF R12 writer
src/core/job.ts      job model and .dcj persistence
src/ui/              shell, plot, 3D view, dialogs, sample job
src/main.ts          screens
src-tauri/           Rust host (plugins only)
```

## Roadmap

- Bundle fit adjustment (multi-station network, least squares with observation weights)
- Reflectorless routine (plane-constrained reflectorless shots)
- Flange angle diagrams and PDF/Excel report export
- Design model import (STEP/IGES) for as-built against nominal
- Trimble and Topcon/Sokkia live connections
- Licence activation
