# BeamNG Asset-Folder Migration — Investigation & Map

BeamNG **0.37** moved most shared textures out of per-level folders into a
central, always-shipped `/assets/` folder (`Introducing-assets-folder.md`). Each
level still ships a `*.link` file at the old texture path that redirects to the
new `/assets/` location, so vanilla levels keep working.

Our exported levels reference many textures by their **old level-scoped paths**
(e.g. `/levels/east_coast_usa/art/shapes/signs_usa/eca_roadsigns_d.dds`). Those
paths only resolve if the redirect `.link` file is present — which our exported
ZIP does not bundle. The result is unresolved textures (e.g. the bare-metal stop
sign). The fix is to reference the shared `/assets/` paths **directly**, since
they are global and present in every install regardless of which base level is
selected.

## Method

The `.link` files inside the level zips are the **authoritative** old→new map.
`scripts/build-asset-map.py` harvests every `.link` redirect from all 21
always-shipped level zips under `refs/beamng/content/levels/` and writes the full
ground-truth map to `docs/asset-map.json`.

- Levels scanned: **21**
- Total `.link` redirects: **5,040** → `docs/asset-map.json`

It then matches the map against every level-scoped texture path our exporter
references (across `exportBeamNGLevel.js`, `osmTerrainMaterials.js`,
`beamngRuntimeMaterialCatalog.js`, `beamngBiomeCatalog.js`).

Re-run after any game update: `python3 scripts/build-asset-map.py`.

## Findings — all 229 distinct exporter texture references

| Class | Count | Meaning | Action |
| --- | ---: | --- | --- |
| **A** | 96 | Has an authoritative `.link` redirect → `/assets/…` | Rewrite to the `/assets/` path |
| **B** | 75 | Still a **real file** inside its level zip (always shipped) | Valid as-is; optional to also point at `/assets/` where one exists |
| **C** | 36 | Not linked, but the same basename exists under `/assets/` | Rewrite to the found `/assets/` path **after verifying the match** |
| **D** | 22 | Exists in **neither** the level zip nor `/assets/` | Stale path from an older game version — **must be replaced** |

Classes A + C (122 paths) have a concrete `/assets/` target and are collected in
`docs/asset-rewrite-exporter.json` (old path → `/assets/` path). Class B is safe
to leave. Class D is the real latent bug set.

### Class D — stale paths that resolve to nothing (priority)

These point at files that no longer exist anywhere in the current game. They are
mostly **east_coast_usa terrain textures** and a few water/groundcover/tree
textures from an older layout:

- `levels/east_coast_usa/art/terrains/t_grass1_*`, `t_macro_grass_*`,
  `t_macro_asphalt_*`, `t_terrain_base02_*`, `t_asphalt_02_*` (the terrain PBR set
  used by `osmTerrainMaterials.js` — explains washed-out/!-material terrain in
  some exports)
- `levels/east_coast_usa/art/shapes/groundcover/t_grass_01_*`
- `levels/italy/art/water/foam2.dds`, `depthcolor_ramp_italy_{muddy,rivers}.png`,
  `ripple*.dds`
- `levels/gridmap_v2/art/terrains/grass_n.normal.png`, `macro_grass_d.color.png`
- `levels/johnson_valley/art/shapes/{groundcover/dry_grass_*,trees/deserttrees/*}`
- `levels/jungle_rock_island/art/shapes/groundcover/Grass03_tropical_d.dds`,
  `levels/italy/art/shapes/groundcover/Grass_green_*`

For Class D, find the **current** equivalent in `/assets/` (the textures were
renamed, e.g. `t_grass1` → a `/assets/materials/terrain/…` entry) and update the
material to the new name. `beamngBiomeCatalog.js` already uses correct `/assets/`
paths for its foliage/water — those are the model to follow.

## Cooked-texture extension nuance (`.png` ↔ `.dds`)

The `.link` redirect targets reference the **source** texture extension
(`…_b.color.png`), but the asset that physically ships is the **cooked** form
(`…_b.color.dds`). BeamNG resolves the source path to the cooked file at load
time. So a rewrite target ending in `.png` is correct even though only the
`.dds` exists on disk — do not "fix" it to `.dds`. Existence checks must be
extension-agnostic (match the path stem, accept `.png`/`.dds`). All 117 rewrite
targets resolve under this rule.

## Why reference `/assets/` directly (the rule)

- `/assets/` is shared, global, and shipped with **every** install.
- Level-scoped paths are now just redirects; bundling them would require copying
  the `.link` (and its target) into our ZIP — fragile and version-specific.
- The newer `beamngBiomeCatalog.js` already uses `/assets/` paths; this migration
  brings the rest of the exporter in line.

**Exception:** Class B textures that genuinely still live in a level zip (water
ramps, some terrain bases) are valid via the level path because that level always
ships. Prefer `/assets/` where an equivalent exists, but a Class-B level path is
not a bug.

## Files

- `scripts/build-asset-map.py` — reproducible harvester.
- `docs/asset-map.json` — full 5,040-entry ground-truth `.link` map.
- `docs/asset-rewrite-exporter.json` — the 122 actionable old→`/assets/` rewrites
  for paths our exporter references.

## Migration plan (incremental, test-guarded)

1. **Done:** sign materials → `/assets/` (`getSignRuntimeMaterialDefs`).
2. **Done:** Class A rewrites (96) — authoritative `.link`-map path swaps applied
   to `osmTerrainMaterials.js`, `beamngRuntimeMaterialCatalog.js`,
   `beamngBiomeCatalog.js`.
3. **Done:** Class C rewrites (folded into the same pass; targets verified to
   exist under the `.png`↔`.dds` cooked rule).
4. **Partially done:** Class D (22 stale paths) resolved as far as is safe:
   - **4 applied** — unique `/assets/` matches (`t_grass_01`, `Grass_green`
     foliage textures in `beamngBiomeCatalog.js`).
   - **5 ambiguous** — 2 candidate assets each (`t_desert_tree_leaves_*`,
     `t_grass_01_nm`); left as-is pending an in-game check of which atlas the
     mesh expects. Guessing risks a wrong texture.
   - **13 truly gone** — no equivalent anywhere in the current game:
     - `east_coast_usa/art/terrains/t_terrain_base02_*` (terrain PBR; needs a
       current replacement base texture chosen)
     - `gridmap_v2/art/terrains/grass_n.normal.png`, `macro_grass_d.color.png`
     - `italy/art/water/{depthcolor_ramp_italy_muddy,_rivers,foam2,ripple*}` —
       **these live in dead `WATER_BLOCK_TEMPLATE` defaults that are always
       overridden** by the biome catalog's `/assets/` water paths at runtime, so
       they don't actually render; clean them up cosmetically.
     - `johnson_valley/art/shapes/groundcover/dry_grass_*` (foliage; pick a
       current `/assets/materials/foliage/grass/dry_grass/*` equivalent).
5. **Remaining:** the 28 unresolved + 5 ambiguous + the genuinely-gone terrain
   sets above. These need an in-game render check (which is why they were not
   auto-rewritten). The 75 Class B paths are valid as-is (real files in
   always-shipped level zips).
6. **TODO test:** assert every exporter texture path resolves to either a
   `docs/asset-map.json` target, an existing `/assets/` file (extension-agnostic),
   or a real file in a shipped level zip — to catch new stale paths.
