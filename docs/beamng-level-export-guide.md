# BeamNG Level Export — Strict Workflow Guide (Source of Truth)

This document is the **authoritative specification** for how MapNG generates and
exports a programmatic BeamNG.drive level from app inputs (terrain heightmap, OSM
features, satellite/PBR textures, biome selection, user options).

It is grounded in the official documentation under
`refs/official_levels_documentation/` and the vanilla content under
`refs/base_game_content/`. Where the two disagree, the vanilla content wins
(docs are explicitly described as "incomplete and undergoing active development").

The export implementation (`services/exportBeamNGLevel.js`, `services/exportTer.js`,
`services/osmTerrainMaterials.js`, …) and the tests
(`tests/*.test.mjs`) MUST conform to this guide. When the guide and the code
disagree, that is a bug in one of them — reconcile, don't ignore.

The companion file `docs/beamng-export-conformance-matrix.md` tracks
per-artifact implementation status against this guide.

---

## 0. Terminology and coordinate conventions

| Term | Meaning |
| --- | --- |
| `size` | Terrain grid edge in samples. Square, power-of-two. |
| `squareSize` | Real-world meters between heightmap samples (`TerrainBlock.squareSize`). |
| `worldSize` | `size × squareSize`, the level's physical edge in meters. |
| `maxHeight` | Elevation range in meters that maps stored `u16` 0→65535. |
| `halfExtent` | `worldSize / 2`. Terrain is centered on world origin. |

**World axes (BeamNG):** `+X` = east, `+Y` = north, `+Z` = up. Terrain is centered
at the origin, so its SW corner is at `[-halfExtent, -halfExtent, 0]`.

**Heightmap orientation:** row 0 = north edge. The `.ter` writer is responsible
for any vertical flip required so that stored south-origin terrain matches the
`TerrainBlock` grid (see §3).

**Geo→world projection:** all geo-referenced placement (roads, objects, spawn,
terrain material layerMap) MUST use a single shared local-metric projection
(`createWGS84ToLocal(centerLat, centerLng)`) normalized by `squareSize × size`.
A naive linear lat/lng box-stretch is **forbidden** because it drifts from the
metric texture projection by ~cos(latitude) in X (this caused the historical
"grass over sidewalks" misalignment). See §6.

---

## 1. Level package layout (canonical)

A conformant export is a ZIP whose single top-level entry is `levels/<levelId>/`.
`<levelId>` is the sanitized, lowercased level name.

