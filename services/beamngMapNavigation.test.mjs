import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManualMapNavigationData } from './beamngMapNavigation.js';

function makeTerrainData(osmFeatures = []) {
  const width = 8;
  const height = 8;
  return {
    width,
    height,
    minHeight: 0,
    maxHeight: 100,
    heightMap: new Float32Array(width * height).fill(10),
    bounds: {
      north: 1,
      south: 0,
      west: 0,
      east: 1,
    },
    osmFeatures,
  };
}

test('buildManualMapNavigationData returns empty data for non-manual road modes', () => {
  const terrainData = makeTerrainData([
    {
      id: 'r1',
      type: 'road',
      tags: { highway: 'primary' },
      geometry: [
        { lat: 0.8, lng: 0.2 },
        { lat: 0.2, lng: 0.8 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'decal');
  assert.deepEqual(navData, { segments: {}, waypoints: [] });
});

test('buildManualMapNavigationData creates segments and BeamNGWaypoint nodes for architect mode', () => {
  const terrainData = makeTerrainData([
    {
      id: 'r1',
      type: 'road',
      tags: { highway: 'primary', oneway: 'yes' },
      geometry: [
        { lat: 0.75, lng: 0.25 },
        { lat: 0.5, lng: 0.5 },
        { lat: 0.25, lng: 0.75 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'architect');
  const segmentKeys = Object.keys(navData.segments);

  assert.ok(segmentKeys.length >= 1);
  assert.ok(navData.waypoints.length >= 2);

  const firstSegment = navData.segments[segmentKeys[0]];
  assert.equal(firstSegment.oneWay, true);
  assert.ok(Array.isArray(firstSegment.nodes));
  assert.ok(firstSegment.nodes.length >= 2);

  const firstWaypoint = navData.waypoints[0];
  assert.equal(firstWaypoint.class, 'BeamNGWaypoint');
  assert.equal(firstWaypoint.__parent, 'AIWaypointsGroup');
});

test('buildManualMapNavigationData marks reverse one-way segments with flipDirection', () => {
  const terrainData = makeTerrainData([
    {
      id: 'r1',
      type: 'road',
      tags: { highway: 'secondary', oneway: '-1' },
      geometry: [
        { lat: 0.7, lng: 0.2 },
        { lat: 0.3, lng: 0.8 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'mesh');
  const segment = navData.segments[Object.keys(navData.segments)[0]];

  assert.equal(segment.oneWay, true);
  assert.equal(segment.flipDirection, true);
});

test('buildManualMapNavigationData emits manual lane counts for two-way roads', () => {
  const terrainData = makeTerrainData([
    {
      id: 'r1',
      type: 'road',
      tags: {
        highway: 'primary',
        lanes: '4',
      },
      geometry: [
        { lat: 0.75, lng: 0.25 },
        { lat: 0.25, lng: 0.75 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'architect');
  const segment = navData.segments[Object.keys(navData.segments)[0]];

  assert.equal(segment.autoLanes, false);
  assert.equal(segment.lanesLeft, 2);
  assert.equal(segment.lanesRight, 2);
});

test('buildManualMapNavigationData converts maxspeed mph to m/s', () => {
  const terrainData = makeTerrainData([
    {
      id: 'r1',
      type: 'road',
      tags: {
        highway: 'secondary',
        maxspeed: '35 mph',
      },
      geometry: [
        { lat: 0.8, lng: 0.2 },
        { lat: 0.2, lng: 0.8 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'mesh');
  const segment = navData.segments[Object.keys(navData.segments)[0]];

  assert.equal(segment.speedLimit, 15.646);
});

test('buildManualMapNavigationData disables autoJunction for bridge and tunnel links', () => {
  const terrainData = makeTerrainData([
    {
      id: 'bridge_way',
      type: 'road',
      tags: {
        highway: 'primary',
        bridge: 'yes',
      },
      geometry: [
        { lat: 0.85, lng: 0.15 },
        { lat: 0.65, lng: 0.35 },
      ],
    },
    {
      id: 'tunnel_way',
      type: 'road',
      tags: {
        highway: 'secondary',
        tunnel: 'yes',
      },
      geometry: [
        { lat: 0.35, lng: 0.65 },
        { lat: 0.15, lng: 0.85 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'architect');
  const segments = Object.values(navData.segments);

  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => segment.autoJunction === false));
});

test('buildManualMapNavigationData marks private roads hidden in navigation', () => {
  const terrainData = makeTerrainData([
    {
      id: 'private_road',
      type: 'road',
      tags: {
        highway: 'service',
        access: 'private',
      },
      geometry: [
        { lat: 0.78, lng: 0.22 },
        { lat: 0.22, lng: 0.78 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'mesh');
  const segment = navData.segments[Object.keys(navData.segments)[0]];

  assert.equal(segment.type, 'private');
  assert.equal(segment.gatedRoad, true);
  assert.equal(segment.hiddenInNavi, true);
});

test('buildManualMapNavigationData preserves link road granularity instead of over-merging', () => {
  const terrainData = makeTerrainData([
    {
      id: 'link_a',
      type: 'road',
      tags: {
        highway: 'motorway_link',
        oneway: 'yes',
      },
      geometry: [
        { lat: 0.85, lng: 0.15 },
        { lat: 0.65, lng: 0.35 },
      ],
    },
    {
      id: 'link_b',
      type: 'road',
      tags: {
        highway: 'motorway_link',
        oneway: 'yes',
      },
      geometry: [
        { lat: 0.65, lng: 0.35 },
        { lat: 0.45, lng: 0.55 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'mesh');
  const segments = Object.values(navData.segments);

  assert.equal(segments.length, 2);
  assert.ok(segments.every((segment) => segment.oneWay === true));
});

test('buildManualMapNavigationData disables autoJunction at dense same-grade intersections', () => {
  const terrainData = makeTerrainData([
    {
      id: 'north_south',
      type: 'road',
      tags: { highway: 'primary' },
      geometry: [
        { lat: 0.85, lng: 0.5 },
        { lat: 0.5, lng: 0.5 },
        { lat: 0.15, lng: 0.5 },
      ],
    },
    {
      id: 'west_east',
      type: 'road',
      tags: { highway: 'primary' },
      geometry: [
        { lat: 0.5, lng: 0.15 },
        { lat: 0.5, lng: 0.5 },
        { lat: 0.5, lng: 0.85 },
      ],
    },
  ]);

  const navData = buildManualMapNavigationData(terrainData, 1, 'architect');
  const segments = Object.values(navData.segments);

  assert.ok(segments.length >= 4);
  assert.ok(segments.every((segment) => segment.autoJunction === false));
});
