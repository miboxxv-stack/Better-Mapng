import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { generateJunctionMarkingDecals } from '../services/exportBeamNGLevel.js';

const W = 256;
const SQUARE_SIZE = 2; // 512 m world
const CENTER_LAT = 30.0;
const CENTER_LNG = -81.5;

function makeTerrainData(osmFeatures) {
  const halfM = (W * SQUARE_SIZE) / 2;
  const dLat = halfM / 111320;
  const dLng = halfM / (111320 * Math.cos((CENTER_LAT * Math.PI) / 180));
  return {
    width: W,
    height: W,
    heightMap: new Float32Array(W * W).fill(5),
    minHeight: 5,
    bounds: {
      north: CENTER_LAT + dLat,
      south: CENTER_LAT - dLat,
      east: CENTER_LNG + dLng,
      west: CENTER_LNG - dLng,
    },
    osmFeatures,
  };
}

const point = (lat, lng, tags) => ({ id: 'n1', type: 'poi', geometry: [{ lat, lng }], tags });

test('stop node paints a bar on the approach half; crossing paints two lines', () => {
  const lat = CENTER_LAT;
  const dLng = 0.001; // ~96 m steps along x
  const road = {
    id: 'w1', type: 'road',
    tags: { highway: 'residential' },
    geometry: [-2, -1, 0, 1, 2].map((k) => ({ lat, lng: CENTER_LNG + k * dLng })),
  };
  const stop = point(lat, CENTER_LNG + dLng, { highway: 'stop', direction: 'forward' });
  const crossing = point(lat, CENTER_LNG - dLng, { highway: 'crossing', crossing: 'marked' });

  const decals = generateJunctionMarkingDecals(makeTerrainData([road, stop, crossing]), SQUARE_SIZE);

  const bars = decals.filter((d) => d.name.startsWith('jm_stopline'));
  const cw = decals.filter((d) => d.name.startsWith('jm_crosswalk'));
  assert.equal(bars.length, 1);
  assert.equal(cw.length, 2, 'transverse crosswalk = two lines');

  const bar = bars[0];
  assert.equal(bar.class, 'DecalRoad');
  assert.equal(bar.material, 'm_line_white');
  assert.equal(bar.nodes.length, 2);
  assert.equal(bar.nodes[0][3], 0.45, 'stop bar thickness');
  // Road runs west→east; forward approach right side is south (negative world Y).
  assert.ok(bar.nodes.every((n) => n[1] <= 0.01), 'bar on the approach (south) half');
  const span = Math.hypot(bar.nodes[1][0] - bar.nodes[0][0], bar.nodes[1][1] - bar.nodes[0][1]);
  assert.ok(span > 1 && span < 4, `bar spans the approach lanes (got ${span.toFixed(2)} m)`);

  // Crosswalk lines are perpendicular to the road (constant x per line) and
  // straddle the crossing node 2.4 m apart along it.
  const xs = cw.map((d) => (d.nodes[0][0] + d.nodes[1][0]) / 2).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1] - xs[0] - 2.4) < 0.05, `lines 2.4 m apart (got ${(xs[1] - xs[0]).toFixed(2)})`);
});

test('markings at shared junction nodes and unmarked crossings are skipped', () => {
  const lat = CENTER_LAT;
  const dLng = 0.001;
  const dLat = 0.001;
  const roadA = {
    id: 'wa', type: 'road', tags: { highway: 'residential' },
    geometry: [-1, 0, 1].map((k) => ({ lat, lng: CENTER_LNG + k * dLng })),
  };
  const roadB = {
    id: 'wb', type: 'road', tags: { highway: 'residential' },
    geometry: [-1, 0, 1].map((k) => ({ lat: lat + k * dLat, lng: CENTER_LNG })),
  };
  // Signal mapped on the junction node itself (old-style mapping) → skip.
  const junctionSignal = point(lat, CENTER_LNG, { highway: 'traffic_signals' });
  // Unmarked crossing → skip.
  const unmarked = point(lat, CENTER_LNG + dLng, { highway: 'crossing', crossing: 'unmarked' });

  const decals = generateJunctionMarkingDecals(
    makeTerrainData([roadA, roadB, junctionSignal, unmarked]),
    SQUARE_SIZE,
  );
  assert.equal(decals.length, 0);
});

// Smoke test against the real West Positano Avenue OSM snapshot when present
// (refs/ is gitignored, so skip cleanly elsewhere).
const GEOJSON = new URL('../refs/mapng_exports/osm_features_29.9573_-81.4904.geojson', import.meta.url);
test('real-world OSM snapshot produces plausible junction markings', { skip: !fs.existsSync(GEOJSON) }, () => {
  const g = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
  const features = [];
  for (const f of g.features) {
    const p = f.properties || {};
    const tags = { ...p };
    delete tags._mapngType;
    delete tags._mapngId;
    const geomType = f.geometry?.type;
    if (geomType === 'Point') {
      const [lng, lat] = f.geometry.coordinates;
      features.push({ id: p._mapngId, type: p._mapngType || 'poi', geometry: [{ lat, lng }], tags });
    } else if (geomType === 'LineString') {
      features.push({
        id: p._mapngId,
        type: p._mapngType || (tags.highway ? 'road' : 'other'),
        geometry: f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
        tags,
      });
    }
  }
  const lats = features.flatMap((f) => f.geometry.map((pt) => pt.lat));
  const lngs = features.flatMap((f) => f.geometry.map((pt) => pt.lng));
  const bounds = {
    north: Math.max(...lats), south: Math.min(...lats),
    east: Math.max(...lngs), west: Math.min(...lngs),
  };
  const terrainData = {
    width: 1024, height: 1024,
    heightMap: new Float32Array(1024 * 1024).fill(3),
    minHeight: 3,
    bounds,
    osmFeatures: features,
  };

  const decals = generateJunctionMarkingDecals(terrainData, 8);
  const bars = decals.filter((d) => d.name.startsWith('jm_stopline')).length;
  const cwLines = decals.filter((d) => d.name.startsWith('jm_crosswalk')).length;
  console.log(`  west positano snapshot: ${bars} stop bars, ${cwLines / 2} crosswalks`);
  // 103 stop + 17 signal nodes and 192 crossing-ish features in the snapshot;
  // a healthy fraction must land on road vertices and produce decals.
  assert.ok(bars > 40, `expected >40 stop bars, got ${bars}`);
  assert.ok(cwLines >= 2, `expected some crosswalk lines, got ${cwLines}`);
  for (const d of decals) {
    assert.ok(d.nodes.every((n) => n.every(Number.isFinite)), 'all nodes finite');
  }
});
