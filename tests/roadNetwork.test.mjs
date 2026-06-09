import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoadNetwork, mergeLinearRoadSegments } from '../services/roadNetwork.js';

function allSegmentCoordsFinite(network) {
  return network.segments.every((seg) =>
    seg.geometry.every((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lng)),
  );
}

test('buildRoadNetwork drops non-finite vertices from road geometry', () => {
  // An OSM way with an unresolved middle node (NaN/undefined coords) — the kind
  // that otherwise produces an inf DecalRoad position BeamNG rejects.
  const features = [
    {
      type: 'road',
      id: 1,
      tags: { highway: 'residential' },
      geometry: [
        { lat: 0.10, lng: 0.10 },
        { lat: Number.NaN, lng: 0.20 },
        { lat: 0.30, lng: undefined },
        { lat: 0.40, lng: 0.40 },
      ],
    },
  ];

  const network = buildRoadNetwork(features);

  assert.ok(network.segments.length > 0, 'Expected at least one segment from the cleaned road');
  assert.ok(allSegmentCoordsFinite(network), 'All segment vertices must be finite');

  const totalNodes = network.segments.reduce((sum, seg) => sum + seg.geometry.length, 0);
  assert.equal(totalNodes, 2, 'Only the two finite vertices should survive');
});

test('buildRoadNetwork discards roads left with fewer than 2 finite vertices', () => {
  const features = [
    {
      type: 'road',
      id: 2,
      tags: { highway: 'service' },
      geometry: [
        { lat: 0.5, lng: 0.5 },
        { lat: Number.NaN, lng: Number.NaN },
      ],
    },
  ];

  const network = buildRoadNetwork(features);
  assert.equal(network.segments.length, 0, 'A road with <2 finite vertices should be dropped entirely');
});

test('buildRoadNetwork leaves clean geometry untouched', () => {
  const geometry = [
    { lat: 0.1, lng: 0.1 },
    { lat: 0.2, lng: 0.2 },
    { lat: 0.3, lng: 0.3 },
  ];
  const network = buildRoadNetwork([
    { type: 'road', id: 3, tags: { highway: 'primary' }, geometry },
  ]);

  assert.ok(allSegmentCoordsFinite(network));
  const totalNodes = network.segments.reduce((sum, seg) => sum + seg.geometry.length, 0);
  assert.equal(totalNodes, geometry.length);
});

test('mergeLinearRoadSegments does not stitch a continuation that doubles back (dual carriageway)', () => {
  // Two parallel carriageways of the same road: identical style tags, meeting
  // at the node where the divided road merges. Stitching them would create a
  // ~180° hairpin that breaks BeamNG's DecalRoad spline.
  const tags = { highway: 'primary', name: 'Golf Pkwy', oneway: 'yes' };
  const northbound = {
    id: 'nb', type: 'road', tags,
    geometry: [
      { lat: 0.0, lng: 0.0000 },
      { lat: 0.0, lng: 0.0010 },
      { lat: 0.0, lng: 0.0020 },
    ],
  };
  // Southbound carriageway ends at the same merge node, coming from the same
  // direction — continuing through it would reverse the path onto itself.
  const southbound = {
    id: 'sb', type: 'road', tags,
    geometry: [
      { lat: 0.0001, lng: 0.0000 },
      { lat: 0.0001, lng: 0.0010 },
      { lat: 0.0, lng: 0.0020 },
    ],
  };

  const network = buildRoadNetwork([northbound, southbound]);
  const merged = mergeLinearRoadSegments(network.segments, network.intersections);

  assert.equal(merged.length, 2, 'reversing continuation must stay two separate roads');
  for (const segment of merged) {
    for (let i = 2; i < segment.geometry.length; i++) {
      const a = segment.geometry[i - 2];
      const b = segment.geometry[i - 1];
      const c = segment.geometry[i];
      const inX = b.lng - a.lng; const inY = b.lat - a.lat;
      const outX = c.lng - b.lng; const outY = c.lat - b.lat;
      const dot = (inX * outX + inY * outY) /
        ((Math.hypot(inX, inY) * Math.hypot(outX, outY)) || 1);
      assert.ok(dot > -0.5, `merged geometry contains a hairpin (dot=${dot.toFixed(3)})`);
    }
  }
});

test('mergeLinearRoadSegments still merges a straight continuation', () => {
  const tags = { highway: 'primary', name: 'Straight Rd' };
  const a = {
    id: 'a', type: 'road', tags,
    geometry: [{ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }],
  };
  const b = {
    id: 'b', type: 'road', tags,
    geometry: [{ lat: 0, lng: 0.001 }, { lat: 0, lng: 0.002 }],
  };
  const network = buildRoadNetwork([a, b]);
  const merged = mergeLinearRoadSegments(network.segments, network.intersections);
  assert.equal(merged.length, 1, 'collinear same-style segments must merge');
  assert.equal(merged[0].geometry.length, 3);
});