```
levels/<levelId>/
├── info.json                         # level metadata (§2)
├── main.level.json                   # legacy/compat monolithic entrypoint (§9)
├── terrain.terrain.json              # terrain metadata (§3)
├── map.json                          # navigation segments (§7)
├── signals.json                      # traffic signals (§7)
├── signalControllerDefinitions.json  # only if custom controllers used
├── city.sites.json                   # sites scaffold
├── main.decals.json                  # placed decals (scaffold ok)
├── main.forestbrushes4.json          # forest brushes (§5)
├── mainLevel.lua                     # level load hook
├── preview.png                       # thumbnail referenced by info.json
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
        ├── sky_and_sun/items.level.json        # LevelInfo, TimeOfDay, ScatterSky
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

**Rule L1 — `items.level.json` is NDJSON.** One complete JSON object per line.
Never a JSON array, never pretty-printed multi-line objects. (`Level-Object-Files.md`)

**Rule L2 — Recursive SimGroup folders.** Every `SimGroup` referenced in a parent
`items.level.json` MUST have a matching subfolder with its own `items.level.json`
(may be empty string for an empty group). (`Level-Object-Files.md`)

**Rule L3 — Every object has a valid `class`.** Invalid lines are silently
skipped by the loader, so a malformed object = a missing object.

---

## 2. info.json (`Level-Metadata.md` / `LevelInfo` metadata)

Required keys MapNG MUST emit:

- `title` (display name), `description`, `authors`
- `size`: `[worldSizeMeters, worldSizeMeters]`
- `defaultSpawnPointName`: MUST equal a `spawnPoints[].objectname` AND the
  `name` of a `SpawnSphere` in `PlayerDropPoints` (§8). Mismatch = no spawn.
- `previews`: `["preview.png"]` — the referenced file MUST exist (§1).
- `spawnPoints[]`: at least one, with `objectname`, `preview`, `translationId`.
- `roadRules.rightHandDrive`: from country/user; drives lane interpretation.
- `country`, `supportsTraffic`, `supportsTimeOfDay`.

**Rule I1 — Strict JSON.** No trailing commas anywhere (the loader rejects them).

**Rule I2 — `supportsTraffic` honesty.** Only `true` when the export actually
produces a navigable road graph (decal/architect/mesh with nav). Otherwise `false`.

**Rule I3 — `minimap` (optional, currently omitted).** If emitted, `file`/`size`/
`offset` must be in world units and the file must exist. MapNG currently leaves
minimap to the World Editor; `TerrainBlock.minimapImage` is `''`.

---

## 3. Terrain: `.ter` + `terrain.terrain.json` + TerrainBlock (`Terrain-Files.md`)

### 3.1 `.ter` binary (version 9 — but see Rule T1)

Sequential little-endian layout the engine reads:

| Step | Field | Type | Notes |
| --- | --- | --- | --- |
| 1 | `version` | `u8` | |
| 2 | `size` | `u32` | square edge |
| 3 | `heightMap` | `u16[size²]` | `stored = round((h − min)/(max − min) × 65535)` |
| 4 | `layerMap` | `u8[size²]` | material index per sample; `255` = hole |
| 5 | `materialCount` | `u32` | |
| 6 | `materialNames` | length-prefixed strings | order MUST match layerMap indices |

**Rule T1 — Version compatibility (OPEN CONFORMANCE ISSUE).** The docs state the
loader **fails** when `version > FILE_VERSION`, and that `version >= 7` uses the
modern path. MapNG writes the `.ter` first byte as `0x09` and `terrain.terrain.json`
`version: 9`. This matches the value vanilla `italy`/`west_coast_usa` ship, so it
is correct for current game builds — but the writer MUST keep the `.ter` first
byte and the `.terrain.json` `version` field **in lockstep**, and that value MUST
be verified against `refs/base_game_content` whenever the target game version
changes. Tests MUST assert byte0 of `.ter` == `terrain.terrain.json.version`.

**Rule T2 — Heightmap encoding is range-relative.** `maxHeight` MUST be the actual
elevation span (`max − min`, with a sane floor for flat terrain so `range > 0`).
The `TerrainBlock.position.z` carries the absolute base so world heights are correct.

**Rule T3 — Square, power-of-two, 128–8192.** The docs require terrain import size
in `[128, 8192]`, power-of-two, square. `computeBeamNGTerrainSize()` already
floors to a power of two. **OPEN ISSUE:** MapNG now exports up to 16384; the import
limit in the docs is 8192. Either (a) the runtime `.ter` loader tolerates >8192
(vanilla evidence needed), or (b) MapNG must cap the **terrain** dimension at 8192
and treat higher resolutions as texture-only. The guide REQUIRES this be resolved
explicitly, not left ambiguous (see Phase 4 plan).

**Rule T4 — layerMap/material order coupling.** `materialNames[i]` is the material
painted where `layerMap == i`. The PBR painter (`osmTerrainMaterials.js`) and the
material-name list passed to `exportTer` MUST be the same ordering. `255` only for
intentional holes (MapNG produces none → no `255`).

### 3.2 `terrain.terrain.json`

Descriptive metadata: `datafile`, `heightmapImage`, `size`, `heightMapSize`
(= size²), item sizes, `materials[]` (= the `.ter` material name list), `version`.

### 3.3 `TerrainBlock` (in `level_objects/items.level.json`)

```jsonc
{ "class":"TerrainBlock", "name":"theTerrain",
  "position":[-halfExtent,-halfExtent, baseZ],
  "squareSize":<m/sample>, "maxHeight":<range m>,
  "baseTexSize":size, "terrainFile":"/levels/<id>/art/terrains/terrain.ter",
  "materialTextureSet":<pbr set name | "">, "minimapImage":"" }
