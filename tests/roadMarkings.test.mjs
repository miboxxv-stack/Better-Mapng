import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLineMarkingLayers } from '../services/exportBeamNGLevel.js';

const mats = (layers) => layers.map((l) => l.material).sort();
const byName = (layers, name) => layers.filter((l) => l.name.startsWith(name));

test('one-way major road: no center line, dashed separators, yellow travel-left edge', () => {
  const layers = buildLineMarkingLayers('trunk', { oneway: 'yes', lanes: '3' }, 5.55);

  assert.equal(byName(layers, 'line_center').length, 0, 'one-way roads must not get a center line');
  assert.ok(!mats(layers).includes('m_line_yellow_double'), 'no double-yellow on a one-way carriageway');

  const seps = byName(layers, 'line_sep_');
  assert.equal(seps.length, 2, '3 lanes → 2 separators');
  assert.ok(seps.every((l) => l.material === 'm_line_white_discontinue'));

  // Travel-left (positive offset for forward digitization) edge is yellow.
  const yellow = layers.find((l) => l.material === 'm_line_yellow');
  const white = layers.find((l) => l.material === 'm_line_white');
  assert.ok(yellow && white, 'one yellow and one white edge line');
  assert.ok(yellow.offset > 0, 'yellow edge on travel-left (positive offset)');
  assert.ok(white.offset < 0, 'white edge on travel-right (negative offset)');
});

test('oneway=-1 flips the yellow edge to the negative-offset side', () => {
  const layers = buildLineMarkingLayers('trunk', { oneway: '-1', lanes: '2' }, 5);
  const yellow = layers.find((l) => l.material === 'm_line_yellow');
  assert.ok(yellow.offset < 0, 'reverse one-way: travel-left is the negative-offset side');
});

test('two-way major road: double-yellow center, per-direction separators, white edges', () => {
  const layers = buildLineMarkingLayers('trunk', { lanes: '4' }, 7.4);

  const center = byName(layers, 'line_center');
  assert.equal(center.length, 1);
  assert.equal(center[0].material, 'm_line_yellow_double');
  assert.ok(Math.abs(center[0].offset) < 1e-9, 'symmetric lanes → center divider at offset 0');

  assert.equal(byName(layers, 'line_sep_').length, 2, '2 lanes per direction → 1 separator each side');

  const edges = layers.filter((l) => l.material === 'm_line_white' && (l.name === 'line_left' || l.name === 'line_right'));
  assert.equal(edges.length, 2, 'major two-way roads keep both white edge lines');
});

test('asymmetric lanes shift the center divider toward the minority side', () => {
  const E = 0.9 * 5;
  const layers = buildLineMarkingLayers('primary', { lanes: '3', 'lanes:forward': '2', 'lanes:backward': '1' }, 5);
  const center = byName(layers, 'line_center')[0];
  // Forward lanes ride the negative-offset side; 2-of-3 lanes forward puts the
  // divider at +E/3.
  assert.ok(Math.abs(center.offset - E / 3) < 1e-9, `expected ${E / 3}, got ${center.offset}`);
});

test('minor two-way road: dashed white center only', () => {
  const layers = buildLineMarkingLayers('tertiary', {}, 4);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].name, 'line_center');
  assert.equal(layers[0].material, 'm_line_white_discontinue');
});

test('roundabout (implied one-way, minor class): no markings at default lane count', () => {
  const layers = buildLineMarkingLayers('tertiary', { junction: 'roundabout' }, 4);
  assert.equal(layers.length, 0, 'single default lane, non-major: nothing to paint');
});

test('absurd lane counts are capped', () => {
  const layers = buildLineMarkingLayers('trunk', { oneway: 'yes', lanes: '12' }, 9);
  assert.equal(byName(layers, 'line_sep_').length, 6);
});
