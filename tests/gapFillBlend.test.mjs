import test from 'node:test';
import assert from 'node:assert/strict';

// The resampler runs as a module worker; give it the globals it expects at
// import time so the blending maths can be exercised directly.
globalThis.self = { postMessage: () => {}, onmessage: null };
const { blendGapFillIntoHoles } = await import('../services/resamplerWorker.js');

import {
  groupTilesIntoLayers,
  applyLayerOrder,
  assignLayerIndices,
  surveyKeyFromFileName,
} from '../services/elevationLayers.js';

const NO_DATA = -99999;

/**
 * Build a primary surface with a rectangular hole in it, plus a fallback that
 * describes the same terrain but sits `offset` metres away on a different datum.
 */
const makeCase = ({ width = 64, height = 64, offset = 12, hole }) => {
  const truth = (x, y) => 100 + x * 0.5 + y * 0.25 + 6 * Math.sin(x / 7);
  const heightMap = new Float32Array(width * height);
  const fillMap = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const inHole = x >= hole.x0 && x <= hole.x1 && y >= hole.y0 && y <= hole.y1;
      heightMap[idx] = inHole ? NO_DATA : truth(x, y);
      // The fallback covers everything, offset by a constant datum difference.
      fillMap[idx] = truth(x, y) - offset;
    }
  }
  return { heightMap, fillMap, width, height, truth };
};

const maxAdjacentStep = (map, width, height) => {
  let max = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const step = Math.abs(map[y * width + x] - map[y * width + x - 1]);
      if (step > max) max = step;
    }
  }
  return max;
};

test('a datum offset is removed instead of pasted in as a cliff', () => {
  const offset = 12;
  const { heightMap, fillMap, width, height } = makeCase({
    offset,
    hole: { x0: 20, x1: 43, y0: 20, y1: 43 },
  });

  // What a naive paste would look like: a 12 m wall around the whole patch.
  const naive = new Float32Array(heightMap);
  for (let i = 0; i < naive.length; i++) {
    if (naive[i] === NO_DATA) naive[i] = fillMap[i];
  }
  assert.ok(maxAdjacentStep(naive, width, height) > offset * 0.9,
    'the naive paste should show the full offset as a step');

  const result = blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);
  assert.equal(result.holes, 24 * 24);
  assert.equal(result.filled, 24 * 24);
  assert.ok(result.seamPixels > 0);
  assert.ok(Math.abs(result.meanDelta - offset) < 0.5, `measured offset ${result.meanDelta}`);

  // Nothing is left empty, and no seam survives.
  assert.equal(heightMap.filter((v) => v === NO_DATA).length, 0);
  assert.ok(maxAdjacentStep(heightMap, width, height) < 2,
    `blended surface still has a step of ${maxAdjacentStep(heightMap, width, height)} m`);
});

test('patched terrain lands within a metre of the true surface', () => {
  const { heightMap, fillMap, width, height, truth } = makeCase({
    offset: 30,
    hole: { x0: 24, x1: 39, y0: 24, y1: 39 },
  });
  blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);

  let worst = 0;
  for (let y = 24; y <= 39; y++) {
    for (let x = 24; x <= 39; x++) {
      worst = Math.max(worst, Math.abs(heightMap[y * width + x] - truth(x, y)));
    }
  }
  assert.ok(worst < 1, `worst error in the patch was ${worst.toFixed(3)} m`);
});

test('real data outside the seam band is left alone', () => {
  const { heightMap, fillMap, width, height, truth } = makeCase({
    offset: 8,
    hole: { x0: 28, x1: 35, y0: 28, y1: 35 },
  });
  blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);

  // Corner far from the hole: untouched to the last bit.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      assert.equal(heightMap[y * width + x], Math.fround(truth(x, y)));
    }
  }
});

test('a varying offset is followed across the gap, not averaged flat', () => {
  // Left and right sides of the hole disagree by 20 m; the patch has to ramp.
  const width = 64;
  const height = 16;
  const heightMap = new Float32Array(width * height);
  const fillMap = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const inHole = x >= 24 && x <= 39;
      const offset = x < 32 ? 0 : 20;
      heightMap[idx] = inHole ? NO_DATA : 200 + offset;
      fillMap[idx] = 200;
    }
  }
  blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);
  const row = 8 * width;
  assert.ok(heightMap[row + 25] < heightMap[row + 38], 'the patch should ramp between the two offsets');
  assert.ok(heightMap[row + 25] < 205, `left edge should track the near-zero offset, got ${heightMap[row + 25]}`);
  assert.ok(heightMap[row + 38] > 214, `right edge should track the 20 m offset, got ${heightMap[row + 38]}`);
});

