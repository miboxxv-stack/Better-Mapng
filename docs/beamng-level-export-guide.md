# BeamNG Level Export — Strict Workflow Guide (Source of Truth)

This document is the **authoritative specification** for how MapNG generates and
exports a programmatic BeamNG.drive level from app inputs (terrain heightmap, OSM
features, satellite/PBR textures, biome selection, user options).

It is grounded in the official documentation under
`refs/official_levels_documentation/` (the BeamNG levels/modding docs, refreshed
2026-06) and cross-checked against vanilla content shipped in the game
(`refs/beamng/content/levels/*.zip`) and the MapNG starter level
(`refs/MapNG_template/`). **Where the docs and vanilla content disagree, vanilla
content wins** — the docs state outright that they are "incomplete and undergoing
active development", and several doc examples use placeholder values (e.g. terrain
`version: 8`) that do not match what the current engine actually ships.

The export implementation (`services/exportBeamNGLevel.js`, `services/exportTer.js`,
`services/osmTerrainMaterials.js`, …) and the tests (`tests/*.test.mjs`) MUST
conform to this guide. When the guide and the code disagree, that is a bug in one
of them — reconcile, don't ignore.

The companion file `docs/beamng-export-conformance-matrix.md` tracks per-artifact
implementation status against this guide.

---

## 0. Terminology and coordinate conventions

| Term | Meaning |
| --- | --- |
| `size` | Terrain grid edge in samples. Square, power-of-two. |
| `squareSize` | Real-world meters between heightmap samples (`TerrainBlock.squareSize`). |
| `worldSize` | `size × squareSize`, the level's physical edge in meters. |
| `maxHeight` | Elevation **range** in meters that the stored `u16` heightmap spans. |
| `halfExtent` | `worldSize / 2`. Terrain is centered on world origin. |

**World axes (BeamNG):** `+X` = east, `+Y` = north, `+Z` = up. Terrain is centered
at the origin, so its SW corner is at `[-halfExtent, -halfExtent, baseZ]`.

