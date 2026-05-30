import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import {
  getRequiredLevelFiles,
  validateBeamNGZipStructure,
} from './beamngExportConformance.js';

test('getRequiredLevelFiles returns core files', () => {
  const required = getRequiredLevelFiles();

  assert.ok(required.includes('info.json'));
  assert.ok(required.includes('signals.json'));
  assert.ok(required.includes('art/terrains/terrain.ter'));
  assert.ok(required.includes('main/MissionGroup/items.level.json'));
  assert.ok(required.includes('main.level.json'));
  assert.equal(required.includes('main/MissionGroup/roads/items.level.json'), false);
});

test('getRequiredLevelFiles includes conditional folders when enabled', () => {
  const required = getRequiredLevelFiles({
    requiresVegetation: true,
    requiresRoadGroups: true,
    requiresMeshRoads: true,
    requiresBarriers: true,
    requiresDecalRoads: true,
  });

  assert.ok(required.includes('main/MissionGroup/vegetation/items.level.json'));
  assert.ok(required.includes('main/MissionGroup/roads/items.level.json'));
  assert.ok(required.includes('main/MissionGroup/Mesh_roads/items.level.json'));
  assert.ok(required.includes('main/MissionGroup/barriers/items.level.json'));
  assert.ok(required.includes('main/MissionGroup/Decal_Roads/items.level.json'));
});

test('validateBeamNGZipStructure succeeds when all required files exist', () => {
  const zip = new JSZip();
  const base = 'levels/mapng_demo';

  for (const relativePath of getRequiredLevelFiles({
    requiresVegetation: true,
    requiresRoadGroups: true,
    requiresMeshRoads: true,
    requiresBarriers: true,
    requiresDecalRoads: true,
  })) {
    zip.file(`${base}/${relativePath}`, '{}');
  }

  assert.doesNotThrow(() => {
    validateBeamNGZipStructure(zip, base, {
      requiresVegetation: true,
      requiresRoadGroups: true,
      requiresMeshRoads: true,
      requiresBarriers: true,
      requiresDecalRoads: true,
    });
  });
});

test('validateBeamNGZipStructure throws and includes missing file paths', () => {
  const zip = new JSZip();
  const base = 'levels/mapng_demo';

  zip.file(`${base}/info.json`, '{}');

  assert.throws(
    () => validateBeamNGZipStructure(zip, base),
    /main\.level\.json/
  );
});
