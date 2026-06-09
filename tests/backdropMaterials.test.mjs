import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBackdropMaterialDefs } from '../services/exportBeamNGLevel.js';

const LEVEL = 'mapng_demo';
const ALL_TILES = ['NW', 'N', 'NE', 'W', 'E', 'SW', 'S', 'SE'].map((p) => `backdrop_${p}`);

test('every referenced backdrop tile gets a material def (no NO TEXTURE)', () => {
  // Simulate a run where one tile (W) lost its satellite imagery, so the mesh
  // references backdrop_W but no texture was exported for it.
  const textureFiles = ALL_TILES
    .filter((name) => name !== 'backdrop_W')
    .map((name) => ({ name, ext: 'png', data: new Uint8Array() }));

  const defs = buildBackdropMaterialDefs(LEVEL, textureFiles, ALL_TILES);

  for (const name of ALL_TILES) {
    assert.ok(defs[name], `Expected a material def for ${name}`);
  }

  // The textured tiles reference their image; the failed tile falls back to a
  // flat ground color instead of a (missing) diffuseMap.
  assert.match(
    defs.backdrop_NE.Stages[0].diffuseMap,
    /terrain_backdrop\/Textures\/backdrop_NE\.png$/,
  );
  assert.equal(defs.backdrop_W.Stages[0].diffuseMap, undefined);
  assert.ok(Array.isArray(defs.backdrop_W.Stages[0].diffuseColor));
});

test('all-textured backdrop produces only textured materials', () => {
  const textureFiles = ALL_TILES.map((name) => ({ name, ext: 'png', data: new Uint8Array() }));
  const defs = buildBackdropMaterialDefs(LEVEL, textureFiles, ALL_TILES);

  assert.equal(Object.keys(defs).length, ALL_TILES.length);
  for (const name of ALL_TILES) {
    assert.ok(defs[name].Stages[0].diffuseMap, `${name} should be textured`);
  }
});

test('no reported material names falls back to a single backdrop_terrain def', () => {
  const defs = buildBackdropMaterialDefs(LEVEL, [], []);
  assert.deepEqual(Object.keys(defs), ['backdrop_terrain']);
  assert.ok(Array.isArray(defs.backdrop_terrain.Stages[0].diffuseColor));
});
