# BeamNG Export Workflow — Improvement Plan

Phased plan to bring the MapNG export fully in line with
`docs/beamng-level-export-guide.md` and the official docs, and to make the
pipeline more maintainable. Ordered by **risk-to-players first**, then fidelity,
then architecture.

Status legend: 🔴 correctness/conformance risk · 🟡 fidelity gap · 🟢 polish/arch.

---

## Phase A — Resolve the open conformance risks (🔴 do first)

These are the items the guide flags as unresolved; they can cause levels to fail
to load or render wrong.

1. **Terrain size ceiling (Rule T3).** `Terrain-Files.md` documents the heightmap
   import range as `[128, 8192]`, but MapNG exports terrain up to 16384.
   - Action: empirically verify whether the runtime `.ter` loader accepts 16384
     by loading a generated 16384 level in-game, and check `refs/base_game_content`
     for any vanilla terrain >8192.
   - If unsupported: cap the **terrain** dimension at 8192 in `computeBeamNGTerrainSize`
     while still allowing 16384 *textures* (base color / minimap) — decouple
     terrain-grid size from texture size.
   - If supported: document the evidence in the guide and relax the test ceiling.
   - Add an explicit lower-bound guard so sub-128 terrains can't be produced
     (today an 8×8 fixture exports without complaint).

2. **`.ter` version provenance (Rule T1).** The loader rejects `version > FILE_VERSION`.
   - Action: pin the written version to the value vanilla content ships for the
     targeted game build; add a short note in `exportTer.js` citing the
     `refs/base_game_content` file checked. The lockstep test already guards drift.

3. **Spawn / preview hard-coupling.** A mismatch silently yields no spawn.
   - Already covered by the new guide-conformance test; keep it green when the
     spawn naming is refactored.

---

## Phase B — Close fidelity gaps (🟡)

4. **Minimap generation.** Emit `minimap/terrain.png` + `info.json.minimap` +
   `TerrainBlock.minimapImage` instead of leaving it to the World Editor. The
   downscaled heightmap/base texture we already generate is most of the input.

5. **groundModels overrides (`Ground-Models.md`).** Emit `groundModels/*.json` so
   road/terrain surfaces have correct friction/physics, rather than relying on
   stock `GROUNDMODEL_ASPHALT1` for everything. Map OSM `surface=*` tags →
   ground models.

6. **DecalData library (`Decal-Data.md`).** Currently scaffold-only. Generate a
   real `managedDecalData.json` + `main.decals.json` for road markings/cracks
   where we already compute decal road geometry.

7. **Navigation depth (`Navigation-Map.md`).** Improve `map.json` topology at
   dense junctions and ramp merges (the conformance matrix's existing priority).

---

## Phase C — Architecture & maintainability (🟢)

`services/exportBeamNGLevel.js` is ~5,700 lines doing terrain, roads, signals,
forest, materials, DAE, and ZIP assembly in one module. This is the biggest
long-term risk to conformance because it makes targeted change hard.

8. **Split by artifact.** Extract cohesive modules behind small interfaces, each
   owning one guide section and its tests:
   - `export/terrain.js` (§3/§4 — .ter, terrain.json, TerrainBlock, materials)
   - `export/sceneTree.js` (§8/§9 — MissionGroup tree + main.level.json)
   - `export/roads.js` (§7 — decal/architect/mesh + map.json + signals)
   - `export/vegetation.js` (§5)
   - `export/meta.js` (§2 — info.json, sites, previews)
   - `exportBeamNGLevel.js` becomes the orchestrator that wires inputs → modules → ZIP.

9. **A single typed "LevelManifest" intermediate.** Build an in-memory manifest
   (terrain, materials[], objects[], files[]) from the app inputs, then have one
   serializer write the ZIP from it. Benefits: the conformance invariants (§10)
   can be checked on the manifest *before* serialization, and the manifest is
   trivially snapshot-testable.

10. **Promote the guide test to the manifest.** Once (9) exists, port
    `beamngExportGuideConformance.test.mjs` to assert against the manifest too,
    so violations are caught without round-tripping a ZIP.

---

## Phase D — Insights from the community Steam guide (🟡/🟢)

Derived from a power-user Steam guide (`refs/Steam-Community-Guide-MapNG.md`)
written by a modder who uses MapNG regularly. These are the friction points he
documents working *around* in the World Editor — each is a candidate to fix at
the source so users don't have to.

11. **Asphalt color won't match on user-added roads (🟡, biggest UX pain).
    ⛔ REVERTED — needs a different approach.** All terrain materials share one
    base-color texture, so painting asphalt onto a *new* road takes on whatever
    color (often grass-green) the base shows there.
    - First attempt gave the asphalt material its own dark base
      (`asphalt_base_b.png`). Two problems killed it: (a) the texture was 64² but
      the `TerrainMaterialTextureSet` requires 2048², so BeamNG mis-rendered the
      material; (b) even sized right, a solid dark independent base made the
      jagged per-pixel layer-map boundary high-contrast against the surroundings
      — "ink-blot" road edges. Reverted to sharing the terrain base.
    - Reassessment: MapNG's roads are **decal roads** (`DefaultDecalRoadMaterial`)
      drawn on top, which are already asphalt-colored regardless of terrain. The
      terrain asphalt material only shows where a user manually paints it without
      a decal — a narrow case not worth a road-wide visual regression.
    - If revisited: prefer the guide's Method 2 (bake the known OSM road mask into
      `terrain.png` darker) so existing roads' terrain color is right *and* edges
      keep blending, rather than an independent base. Lower priority.