**Heightmap orientation:** the source `heightMap` array has row 0 = north edge.
The `.ter` writer flips Y so that `.ter` row 0 = **south** edge (engine convention;
the importer's `flipYAxis` defaults to flipping input). The layer map is built in
terrain space (row 0 = south) and written **without** that extra flip. Keep these
two conventions distinct — mixing them produces vertically mirrored painting (see
`Terrain-Files.md` §"Y-axis flipping" and §3.1 below).

**Geo→world projection:** all geo-referenced placement (roads, objects, spawn,
terrain material layerMap) MUST use a single shared local-metric projection
(`createWGS84ToLocal(centerLat, centerLng)`) normalized by `squareSize × size`.
A naive linear lat/lng box-stretch is **forbidden** because it drifts from the
metric texture projection by ~cos(latitude) in X (this caused the historical
"grass over sidewalks" misalignment). See §6.

---

## 1. Level package layout (canonical)

A conformant export is a ZIP whose single top-level entry is `levels/`, containing
exactly one `levels/<levelId>/`. `<levelId>` is the sanitized, lowercased level
name. (`Correctly-packing-mods.md`: the first folder in the zip must be the
top-level content folder — `levels` — never a wrapper/mod-name folder.)

```
levels/<levelId>/
├── info.json                         # level metadata (§2)
├── main.level.json                   # legacy/compat monolithic entrypoint (§9)
├── terrain.terrain.json              # terrain metadata (§3)
├── map.json                          # navigation segments (§7)
├── signals.json                      # traffic signals (§7)
├── signalControllerDefinitions.json  # only if custom controllers used
├── city.sites.json                   # sites scaffold (§7)
├── main.decals.json                  # placed decals (scaffold ok, §7)
├── main.forestbrushes4.json          # forest brushes (§5)
├── mainLevel.lua                     # level load hook
├── preview.png                       # thumbnail referenced by info.json
├── groundModels/mapng_groundmodels.json  # self-contained physics surfaces (§7)
├── art/
│   ├── terrains/
│   │   ├── terrain.ter               # binary terrain (§3)
│   │   ├── terrain.terrainheightmap.png
│   │   ├── terrain.png               # base color texture
│   │   ├── main.materials.json       # TerrainMaterial defs (§4)
│   │   └── <pbr texture files>       # when PBR painting enabled
│   ├── decals/managedDecalData.json
│   ├── forest/managedItemData.json   # when vegetation present (§5)
│   └── cubemaps/Universal_cubemap_reflection/   # bundled reflection cubemap
├── forest/*.forest4.json             # placed vegetation (§5)
├── map_assets/
│   ├── custom_assets/                # generated DAE meshes + their materials
│   │   ├── osm_objects/
│   │   ├── terrain_backdrop/
│   │   └── mapng_flag/
│   └── official_assets/biome_materials/main.materials.json
└── main/
    ├── items.level.json              # root: one SimGroup "MissionGroup"
    └── MissionGroup/
        ├── items.level.json          # child SimGroups (§8)
        ├── sky_and_sun/items.level.json        # LevelInfo, TimeOfDay, ScatterSky, CloudLayer
        ├── level_objects/items.level.json      # TerrainBlock + TSStatics
        ├── PlayerDropPoints/items.level.json   # SpawnSphere
        ├── Water/items.level.json              # water objects
        ├── AIWaypointsGroup/items.level.json
        ├── AIDecalWaypointsGroup/items.level.json
        ├── vegetation/items.level.json         # when present: Forest + GroundCover
        ├── Decal_Roads/…                        # when decal roads
        ├── Mesh_roads/items.level.json          # when mesh roads
        ├── roads/…                              # when Road Architect groups
        ├── barriers/items.level.json            # when barriers
        └── signs/items.level.json               # when OSM signs
```

**Rule L1 — `items.level.json` is line-delimited JSON (NDJSON).** One complete JSON
object per line. Never a JSON array, never pretty-printed multi-line objects, never
a trailing comma. Invalid lines are *silently skipped and logged*, so a malformed
line = a missing object. (`Level-Object-Files.md`)

**Rule L2 — Hierarchy via folders AND `__parent`.** Two equivalent mechanisms exist
and MapNG uses both together:
- Recursive `SimGroup` folders: every `SimGroup` named in a parent `items.level.json`
  MUST have a matching subfolder with its own `items.level.json` (the engine looks
  for `<GroupName>/items.level.json` next to the parent). The file may be empty for
  an empty group.
- Each scene object also carries a `__parent` string naming its group.
Keep `__parent` values resolvable to an existing `SimGroup` and keep folder names
exactly matching the group names. (`Level-Object-Files.md`, `SimGroup.md`)

**Rule L3 — Every object has a non-empty `class`.** Objects also carry common
transform fields where applicable: `position` (`[x,y,z]`), `rotationMatrix`
(9-value 3×3, row-major), `scale` (`[x,y,z]`). Invalid transforms are defaulted by
the loader (`[0,0,0]`, identity, `[1,1,1]`). (`Level-Object-Files.md`)

**Rule L4 — Root group is `MissionGroup`.** `main/items.level.json` declares one
`SimGroup` named `MissionGroup`; almost everything is a direct/indirect child of it.
(`SimGroup.md`)

---

## 2. info.json (`Level-Metadata.md`)

`info.json` lives in the level root and drives the level selector, spawn UI, big
map/POI, environment presets, traffic/time-of-day systems, and minimap. It stores
**no geometry**.

Required / strongly-recommended keys MapNG emits:

- `title`, `description`, `authors`, `biome`, `features`, `suitablefor`, `roads`.
  (Docs recommend translation IDs for UI text; plain strings are accepted and are
  what MapNG emits.)
- `size`: `[worldSizeMeters, worldSizeMeters]` — documented as the *approximate*
  level size in meters `[width, height]`.
- `defaultSpawnPointName`: MUST equal a `spawnPoints[].objectname` AND the `name`
  of a `SpawnSphere` in `PlayerDropPoints` (§8). A mismatch silently yields a
  fallback spawn (the loader inserts one, or uses the engine's origin `Zero`).
- `previews`: `["preview.png"]` — the first entry is the main thumbnail and the
  referenced file MUST exist in the ZIP (§1). Paths are level-relative.
- `spawnPoints[]`: at least one, each with `objectname`, `preview`, `translationId`
  (+ optional `description`, `logbookEntry`).
- `country`, `region` (e.g. `northAmerica`), `supportsTraffic`, `supportsTimeOfDay`.
- `roadRules`: `{ rightHandDrive, turnOnRed }`. `rightHandDrive` drives lane-side
  interpretation for nav/lane generation (it does NOT change road geometry).
  Defaults if omitted: both `false`.

Optional keys the docs define (MapNG may add over time): `localUnits`
(`{gasoline, diesel}`), `minimap` (§I3), `timeOfDayPresets` +
`excludeDefaultTimeOfDayOptions`, `isAuxiliary`.

**Rule I1 — Strict JSON.** No trailing commas anywhere (loader rejects them).
**Rule I2 — `supportsTraffic` honesty.** Only `true` when the export actually
produces a navigable graph (decal roads, or `map.json` segments). The doc default
is `true` when missing, so MapNG must set it explicitly. (See Rule R1, §10.12.)
**Rule I3 — `minimap` (emitted).** MapNG emits one minimap tile reusing the
north-up base color texture as the top-down map image: `{file:"art/terrains/terrain.png",
size:[worldSize,worldSize], offset:[-halfExtent,+halfExtent]}` (offset = NW corner =
`[west, north]`). The referenced file MUST exist (it does — it is the terrain base
texture), and `TerrainBlock.minimapImage` points at the same texture
(`levels/<id>/art/terrains/terrain.png`, leading `levels/`, no slash).
**Rule I4 — `hidden` is deprecated.** Use `isAuxiliary` instead; the loader maps
`hidden`→`isAuxiliary` with a warning.

---

## 3. Terrain: `.ter` + `terrain.terrain.json` + TerrainBlock (`Terrain-Files.md`, `TerrainBlock.md`)

### 3.1 `.ter` binary (current saved layout)

Sequential little-endian layout (`TerrainFile::save()`):

| Step | Field | Type | Notes |
| --- | --- | --- | --- |
| 1 | `version` | `u8` | first byte |
| 2 | `size` | `u32` | square edge |
| 3 | `heightMap` | `u16[size²]` | row 0 = south edge |
| 4 | `layerMap` | `u8[size²]` | material index per sample; `255` = hole |
| 5 | `materialCount` | `u32` | |
| 6 | `materialNames` | length-prefixed strings | order MUST match layerMap indices |

The current layout has **no** `layerTextureMap` block — that token appears only in
the `binaryFormat` description string for backward-compat readers. New terrains use
version/size/heightMap/layerMap/materialCount/names (matches MapNG and the template).

**Rule T1 — Version is `9`, verified against vanilla.** The docs say the loader
*fails* when `version > FILE_VERSION` and uses the modern path for `version ≥ 7`.
The docs' worked examples show `version: 8`, but that is a placeholder. Vanilla
`automation_test_track` and `refs/MapNG_template` both ship `.ter` byte0 = **9** and
`terrain.terrain.json` `version: 9`. MapNG therefore writes `9`. The `.ter` first
byte and `terrain.terrain.json.version` MUST stay in lockstep, and the value MUST be
re-verified against vanilla whenever the target game build changes. Tests assert
byte0 == `terrain.terrain.json.version` (§10.5).

**Rule T2 — Heightmap encoding is range-relative.**
`stored = clamp(round((h − min) / (max − min) × 65535), 0, 65535)`.
The engine decodes with `heightMeters = stored × (maxHeight / 65536)` — note the
decode divisor is **65536**, not 65535, so a sample at the very top decodes ~1 part
in 65536 below `maxHeight`. This sub-millimeter asymmetry is intentional: encoding
with 65535 avoids `u16` overflow at the maximum. `TerrainBlock.maxHeight` MUST equal
the elevation **range** (`max − min`, with a sane floor so `range > 0` on flat
terrain), and `TerrainBlock.position.z` carries the absolute base so world heights
are correct.

**Rule T3 — Square, power-of-two; runtime tolerates up to 16384.**
`computeBeamNGTerrainSize()` floors to a power of two. The docs' `[128, 8192]`
figure in `Terrain-Files.md` is the **editor heightmap-import** constraint (the
import dialog), *not* the runtime `.ter` loader limit. The runtime loader has been
**verified in-game to load 16384×16384 terrain** (MapNG author testing, 2026-06),
so MapNG may export grids up to 16384 even though that exceeds the editor import
figure. Therefore the upper bound is not a conformance risk. Remaining nuance:
- There is no enforced **lower bound (128)** — sub-128 grids (e.g. the 8×8 test
  fixture) export without complaint. Real exports come from the resampler at much
  larger sizes, so this is a fixture-only edge case, not a shipped-export risk; a
  defensive 128 floor is optional polish.
- The largest *vanilla* terrain checked is `automation_test_track` = 4096, but
  vanilla is a floor on what works, not a ceiling — 16384 is author-verified.

**Rule T4 — layerMap/material order coupling.** `materialNames[i]` is the material
painted where `layerMap == i`. The PBR painter (`osmTerrainMaterials.js`) and the
material-name list passed to `exportTer` MUST share one ordering. `255` only marks
intentional holes (MapNG produces none → no `255`). Layer import uses
highest-opacity-wins per sample; keep opacity/layer maps the same size as the
heightmap.

### 3.2 `terrain.terrain.json`

Descriptive metadata for tools (the engine reads geometry from the `.ter`):
`version`, `datafile`, `heightmapImage`, `size`, `binaryFormat`, `heightMapSize`
(= size²), `heightMapItemSize` (2), `layerMapSize` (= size²), `layerMapItemSize`
(1), `materials[]` (= the `.ter` material name list, same order).

### 3.3 `TerrainBlock` (in `level_objects/items.level.json`)

```jsonc
{ "class":"TerrainBlock", "name":"theTerrain", "__parent":"level_objects",
  "position":[-halfExtent,-halfExtent, baseZ],
  "squareSize":<m/sample>, "maxHeight":<range m>,
  "baseTexSize":size, "terrainFile":"/levels/<id>/art/terrains/terrain.ter",
  "materialTextureSet":<pbr set name | "">, "minimapImage":"",
  "castShadows":true }
```

**Rule T5 — No object scale.** `TerrainBlock` ignores `scale`; size comes from
`squareSize`/`maxHeight`/heightmap. Optional fields: `lightMapSize`, `screenError`
(legacy), `castShadows`. Naming the block `theTerrain` matters — systems look it up.

---

## 4. Terrain materials (`art/terrains/main.materials.json`) — v1.5 workflow

Modern terrain uses the **v1.5 `TerrainMaterial`** path (base/macro/detail texture
groups: base color, normal, roughness, AO, height), referenced from the
`TerrainBlock` via `materialTextureSet` (a `TerrainMaterialTextureSet` defining
`baseTexSize`/`macroTexSize`/`detailTexSize`). (`Terrain-Files.md`,
`Materials-v1.5.md`)

- With PBR painting: emit the painter's `TerrainMaterial` defs (DefaultMaterial =
  satellite base + OSM-derived overlays), the `materialTextureSet`, and the matching
  `materialNames` ordering for the `.ter`.
- Without PBR: a single `DefaultMaterial` (`TerrainMaterial`) whose base color is
  `terrain.png`, with a `groundmodelName`.

**Rule M1 — ≤254 terrain materials.** `u8` layer indices, `255` reserved for holes;
extras beyond 254 are ignored. Keep the count low for performance.
**Rule M2 — Resolvable names.** Every name in the `.ter` list MUST have a
`TerrainMaterial` def or terrain renders as the warning material. All textures in a
given slot must match the `TerrainMaterialTextureSet` size for that slot.
**Rule M3 — `groundmodelName` per material.** Each `TerrainMaterial` sets
`groundmodelName` (GRASS/DIRT/SAND/ROCK/ASPHALT/GRAVEL/MUD) to link physics/friction.
Because DecalRoads project onto the terrain, the terrain material beneath a road
*is* the road's physics surface — so the painter's OSM-driven layer choice (asphalt
under paved roads, gravel/dirt under unpaved) is the OSM `surface=*` → ground-model
mapping. MapNG ships these models self-contained in `groundModels/mapng_groundmodels.json`
(§7) with values mirroring vanilla, so the level does not depend on the global
`/art/groundmodels.json`. `GROUNDMODEL_ASPHALT1` resolves via the `ASPHALT` alias
list, both globally and in the shipped file.

### 4.1 Object materials (`*.materials.json`) — general rules (`Materials-.materials.json.md`)

A material file is a JSON object keyed by material name (key == `name`). Each is a
`Material` with `mapTo` (the mesh material-slot/target name) and texture fields as
**arrays** (`baseColorMap`, `normalMap`, `roughnessMap`, `metallicMap`, …) plus
scalar factors. Best practices that bind MapNG's DAE/material emission:
- **`mapTo` must match the DAE material target** or the mesh renders the warning
  material. (`TSStatic.md`, `Materials-.materials.json.md`)
- **Reference `.png`, not `.dds`.** Use the suffix convention `*.color.png`,
  `*.normal.png`, `*.data.png`; the Texture Cooker auto-cooks PNG→DDS at load and
  the engine prefers the cooked DDS automatically. Normal maps are OpenGL tangent
  space (Y+) and cook to BC5. (`Texture-Cooker.md`, `Legacy-Normal-Maps.md`)
- **Preserve unknown fields** when rewriting third-party/material JSON.
- **Unique material names** across loaded scope; keep capitalization consistent.

---

## 5. Vegetation (`Forest.md`, `Forest-Data-and.md`, `Forest-Brushes.md`, `GroundCover.md`)

- Scene: one `Forest` object named `theForest` in `vegetation/items.level.json`
  (its transform is not meaningful for item placement); `GroundCover` objects
  alongside it.
- Item types: `art/forest/managedItemData.json` — a `ForestItemData` (or
  `TSForestItemData`) per tree/rock, keyed by `internalName`, with `shapeFile` (+
  wind/physics fields). `internalName` and `shapeFile` are the only essentials.
- Placements: `forest/*.forest4.json` — **NDJSON**, one item per line:
  `{type, pos:[x,y,z], rotationMatrix:[9], scale:<number>}`. `scale` is a single
  **uniform number**, not a vector. Files are grouped one-per-type by convention.
- Brushes (editor-only): `main.forestbrushes4.json` — a `ForestBrush`/
  `ForestBrushElement` per placed type plus a `ForestBrushGroup`.

**Rule V1 — type/placement coupling.** Every `.forest4.json` `type` MUST exist as a
`managedItemData.json` key whose `shapeFile` exists (bundled or via `.link`).
**Rule V2 — modern format only.** Emit `*.forest4.json` (not deprecated `*.forest`/
`*.forest.json`) and `managedItemData.json` (not `.cs`).

### 5.1 GroundCover density (`GroundCover.md`)

`GroundCover` spreads `maxElements` over a `gridSize × gridSize` grid; per-cell
count ≈ `maxElements / gridSize²`. Exceeding the engine's per-cell billboard cap
logs `GroundCoverCell::updateRender | … has too many elements` and culls the cell.

**Rule V3 — keep per-cell density ≲10,000** (`BEAMNG_MAX_GROUNDCOVER_PER_CELL`).
`gridSizeForElements()` derives `gridSize` from `maxElements` so dense fields scale
the grid instead of overflowing (vanilla stays within this, e.g. `gridSize:8` /
`maxElements:640000` → 10,000/cell). Also: `dissolveRadius ≤ radius`; `layer[]`
entries are terrain-material **internal names**; use `maxSlope`/elevation filters;
`windScale:0` for rocks.

---

## 6. Geo-referenced placement & terrain paint alignment

**Rule G1 — One projection.** Roads, OSM objects, spawn, water, AND the terrain
material `layerMap` MUST all map lat/lng→pixel/world through the SAME
`createWGS84ToLocal(centerLat, centerLng)` projection normalized by
`squareSize × size` (SW origin, northward Y). This guarantees painted materials
register with the base texture and with placed geometry.
**Rule G2 — Height sampling.** World Z for placed geometry uses bilinear heightmap
sampling (`geoToWorld`) so objects sit on the surface, not on nearest-sample steps.

---

## 7. Roads, navigation, signals, sites, decals, ground models

### 7.1 Road modes
`architect` (Road Architect session + groups), `mesh` (MeshRoad), `decal`
(DecalRoad), `none`.

**`DecalRoad`** (`DecalRoad.md`): projected decal strip; not geometry. Nodes are
4-value `[x, y, z, width]`. Width interpolates; Z is snapped to terrain unless
`overObjects:true`. Key fields: `material`, `textureLength`, `renderPriority`
(descending draw order), `improvedSpline` (**use `true` for new roads**),
`smoothness`, `detail`/`breakAngle`, `decalBias`/`zBias`, `distanceFade`,
`startEndFade`, `overObjects` (bridges/meshes). Nav fields: `drivability`
(`1` normal, `0.5` rough/dirt, `-1` visual-only), `autoLanes`/`lanesLeft`/
`lanesRight`, `oneWay`/`flipDirection`, `gatedRoad`, `autoJunction` (disable for
overpasses/tunnels/close parallels), `useSubdivisions`, `hiddenInNavi`. Split very
long/wide roads into sections to stay within the renderer's packed-vertex range.

**`MeshRoad`** (`MeshRoad.md`): real geometry. Nodes are **8-value**
`[x, y, z, width, depth, normalX, normalY, normalZ]` — never the 4-value DecalRoad
form. `topMaterial`/`bottomMaterial`/`sideMaterial`, `textureLength`, `breakAngle`,
`widthSubdivisions`. MapNG emits `[x,y,z,width,0.5,0,0,1]` (upright, 0.5 m deck).

**`map.json`** (`Navigation-Map.md`): optional manual nav segments under a top-level
`segments` object. Each segment: `nodes` (array of node names, or range shorthand
`"a_1-a_10"`), `drivability`, `oneWay`/`flipDirection`, `speedLimit` (m/s; `≤0` =
auto), `type` (`"private"`), `gatedRoad`, `hiddenInNavi`, `autoLanes`/`lanesLeft`/
`lanesRight`, `autoJunction`. Node names reference `BeamNGWaypoint` objects or
DecalRoad-derived nodes; a missing node breaks the segment. Supplements the
auto-graph from DecalRoads/waypoints.

**`signals.json`** (`Traffic-Signals.md`): three top-level keys — `instances[]`
(placed signals: `id`, `name`, `controllerId`, `sequenceId` (`0`=none), `pos`,
`dir`, `group`, `startDisabled`), `controllers[]` (`id`, `name`, `type`, `isSimple`,
`states[]`), `sequences[]` (timed phases with `controllerIds[]`, `startTime`). Use
an array for `sequences` (`[]`) in new files. Custom controller `type`/`state` keys
must be defined in `signalControllerDefinitions.json` (only emit it when custom
controllers are used). IDs unique across all three arrays. Stop/yield = simple
controller, `sequenceId:0`. Visible meshes link via a `signalInstance` dynamic
field on a `TSStatic`.

**`city.sites.json`** (`Sites-.sites.json.md`): gameplay metadata (locations, zones,
parking spots, tags, custom fields) — not geometry. `city.sites.json` is the
default level sites file; MapNG ships a valid empty scaffold.

**`managedDecalData.json` + `main.decals.json`** (`Decal-Data.md`): decal *types*
(`DecalData` entries: `material`, `size`, atlas `texRows`/`texCols`, `renderPriority`,
`clippingAngle`, fade) and *instances* (header `version: 2.0`, `instances` grouped
by type, each a 13-value array `[rectIdx,size,renderPriority, px,py,pz, nx,ny,nz,
tx,ty,tz, uid]`). MapNG ships valid scaffolds (`{}` + empty `instances`); a real
library is roadmap.

**`groundModels/mapng_groundmodels.json`** (`Ground-Models.md`): MapNG emits a
self-contained level ground-model file (merged after the global
`/art/groundmodels.json`) defining ASPHALT/GRASS/DIRT/GRAVEL/ROCK/SAND/MUD with
values mirroring vanilla, plus the `ASPHALT` `aliases` list (incl.
`groundmodel_asphalt1`). The terrain materials' `groundmodelName` link each painted
surface here, so road/terrain friction is correct and the level is self-contained.
Each key is a ground model (uppercased, truncated to 31 chars) with
friction/roughness/depth/`collisiontype`/`skidMarks`; avoid unknown fields
(ignored+logged) and the typo'd `hydrodnamicFriction`/`flowBehaviourIndex`.

**Rule R1 — Nav honesty.** `info.json.supportsTraffic` is `true` ⇔ a real nav graph
exists (decal roads or `map.json` segments).
**Rule R2 — Stable, unique names.** Object/waypoint/signal names referenced by
nav/sites/signals must be unique and stable.

---

## 8. Scene object tree (`main/MissionGroup/…`) (`SimGroup.md`, `LevelInfo.md`, `TimeOfDay.md`, `Water.md`, `SpawnSphere.md`, `TSStatic.md`)

Root `main/items.level.json`: `{"class":"SimGroup","name":"MissionGroup", …}`.
`MissionGroup/items.level.json` declares child SimGroups (always-present base groups
plus any conditional ones with content); each gets its own folder + file.

Always present: `sky_and_sun`, `level_objects`, `PlayerDropPoints`,
`AIWaypointsGroup`, `AIDecalWaypointsGroup`, `Water`.
Conditional: `vegetation`, `Mesh_roads`, `barriers`, `signs`, `roads`, `Decal_Roads`.

- **`sky_and_sun`**: exactly one `LevelInfo` named `theLevelInfo`, one `TimeOfDay`
  (`tod`), one `ScatterSky` (`sunsky`), optional `CloudLayer`. `TimeOfDay` only has a
  visible effect *because* `ScatterSky` listens to it — both are required for a lit
  sky. `TimeOfDay.startTime` sets the initial time (≈`0.15` = morning).
- **`level_objects`**: the `TerrainBlock` (§3.3) + optional `TSStatic`s (osm_objects,
  terrain_backdrop, mapng_flag). TSStatic geometry is pre-placed in world space
  (`position:[0,0,0]`, identity rotation when the DAE is already world-baked).
  `shapeName` → `.dae`; `collisionType`/`decalType` per `TSStatic.md`
  (`"Collision Mesh"` for collidable, `"None"` for decorative); `scale` is honored.
- **`PlayerDropPoints`**: a `SpawnSphere` whose `name` == `info.defaultSpawnPointName`,
  with `dataBlock: "SpawnSphereMarker"` and a `rotationMatrix` facing a safe driving
  direction.
- **`Water`**: `WaterPlane` (ocean; only `position.z` matters — ignores
  rotation/scale), `WaterBlock` (finite, uses `scale` footprint), or `River` (8-value
  spline nodes). Each needs a water `material`.

**Rule S1 — `theLevelInfo`.** Exactly one `LevelInfo` named `theLevelInfo` (systems
look it up by that literal name for gravity/cubemap). Use the engine spelling
`globalEnviromentMap` (one "n") pointing at a valid `CubemapData` name; the misspelling
`globalEnvironmentMap` is wrong. (`LevelInfo.md`)
**Rule S2 — LevelInfo fidelity (recommended).** Beyond the minimum
(`globalEnviromentMap`, `gravity`, `nearClip`, `visibleDistance`, `fog*`,
`canvasClearColor`), the docs document and recommend `decalBias` (≈0.0005, tune with
`visibleDistance` to avoid road z-fighting), `soundAmbience:"AudioAmbienceDefault"`,
`soundDistanceModel:"Logarithmic"`, and `temperatureCurveC`. Default gravity is
`-9.80665` (MapNG uses `-9.81`; acceptable). Size `visibleDistance` to the map and
use fog to hide the far clip.

---

## 9. `main.level.json` (compat entrypoint)

A single monolithic `SimGroup{name:"MissionGroup", childs:[…]}` mirroring the folder
tree, with `__parent` stripped. The modern, preferred entrypoint is the `main/`
folder tree (§1, §8); `main.level.json` is kept only as a fallback for loaders that
expect it. (`Level-Metadata.md` describes `main/` as the current preferred format.)

---

## 10. Invariants checklist (what tests MUST enforce)

1. ZIP has exactly one `levels/<id>/` root; `<id>` sanitized/lowercase; the top-level
   zip folder is `levels/`.
2. Every required file from `getRequiredLevelFiles()` exists (per road/veg mode).
3. All `*.items.level.json` are valid NDJSON; every line has a non-empty `class`;
   no trailing commas.
4. Every `SimGroup` named in a parent file has a matching folder+file; every
   `__parent` resolves to a declared `SimGroup`.
5. `.ter` byte0 == `terrain.terrain.json.version` (== 9, vanilla-verified); `size` is
   square pow2 (and within [128, …] for realistic exports — Rule T3).
6. `.ter` `materialCount` == `materialNames.length` == `terrain.terrain.json.materials.length`.
7. `info.json` parses, no trailing commas; `defaultSpawnPointName` matches both a
   `spawnPoints[].objectname` and a `SpawnSphere.name` in `PlayerDropPoints`.
8. `info.json.previews[0]` file exists in the ZIP.
9. Exactly one `LevelInfo` named `theLevelInfo`; uses `globalEnviromentMap` (one "n"),
   not `globalEnvironmentMap`.
10. Every `forest4.json` `type` resolves in `managedItemData.json`; `scale` is a
    scalar; files are NDJSON.
11. `TerrainBlock.terrainFile` points to an existing `.ter`; position centers the
    terrain (`x == y == -halfExtent`).
12. `supportsTraffic` true ⇔ nav graph (`map.json` segments or decal roads).
13. Any `MeshRoad` nodes have exactly 8 numeric values; any `DecalRoad` nodes have 4.

---

## 11. Open conformance issues (tracked for the improvement plan)

- **T3 — terrain size bounds:** RESOLVED for the upper bound — 16384 is
  author-verified in-game; the docs' 8192 is the editor-import limit, not the runtime
  loader limit. Optional: add a defensive 128 lower-bound guard (fixture-only edge
  case today).
- **Minimap:** DONE — `info.json.minimap` + `TerrainBlock.minimapImage` emitted,
  reusing the base color texture as the top-down tile (Rule I3).
- **groundModels:** DONE — `groundModels/mapng_groundmodels.json` shipped
  self-contained; the painter's OSM-driven terrain layers link to it via
  `groundmodelName` (Rule M3 / §7).
- **LevelInfo fidelity:** DONE — `decalBias`, `soundAmbience`, `soundDistanceModel`,
  `temperatureCurveC` added; `info.json` now carries `region` and
  `roadRules.turnOnRed` derived from country.
- **DecalData library:** road markings are already delivered by **DecalRoad line
  layers** (`line_center`/`line_left`/`line_right` using `m_line_white`/
  `m_line_yellow_double`), which is the doc-preferred mechanism — a separate
  DecalData *marking* library would be redundant and double up. The
  `managedDecalData.json` + `main.decals.json` scaffold remains valid for
  user-authored or future decorative decals (crosswalks, cracks, patches), which
  need bundled/generated decal textures.
- **Navigation depth:** `map.json` topology at dense junctions / ramp merges is basic.
