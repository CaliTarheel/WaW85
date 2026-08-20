# Mapforge

**Live site:** <https://mapforge-waw85.srider.chatgpt.site/>

**Public source:** <https://github.com/CaliTarheel/WaW85>

Mapforge turns a 2.86 × 1.95 km footprint anywhere on Earth into a layered,
23 × 13 hex board for *World at War '85*. It combines elevation data with
OpenStreetMap features, then provides SVG artwork and a reloadable JSON project.

The site adapts the open-source work in
[CaliTarheel/WaW85](https://github.com/CaliTarheel/WaW85) for the Cloudflare
Workers-compatible Sites runtime.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
npm run build
```

Elevation comes from AWS Terrain Tiles. Roads, water, land use, and buildings
come from OpenStreetMap via Overpass, with the small-area OpenStreetMap map API
as a backup. If neither detail source is available, generation stops with a
retry message instead of returning an incomplete green board.

The Mapforge engine is MIT licensed; see `vendor/mapforge/LICENSE`.

## License and attribution

Copyright © 2026 Stephen G. Rider. The site code and Mapforge engine are
available under the MIT License. If you reuse or customize them, keep the
copyright and license notice and credit Stephen G. Rider. Contact:
<rider.sg@gmail.com>.