```

**Rule T5 — No object scale.** `TerrainBlock` scale is ignored by the engine; use
`squareSize`/`maxHeight`. (`Terrain-Files.md`)

---

## 4. Terrain materials (`art/terrains/main.materials.json`)

- With PBR painting: emit the painter's `TerrainMaterial` defs (DefaultMaterial =
  satellite base + OSM-derived overlays), `materialTextureSet`, and the matching
  `materialNames` ordering for the `.ter`.
- Without PBR: a single `DefaultMaterial` (`TerrainMaterial`) whose `diffuseMap`
  is `terrain.png`, with a `groundmodelName`.

**Rule M1 — ≤254 terrain materials.** `u8` layer indices, `255` reserved.
**Rule M2 — Resolvable names.** Every name in the `.ter` list MUST have a
`TerrainMaterial` def, or terrain renders as the warning material.

---

## 5. Vegetation (`Forest.md`, `Forest-Data-and.md`, `GroundCover.md`)

- Scene: a `Forest` object (`name:"theForest"`) in `vegetation/items.level.json`;
  `GroundCover` objects alongside it.
- Item types: `art/forest/managedItemData.json` — `ForestItemData` per tree/rock,
  each with `internalName` + `shapeFile`.
- Placements: `forest/*.forest4.json` — NDJSON of `{type,pos,rotationMatrix,scale}`.
- Brushes: `main.forestbrushes4.json` — a `ForestBrush`/`ForestBrushElement` per
  placed type plus a `ForestBrushGroup`.

**Rule V1 — type/placement coupling.** Every `.forest4.json` `type` MUST exist as
a `managedItemData.json` key, whose `shapeFile` MUST exist (bundled or `.link`).

---

## 6. Geo-referenced placement & terrain paint alignment

**Rule G1 — One projection.** Roads, OSM objects, spawn, water, AND the terrain
material `layerMap` MUST all map lat/lng→pixel/world through the SAME
`createWGS84ToLocal(centerLat, centerLng)` projection normalized by
`squareSize × size` (SW origin, northward Y). This guarantees painted materials
register with the base texture and with placed geometry. (Regression-tested by
the layerMap/texture alignment fix.)

**Rule G2 — Height sampling.** World Z for placed geometry uses bilinear
heightmap sampling (`geoToWorld`) so objects sit on the surface, not on
nearest-sample steps.

---

## 7. Roads, navigation, signals

- **Road modes:** `architect` (Road Architect session + groups), `mesh`
  (MeshRoad TSStatics), `decal` (DecalRoad objects), `none`.
- **`DecalRoad`** (`DecalRoad.md`): `nodes` = `[x,y,z,width]` quads; `material`,
  `textureLength`, `drivability`, `renderPriority`. Lane interpretation pairs with
  `info.json.roadRules.rightHandDrive`.
- **`map.json`** (`Navigation-Map.md`): manual `segments` with `nodes`,
  `oneWay`, `flipDirection`, `lanesLeft/Right`, `drivability`. Supplements the
  auto-graph built from DecalRoads/waypoints.
- **`signals.json`** (`Traffic-Signals.md`): OSM traffic-light/stop/give_way
  instances + controllers; `signalControllerDefinitions.json` only when custom
  controller types are referenced.

**Rule R1 — Nav honesty.** `info.json.supportsTraffic` true ⇔ a real nav graph is
produced. **Rule R2 — Names are stable.** Object names referenced by nav/sites
must be unique and stable.

---

## 8. Scene object tree (`main/MissionGroup/…`)

Root `main/items.level.json`:
```
{"class":"SimGroup","name":"MissionGroup", …}
```
`MissionGroup/items.level.json` declares child SimGroups (only those that have
content, except the always-present base groups). Each gets its own folder + file.

Always present: `sky_and_sun`, `level_objects`, `PlayerDropPoints`,
`AIWaypointsGroup`, `AIDecalWaypointsGroup`, `Water`.
Conditional: `vegetation`, `Mesh_roads`, `barriers`, `signs`, `roads`, `Decal_Roads`.

- `sky_and_sun`: exactly one `LevelInfo` named `theLevelInfo` (Rule §LevelInfo),
  one `TimeOfDay`, one `ScatterSky`, optional clouds.
- `level_objects`: the `TerrainBlock` + optional `TSStatic`s (osm_objects,
  terrain_backdrop, mapng_flag). TSStatic geometry is pre-placed in world space
  (`position:[0,0,0]`, identity rotation). `collisionType`/`decalType` per
  `TSStatic.md`.
- `PlayerDropPoints`: a `SpawnSphere` whose `name` == `info.json.defaultSpawnPointName`.

**Rule S1 — `theLevelInfo`.** Exactly one `LevelInfo` named `theLevelInfo`
(systems look it up by that literal name for gravity/cubemap). Use the engine
spelling `globalEnviromentMap` (one "n"). (`LevelInfo.md`)

---

## 9. `main.level.json` (compat entrypoint)

A single monolithic `SimGroup{name:"MissionGroup", childs:[…]}` mirroring the
folder tree, with `__parent` stripped. Kept for loaders that expect
`main.level.json` rather than the `main/` folder tree. Modern path is the folder
tree (§1, §8); this is a fallback.

---

## 10. Invariants checklist (what tests MUST enforce)

1. ZIP has exactly one `levels/<id>/` root; `<id>` sanitized/lowercase.
2. Every required file from `getRequiredLevelFiles()` exists (per road/veg mode).
3. All `*.items.level.json` are valid NDJSON; every line has a `class`.
4. Every `SimGroup` named in a parent file has a matching folder+file.
5. `.ter` byte0 == `terrain.terrain.json.version`; `size` is square pow2 in [128, …].
6. `.ter` `materialCount` == `materialNames.length` == `terrain.terrain.json.materials.length`.
7. `info.json` parses, no trailing commas; `defaultSpawnPointName` matches both a
   `spawnPoints[].objectname` and a `SpawnSphere.name`.
8. `info.json.previews[0]` file exists in the ZIP.
9. Exactly one `LevelInfo` named `theLevelInfo`; uses `globalEnviromentMap`.
10. Every `forest4.json` `type` resolves in `managedItemData.json`.
11. `TerrainBlock.terrainFile` points to an existing `.ter`; position centers the
    terrain (`[-halfExtent,-halfExtent,*]`).
12. `supportsTraffic` true ⇔ nav graph (map.json segments or decal/architect/mesh roads).

---

## Open conformance issues (tracked for Phase 4)

- **T1/T3:** terrain `version` byte must be vanilla-verified per game build; 16384
  terrain export exceeds the documented 8192 import ceiling — resolve cap vs.
  texture-only.
- Minimap generation (info.json `minimap` + `TerrainBlock.minimapImage`) not emitted.
- groundModels, prefabs, datablocks: not emitted (roadmap).
- DecalData library: scaffold only.
