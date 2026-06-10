import test from 'node:test';
import assert from 'node:assert/strict';

import { smoothRoadsInHeightmap } from '../services/roadSmoother.js';

const W = 256;
const H = 256;
const CENTER_LAT = 47.0;
const CENTER_LNG = 8.0;

function makeBounds(widthPx, heightPx, mpp) {
  const halfWidthM = (widthPx * mpp) / 2;
  const halfHeightM = (heightPx * mpp) / 2;
  const dLat = halfHeightM / 111320;
  const dLng = halfWidthM / (111320 * Math.cos((CENTER_LAT * Math.PI) / 180));
  return {
    north: CENTER_LAT + dLat,
    south: CENTER_LAT - dLat,
    east: CENTER_LNG + dLng,
    west: CENTER_LNG - dLng,
  };
}

// Inverse of the metric projector's (approximately linear) pixel mapping.
function lngAtPx(bounds, x) {
  return bounds.west + (x / (W - 1)) * (bounds.east - bounds.west);
}
function latAtPy(bounds, y) {
  return bounds.north - (y / (H - 1)) * (bounds.north - bounds.south);
}

// Stair-stepped slope along +x: 1 m riser every 30 m — the quantized-DEM
// pattern the smoother exists to remove.
function makeStairHeightmap(mpp) {
  const hm = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      hm[y * W + x] = Math.floor((x * mpp) / 30);
    }
  }
  return hm;
}

function maxAdjacentDiffAlongRow(hm, row, xFrom, xTo) {
  let maxDiff = 0;
  for (let x = xFrom; x < xTo; x++) {
    maxDiff = Math.max(maxDiff, Math.abs(hm[row * W + x + 1] - hm[row * W + x]));
  }
  return maxDiff;
}

function maxAdjacentDiffAlongCol(hm, col, yFrom, yTo) {
  let maxDiff = 0;
  for (let y = yFrom; y < yTo; y++) {
    maxDiff = Math.max(maxDiff, Math.abs(hm[(y + 1) * W + col] - hm[y * W + col]));
  }
  return maxDiff;
}

test('removes DEM stair-steps along a straight road', () => {
  const mpp = 2;
  const bounds = makeBounds(W, H, mpp);
  const hm = makeStairHeightmap(mpp);
  const raw = hm.slice();

  const road = {
    type: 'road',
    id: 'a',
    tags: { highway: 'residential' },
    geometry: [
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 20) },
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 235) },
    ],
  };

  smoothRoadsInHeightmap(hm, W, H, bounds, [road], mpp, false, true);

  // Center row (the road runs along y≈127.5; row 127 is inside the flat core).
  const rawMax = maxAdjacentDiffAlongRow(raw, 127, 40, 215);
  const smoothMax = maxAdjacentDiffAlongRow(hm, 127, 40, 215);
  assert.equal(rawMax, 1, 'fixture should contain 1 m risers');
  assert.ok(
    smoothMax < 0.2,
    `road profile should be smooth (max adjacent diff ${smoothMax.toFixed(3)} m, raw ${rawMax} m)`,
  );

  // Sanity: the smoother actually rewrote the road corridor.
  let changed = 0;
  for (let x = 40; x <= 215; x++) {
    if (Math.abs(hm[127 * W + x] - raw[127 * W + x]) > 0.05) changed++;
  }
  assert.ok(changed > 20, `expected the corridor to be modified (changed=${changed})`);
});

test('crossing roads stay continuous through the junction', () => {
  const mpp = 2;
  const bounds = makeBounds(W, H, mpp);
  const hm = makeStairHeightmap(mpp);

  // Both ways share the exact center node, like OSM intersections do.
  const roadA = {
    type: 'road',
    id: 'a',
    tags: { highway: 'residential' },
    geometry: [
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 20) },
      { lat: CENTER_LAT, lng: CENTER_LNG },
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 235) },
    ],
  };
  const roadB = {
    type: 'road',
    id: 'b',
    tags: { highway: 'residential' },
    geometry: [
      { lat: latAtPy(bounds, 235), lng: CENTER_LNG },
      { lat: CENTER_LAT, lng: CENTER_LNG },
      { lat: latAtPy(bounds, 20), lng: CENTER_LNG },
    ],
  };

  smoothRoadsInHeightmap(hm, W, H, bounds, [roadA, roadB], mpp, false, true);

  // Walk each road's core straight through the junction: no vertical crease.
  const alongA = maxAdjacentDiffAlongRow(hm, 127, 40, 215);
  const alongB = maxAdjacentDiffAlongCol(hm, 127, 40, 215);
  assert.ok(alongA < 0.25, `road A should be continuous through the junction (max diff ${alongA.toFixed(3)} m)`);
  assert.ok(alongB < 0.25, `road B should be continuous through the junction (max diff ${alongB.toFixed(3)} m)`);

  // The two roads must agree on the junction elevation itself: compare the
  // terrain a few metres out along each arm against the junction pixel.
  const cz = hm[127 * W + 127];
  const alongANear = hm[127 * W + 122];
  const alongBNear = hm[122 * W + 127];
  assert.ok(Math.abs(alongANear - cz) < 0.5, `road A approach disagrees with junction (${Math.abs(alongANear - cz).toFixed(3)} m)`);
  assert.ok(Math.abs(alongBNear - cz) < 0.5, `road B approach disagrees with junction (${Math.abs(alongBNear - cz).toFixed(3)} m)`);
});

test('bridges and elevated roads leave the heightmap untouched', () => {
  const mpp = 2;
  const bounds = makeBounds(W, H, mpp);
  const hm = makeStairHeightmap(mpp);
  const raw = hm.slice();

  const bridge = {
    type: 'road',
    id: 'br',
    tags: { highway: 'primary', bridge: 'yes' },
    geometry: [
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 20) },
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 235) },
    ],
  };

  smoothRoadsInHeightmap(hm, W, H, bounds, [bridge], mpp, false, true);
  assert.deepEqual(hm, raw);
});

test('levelRoads flattens the cross-section; delta mode preserves it', () => {
  const mpp = 1;
  const bounds = makeBounds(W, H, mpp);
  // Constant transverse slope (along y); flat along the road direction (x).
  const makeSlope = () => {
    const hm = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) hm[y * W + x] = y * 0.5;
    }
    return hm;
  };
  const road = {
    type: 'road',
    id: 'a',
    tags: { highway: 'residential' },
    geometry: [
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 20) },
      { lat: CENTER_LAT, lng: lngAtPx(bounds, 235) },
    ],
  };

  // levelRoads=true: zero transverse tilt within the road core.
  const leveled = makeSlope();
  smoothRoadsInHeightmap(leveled, W, H, bounds, [road], mpp, false, true);
  for (let x = 40; x <= 215; x += 5) {
    const tilt = Math.abs(leveled[126 * W + x] - leveled[129 * W + x]);
    assert.ok(tilt < 0.02, `expected flat cross-section at x=${x} (tilt ${tilt.toFixed(3)} m)`);
  }

  // levelRoads=false: the longitudinal profile is already flat, so the delta
  // is ~0 and the original transverse slope must survive.
  const delta = makeSlope();
  const rawSlope = makeSlope();
  smoothRoadsInHeightmap(delta, W, H, bounds, [road], mpp, true, false);
  let maxChange = 0;
  for (let i = 0; i < delta.length; i++) {
    maxChange = Math.max(maxChange, Math.abs(delta[i] - rawSlope[i]));
  }
  assert.ok(maxChange < 0.05, `delta mode should not reshape flat-profile terrain (max change ${maxChange.toFixed(3)} m)`);
});
