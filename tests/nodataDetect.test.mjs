import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectNoDataInRaster,
  reconcileTileNoData,
  resolveNoDataValue,
  NODATA_AUTO,
  NODATA_NONE,
} from '../services/nodataDetect.js';

// Deterministic pseudo-random so a flaky threshold can never hide here.
const makeRandom = (seed = 42) => {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
};

const build = (count, fn) => {
  const raster = new Float32Array(count);
  for (let i = 0; i < count; i++) raster[i] = fn(i);
  return raster;
};

const N = 200 * 200;

test('an explicit GDAL_NODATA tag is never second-guessed', () => {
  // 33% of this raster is 0.0 and would otherwise be detected as fill.
  const raster = build(N, (i) => (i % 3 === 0 ? 0 : 300 + (i % 900)));
  const result = detectNoDataInRaster(raster, { taggedNoData: -32767 });
  assert.equal(result.value, -32767);
  assert.equal(result.source, 'tag');
});

test('detects the untagged 0.0 fill that hoydedata.no ships', () => {
  // Shape of a Kartverket DTM tile clipped to a survey polygon: fill outside,
  // 300-1500 m of Norwegian mountain inside, no GDAL_NODATA tag.
  const rnd = makeRandom();
  const raster = build(N, (i) => (i % 5 < 2 ? 0 : 300 + rnd() * 1200));
  const result = detectNoDataInRaster(raster);
  assert.equal(result.value, 0);
  assert.equal(result.source, 'detected');
  assert.equal(result.reason, 'isolated-spike');
  assert.ok(Math.abs(result.share - 0.4) < 0.01, `share was ${result.share}`);
});

test('detects sentinel fills that cannot be elevations, even when rare', () => {
  for (const sentinel of [-9999, -32767, -32768, -3.4028234663852886e38]) {
    const rnd = makeRandom();
    // 0.2% of the raster — below the threshold a plausible value would need.
    const raster = build(N, (i) => (i % 500 === 0 ? sentinel : 200 + rnd() * 500));
    const result = detectNoDataInRaster(raster);
    assert.equal(result.value, sentinel, `sentinel ${sentinel} not detected`);
    assert.equal(result.reason, 'implausible');
  }
});

test('leaves a real coastline at 0 m alone', () => {
  // Sea at exactly 0, then a beach ramping up through 0.1, 0.2, 0.3 m — the
  // populated neighbourhood is what separates real water from a fill constant.
  const rnd = makeRandom();
  const raster = build(N, (i) => {
    const x = (i % 200) / 200;
    return x < 0.35 ? 0 : (x - 0.35) * 120 + rnd() * 0.4;
  });
  const result = detectNoDataInRaster(raster);
  assert.equal(result.value, null);
  assert.equal(result.candidate, 0);
  assert.equal(result.rejectedBecause, 'has-neighbours');
});

test('leaves a lake plateau in the middle of the elevation range alone', () => {
  const rnd = makeRandom();
  const raster = build(N, (i) => {
    const x = (i % 200) / 200;
    return (x > 0.4 && x < 0.6) ? 143.2 : 100 + x * 100 + rnd() * 2;
  });
  const result = detectNoDataInRaster(raster);
  assert.equal(result.value, null);
  assert.equal(result.rejectedBecause, 'interior-value');
});

test('leaves an integer-quantised lowland DEM alone', () => {
  // Every value repeats heavily here, so exact-repeat counts prove nothing.
  const rnd = makeRandom();
  const raster = build(N, () => Math.round(rnd() * 40));
  assert.equal(detectNoDataInRaster(raster).value, null);
});

test('consensus applies the agreed fill value to tiles that detected nothing', () => {
  const rnd = makeRandom();
  const filled = detectNoDataInRaster(build(N, (i) => (i % 5 < 2 ? 0 : 300 + rnd() * 1200)));
  const interior = detectNoDataInRaster(build(N, () => 300 + rnd() * 1200));
  assert.equal(interior.value, null, 'tile fully inside the survey detects nothing');

  const consensus = reconcileTileNoData([filled, interior, filled]);
  assert.equal(consensus.value, 0);
  assert.equal(consensus.source, 'detected');
  assert.equal(consensus.tileCount, 2);
  assert.equal(consensus.totalTiles, 3);
});

test('a tagged tile outvotes detection across the upload', () => {
  const rnd = makeRandom();
  const detected = detectNoDataInRaster(build(N, (i) => (i % 5 < 2 ? 0 : 300 + rnd() * 1200)));
  const tagged = detectNoDataInRaster(new Float32Array([1, 2, 3]), { taggedNoData: -9999 });
  assert.equal(reconcileTileNoData([detected, tagged]).value, -9999);
});

test('a fully filled tile agrees with a consensus but never sets one', () => {
  const uniform = detectNoDataInRaster(new Float32Array(N)); // all zeros
  assert.equal(uniform.reason, 'uniform');
  // Alone it still yields a value — a tile that is nothing but fill is fill.
  assert.equal(reconcileTileNoData([uniform]).value, 0);

  const rnd = makeRandom();
  const other = detectNoDataInRaster(build(N, (i) => (i % 4 === 0 ? -9999 : 50 + rnd() * 20)));
  // Against a confident tile it does not drag the consensus to its own value.
  assert.equal(reconcileTileNoData([uniform, other]).value, -9999);
});

test('the override decides what the pipeline actually masks', () => {
  const detection = { value: 0, source: 'detected', share: 0.4 };
  assert.equal(resolveNoDataValue(detection, NODATA_AUTO), 0);
  assert.equal(resolveNoDataValue(detection, NODATA_NONE), null);
  assert.equal(resolveNoDataValue(detection, '-9999'), -9999);
  assert.equal(resolveNoDataValue(detection, -32767), -32767);
  // Garbage in the custom box falls back to what was detected.
  assert.equal(resolveNoDataValue(detection, 'abc'), 0);
  assert.equal(resolveNoDataValue(null, NODATA_AUTO), null);
});

test('empty and all-NaN rasters report nothing rather than throwing', () => {
  assert.equal(detectNoDataInRaster(new Float32Array(0)).value, null);
  assert.equal(detectNoDataInRaster(null).value, null);
  assert.equal(detectNoDataInRaster(build(1000, () => NaN)).value, null);
});
