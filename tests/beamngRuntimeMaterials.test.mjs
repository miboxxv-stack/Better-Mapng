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

test('every biome includes the shared catchfence barrier material with /assets textures', () => {
  for (const biome of BIOMES) {
    const defs = getBiomeRuntimeMaterialDefs(biome);
    const cf = defs.catchfence;
    assert.ok(cf, `biome "${biome}" is missing the catchfence material`);
    assert.equal(cf.mapTo, 'catchfence');
    const baseColor = cf.Stages?.[0]?.baseColorMap;
    assert.match(
      String(baseColor),
      /^\/assets\/materials\/.*catchfence.*\.png$/,
      `biome "${biome}" catchfence must use a shared /assets/ texture`,
    );
  }
});

test('getBiomeRuntimeMaterialDefs accepts a biome object with levelName', () => {
  const defs = getBiomeRuntimeMaterialDefs({ levelName: 'italy' });
  assert.ok(defs.catchfence, 'object form should resolve the same defs');
});