12. **Textureless "default" terrain material next to roads (🟡). ✅ DONE
    (needs in-game eyes).** He found a flat, untextured `default` material
    hugging the roads that he had to delete or re-point at grass.
    - Done: `DefaultMaterial` (the unclassified catch-all, incl. the road-side
      band) now inherits the biome's primary ground surface — real
      detail/macro/normal/roughness + correct groundmodel — instead of neutral
      slots + asphalt physics (`osmTerrainMaterials.js`). Covered by an
      OSM/PBR-mode integration test. **Verify in-game:** confirm it blends with
      grass and doesn't look odd over satellite base textures.

13. **`ForestWindEmitter` not placed (🟢). ✅ DONE.** Trees don't react to wind
    because MapNG didn't emit a `ForestWindEmitter`; he added one manually via
    Create Object → Other classes.
    - Done: emit a global directional `ForestWindEmitter` in `vegetation`
      whenever forest is included (`exportBeamNGLevel.js`), covered by the
      integration test.

14. **Groundcover not lush + no wind (🟡). ✅ DONE.** He bumped grass
    `maxElements` and copied ECUSA wind settings to make grass lively.
    - Density was already addressed (dynamic `maxElements`, min 360k, 2× density
      multiplier). The remaining gap was wind: `mapng_grass_cover`/`_field` set
      `windTurbulenceFrequency` with no `windTurbulenceStrength` (and no
      `windGustFrequency`), so turbulence had zero amplitude and grass stood
      still. Added both fields (matched to the template-cover path); covered by
      the integration test.

15. **Decal-road node density at intersections (🟡).** Uneven node spacing
    causes texture stretching, and intersections need *denser* nodes to bend
    cleanly. The 2 m uniform resample (dfb9037) helps the straights; intersections
    still need densification + clean splits.
    - Action: densify nodes approaching intersections and ensure decal roads are
      split cleanly there. Overlaps with item 7 (navigation depth at junctions).

16. **Decal-road length limit drops texture on big maps (🟢). ✅ ALREADY
    MITIGATED.** Past a length the decal stops rendering; his fix was raising
    `Detail` or splitting the road.
    - Current code resamples road geometry to a uniform 2 m spacing (dfb9037)
      and `chunkPolyline` caps each DecalRoad at ~50 nodes (~100 m), well under
      the texture-drop length. `detail` is left at BeamNG's improved-spline
      default, which is fine for ~100 m chunks. No change needed unless a real
      level still shows the dropout — then set `detail`/split per-chunk.

17. **Start/end fade at MapNG-split joins (🟢). ✅ ALREADY ADDRESSED.** Where
    decal roads are split, start/end fade can make them fade at the join.
    - Verified: fade is gated to `isRoadStart`/`isRoadEnd` (the road's true
      termini) and never applied at internal chunk joins
      (`getLayeredRoadDecals` / `generateDecalRoads`). One thing to confirm
      in-game: adjacent segments meeting at an intersection each treat the shared
      end as a terminus, so the asphalt base layer (`startEndFadeMag: 4`) may
      fade slightly approaching intersections — fold this into item 15's
      intersection work if it reads as a gap.

18. **Backdrop is non-drivable with no edge protection (🟢).** He recommends
    placing signs/blockades at the terrain edge because the backdrop mesh isn't
    meant to be driven onto and doesn't transition cleanly.
    - Action (optional): place edge barriers at the map boundary, and/or improve
      the backdrop→terrain seam. Also consider backdrop LOD/decimation — he notes
      it inflates polycount on big maps.

---

## Suggested sequencing

- **Now:** Phase A (correctness). Small, high-value, test-backed.
- **Next:** Phase B items 4–6 (visible fidelity wins for users).
- **Then:** Phase C refactor, guarded the whole way by the existing 44-test suite
  + the new guide-conformance suite acting as a regression net.

Each phase keeps `npm run test:beamng` green; the guide
(`docs/beamng-level-export-guide.md`) is updated *before* the code in every step.