test('pixels the fallback cannot reach are left for the inpainter', () => {
  const { heightMap, fillMap, width, height } = makeCase({
    offset: 5,
    hole: { x0: 10, x1: 50, y0: 10, y1: 50 },
  });
  // Punch a blind spot in the fallback too.
  for (let y = 20; y <= 25; y++) {
    for (let x = 20; x <= 25; x++) fillMap[y * width + x] = NO_DATA;
  }
  const result = blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);
  assert.equal(result.holes - result.filled, 36);
  assert.equal(heightMap.filter((v) => v === NO_DATA).length, 36);
});

test('with no primary data at all the fallback is used as-is', () => {
  const width = 16;
  const height = 16;
  const heightMap = new Float32Array(width * height).fill(NO_DATA);
  const fillMap = new Float32Array(width * height).map((_, i) => 50 + i);
  const result = blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA);
  assert.equal(result.filled, width * height);
  assert.equal(result.seamPixels, 0);
  assert.equal(heightMap[0], 50);
  assert.equal(heightMap[255], 305);
});

test('a surface with no holes is left untouched', () => {
  const width = 8;
  const height = 8;
  const heightMap = new Float32Array(width * height).fill(42);
  const fillMap = new Float32Array(width * height).fill(0);
  assert.equal(blendGapFillIntoHoles(heightMap, fillMap, width, height, NO_DATA), null);
  assert.ok(heightMap.every((v) => v === 42));
});

// ─── Layer stack ────────────────────────────────────────────────────────────

test('Kartverket tile names resolve to their survey', () => {
  assert.equal(
    surveyKeyFromFileName('NDH Norddal-Rauma 2pkt 2020-32-1-489-192-16-dtm.tif'),
    'NDH Norddal-Rauma 2pkt 2020',
  );
  assert.equal(
    surveyKeyFromFileName('Molde Aukra Fræna og Rauma 2014-32-1-489-192-13-dtm.tif'),
    'Molde Aukra Fræna og Rauma 2014',
  );
  // The product suffix goes even without tile indices behind it.
  assert.equal(surveyKeyFromFileName('bristol_dem.tif'), 'bristol');
  // Nothing recognisable: the whole stem stands as its own key.
  assert.equal(surveyKeyFromFileName('heightmap.tif'), 'heightmap');
});

test('surveys become layers, newest first', () => {
  const files = [
    'Molde Aukra Fræna og Rauma 2014-32-1-489-192-13-dtm.tif',
    'NDH Rauma sør-Norddal øst 2pkt 2019-32-1-489-192-26-dtm.tif',
    'NDH Norddal-Rauma 2pkt 2020-32-1-489-192-16-dtm.tif',
    'NDH Norddal-Rauma 2pkt 2020-32-1-489-192-17-dtm.tif',
  ];
  const layers = groupTilesIntoLayers(files.map((fileName) => ({ fileName })));
  assert.deepEqual(layers.map((l) => l.year), [2020, 2019, 2014]);
  assert.deepEqual(layers.map((l) => l.indices), [[2, 3], [1], [0]]);
});

test('filenames with no shared structure stay a single layer', () => {
  const files = ['alpha.tif', 'beta.tif', 'gamma.tif'];
  const layers = groupTilesIntoLayers(files.map((fileName) => ({ fileName })));
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].indices, [0, 1, 2]);
});

test('a user ordering wins, and stale ids never hide a layer', () => {
  const layers = [
    { id: 'a', indices: [0] },
    { id: 'b', indices: [1] },
    { id: 'c', indices: [2] },
  ];
  assert.deepEqual(applyLayerOrder(layers, ['c', 'a', 'b']).map((l) => l.id), ['c', 'a', 'b']);
  // 'z' is gone and 'b' was not mentioned — 'b' keeps its detected position.
  assert.deepEqual(applyLayerOrder(layers, ['z', 'c']).map((l) => l.id), ['c', 'a', 'b']);
  assert.deepEqual(applyLayerOrder(layers, null).map((l) => l.id), ['a', 'b', 'c']);
});

test('layer indices reach the tiles the worker will stack', () => {
  const entries = [{ fileName: 'old.tif' }, { fileName: 'new.tif' }];
  const layers = [{ id: 'new', indices: [1] }, { id: 'old', indices: [0] }];
  const tagged = assignLayerIndices(entries, layers);
  assert.equal(tagged[1].layerIndex, 0, 'the first layer is the base');
  assert.equal(tagged[0].layerIndex, 1);
});
