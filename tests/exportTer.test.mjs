import test from 'node:test';
import assert from 'node:assert/strict';

import { exportTer } from '../services/exportTer.js';

/**
 * Parse a .ter binary per the official layout (Terrain-Files.md §Current saved layout):
 *   version(u8), size(u32), heightMap(u16[size²]), layerMap(u8[size²]),
 *   materialCount(u32), materialNames(length-prefixed strings).
 * Verified against the shipped small_island.ter (version 9, same layout).
 */
function parseTer(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const version = view.getUint8(offset); offset += 1;
  const size = view.getUint32(offset, true); offset += 4;
  const sampleCount = size * size;

  const heightMap = new Uint16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    heightMap[i] = view.getUint16(offset, true);
    offset += 2;
  }
  const layerMap = new Uint8Array(buffer, offset, sampleCount).slice();
  offset += sampleCount;

  const materialCount = view.getUint32(offset, true); offset += 4;
  const decoder = new TextDecoder();
  const materials = [];
  for (let i = 0; i < materialCount; i++) {
    let len = view.getUint8(offset); offset += 1;
    if (len === 0xFF) {
      len = view.getUint16(offset, true);
      offset += 2;
    }
    materials.push(decoder.decode(new Uint8Array(buffer, offset, len)));
    offset += len;
  }

  return { version, size, heightMap, layerMap, materials, bytesConsumed: offset };
}

function makeTerrain({ size = 8, minHeight = 100, maxHeight = 110.2 } = {}) {
  const heightMap = new Float32Array(size * size);
  for (let i = 0; i < heightMap.length; i++) {
    // Deterministic ramp covering the full [minHeight, maxHeight] range.
    heightMap[i] = minHeight + ((maxHeight - minHeight) * i) / (heightMap.length - 1);
  }
  return { width: size, height: size, heightMap, minHeight, maxHeight };
}

async function exportAndParse(terrainData, options) {
  const { blob } = await exportTer(terrainData, options);
  return parseTer(await blob.arrayBuffer());
}

test('.ter binary matches the official Terrain-Files.md layout exactly (no trailing bytes)', async () => {
  const terrain = makeTerrain({ size: 8 });
  const { blob } = await exportTer(terrain, { materialNames: ['Grass', 'asphalt_mapng'] });
  const buffer = await blob.arrayBuffer();
  const parsed = parseTer(buffer);

  assert.equal(parsed.version, 9, 'current terrain file version (matches official levels)');
  assert.equal(parsed.size, 8);
  assert.deepEqual(parsed.materials, ['Grass', 'asphalt_mapng']);
  assert.equal(parsed.bytesConsumed, buffer.byteLength,
    'file must contain exactly header + heightMap + layerMap + material names');
});

test('.ter heights round-trip through the TerrainBlock decode within one quantization step', async () => {
  // Non-integer elevation range: TerrainBlock.maxHeight = ceil(10.2) = 11.
  // BeamNG decodes heightMeters = stored × maxHeight / 65536 (Terrain-Files.md).
  const terrain = makeTerrain({ size: 8, minHeight: 100, maxHeight: 110.2 });
  const parsed = await exportAndParse(terrain);

  const blockMaxHeight = Math.max(1, Math.ceil(terrain.maxHeight - terrain.minHeight));
  assert.equal(blockMaxHeight, 11);
  const step = blockMaxHeight / 65536;

  const size = parsed.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // .ter row 0 is the south edge; source heightMap row 0 is the north edge.
      const stored = parsed.heightMap[(size - 1 - y) * size + x];
      const decoded = stored * (blockMaxHeight / 65536);
      const expected = terrain.heightMap[y * size + x] - terrain.minHeight;
      assert.ok(Math.abs(decoded - expected) <= step + 1e-9,
        `decoded height ${decoded} differs from source ${expected} by more than one step (${step}) at ${x},${y}`);
    }
  }
});

test('.ter peak height decodes to the true elevation range (no ceil() vertical exaggeration)', async () => {
  const terrain = makeTerrain({ size: 4, minHeight: 0, maxHeight: 50.4 });
  const parsed = await exportAndParse(terrain);
  const blockMaxHeight = 51;
  const peakStored = Math.max(...parsed.heightMap);
  const decodedPeak = peakStored * (blockMaxHeight / 65536);
  // Old behavior decoded the peak to ~51 m (stored 65535 against range 50.4).
  assert.ok(Math.abs(decodedPeak - 50.4) < 0.01,
    `peak must decode to ≈50.4 m, got ${decodedPeak}`);
});

test('.ter handles flat terrain (zero range) without NaN heights', async () => {
  const terrain = makeTerrain({ size: 4, minHeight: 25, maxHeight: 25 });
  const parsed = await exportAndParse(terrain);
  for (const stored of parsed.heightMap) assert.equal(stored, 0);
});

test('.ter layer map defaults to zeros and passes a custom layer map through unchanged', async () => {
  const terrain = makeTerrain({ size: 4 });

  const defaulted = await exportAndParse(terrain);
  assert.ok(defaulted.layerMap.every((v) => v === 0), 'default layer map must be all index 0');

  const layerMap = new Uint8Array(16).map((_, i) => (i % 2 === 0 ? 1 : 255)); // 255 = hole
  const custom = await exportAndParse(terrain, { layerMap, materialNames: ['a', 'b'] });
  assert.deepEqual([...custom.layerMap], [...layerMap]);
});

test('.ter truncates material lists beyond the documented 254-entry limit', async () => {
  const terrain = makeTerrain({ size: 4 });
  const names = Array.from({ length: 300 }, (_, i) => `mat_${i}`);
  const parsed = await exportAndParse(terrain, { materialNames: names });
  assert.equal(parsed.materials.length, 254,
    'layer map is u8 with 255 reserved for holes — at most 254 materials');
  assert.equal(parsed.materials[0], 'mat_0');
  assert.equal(parsed.materials[253], 'mat_253');
});
