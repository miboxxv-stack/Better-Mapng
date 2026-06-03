/**
 * Runtime material catalog conformance.
 *
 * The native barrier/object meshes MapNG emits for OSM barriers (guardrail,
 * jersey, screenfence) are biome-independent, so the materials they bind must be
 * present in every biome's runtime material defs. `catchfence` (bound by
 * screenfence1.dae) in particular has no global fallback — a biome missing it
 * makes the mesh fall back to a stale embedded texture and error in-game.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getBiomeRuntimeMaterialDefs } from '../services/beamngRuntimeMaterialCatalog.js';

// Biome ids the exporter maps (see BIOME_RUNTIME_MATERIAL_DEFS).
const BIOMES = [
  'east_coast_usa', 'hirochi_raceway', 'Industrial', 'industrial',
  'johnson_valley', 'jungle_rock_island', 'italy', 'mapng_template',
  'Utah', 'utah', 'automation_test_track',
  'unknown_biome_falls_back', // exercises the default path
];

// Shared barrier materials bound by the native barrier/fence meshes. Every
// biome must include each, with /assets/ textures.
const SHARED_BARRIER_MATERIALS = ['catchfence', 'chainlink'];

test('every biome includes the shared barrier materials with /assets textures', () => {
  for (const biome of BIOMES) {
    const defs = getBiomeRuntimeMaterialDefs(biome);
    for (const mat of SHARED_BARRIER_MATERIALS) {
      const def = defs[mat];
      assert.ok(def, `biome "${biome}" is missing the ${mat} material`);
      assert.equal(def.mapTo, mat);
      const baseColor = def.Stages?.[0]?.baseColorMap;
      assert.match(
        String(baseColor),
        /^\/assets\/materials\/.*\.png$/,
        `biome "${biome}" ${mat} must use a shared /assets/ texture`,
      );
    }
  }
});

test('getBiomeRuntimeMaterialDefs accepts a biome object with levelName', () => {
  const defs = getBiomeRuntimeMaterialDefs({ levelName: 'italy' });
  assert.ok(defs.catchfence, 'object form should resolve the same defs');
});
