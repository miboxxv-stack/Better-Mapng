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

## Suggested sequencing

- **Now:** Phase A (correctness). Small, high-value, test-backed.
- **Next:** Phase B items 4–6 (visible fidelity wins for users).
- **Then:** Phase C refactor, guarded the whole way by the existing 44-test suite
  + the new guide-conformance suite acting as a regression net.

Each phase keeps `npm run test:beamng` green; the guide
(`docs/beamng-level-export-guide.md`) is updated *before* the code in every step.
