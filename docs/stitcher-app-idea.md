# Tile Stitcher App — future idea (not started)

A separate, standalone web app that takes already-exported MapNG batch tiles and
assembles them into one BeamNG level. The point is to escape the ~4 GB browser-tab
ceiling that caps the in-app **Combined Level** export at 16384², so very large
levels (32768²+) become possible.

Status: idea only. We are focused on MapNG itself for now. This is a placeholder
so we don't lose the thinking.

## Why a separate app

The in-app combined export must hold full-grid buffers in RAM (heightfield, .ter,
minimap RGBA). Past 16384² those exceed the tab heap. A purpose-built stitcher can
write output **incrementally to disk** instead of holding it all in memory, which
removes the size ceiling.

## What makes it feasible

Batch mode already emits everything a stitcher needs, per tile:

- `heightmap_16bit.png` — elevation, already encoded
- `satellite.png` / `hybrid_texture.png` — base texture
- `features.geojson` — roads/buildings/etc.
- `metadata.json` — bounds, grid position, and the shared-baseline min/max

If shared baseline was on during the batch, tiles are already seam-aligned in
absolute elevation. So the stitcher mostly concatenates + repackages rather than
recomputing terrain.

## Rough shape (when we get to it)

- User multi-selects the per-tile ZIPs (or a folder).
- Read each `metadata.json` to learn grid layout + elevation range.
- Assemble heightmap + texture + merged GeoJSON; run the existing
  `exportBeamNGLevel` packaging.
- Use the **File System Access API** (Chrome/Edge) to stream the `.ter` and
  minimap to disk row-block by row-block — never holding the full grid in RAM.
  This is the unlock for 32768²+.

## Open questions / caveats

- A naive "load all tiles into one canvas" approach hits the same 4 GB wall — the
  win only exists if it's streamed/out-of-core from the start.
- File System Access API is Chrome/Edge only (fine for a power-user tool).
- Seam handling for roads/buildings uses the merged GeoJSON; needs dedup by OSM id.
- Could reuse much of MapNG's export code — worth deciding shared package vs. copy.

## Related

- In-app combined export lives in `services/batchJob.js`
  (`createCombinedLevelContext` / `finalizeCombinedLevel`), capped at 16384².
