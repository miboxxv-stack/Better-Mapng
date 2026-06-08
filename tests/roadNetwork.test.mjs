import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoadNetwork } from '../services/roadNetwork.js';

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
