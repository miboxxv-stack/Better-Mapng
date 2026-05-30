import { buildRoadNetwork, mergeLinearRoadSegments } from './roadNetwork.js';

const ROAD_SKIP = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'cycleway',
  'bridleway', 'corridor', 'proposed', 'construction',
]);

function isOneWayRoad(tags = {}) {
  const value = String(tags.oneway ?? '').trim().toLowerCase();
  if (value === 'yes' || value === '1' || value === 'true') return true;
  if (value === '-1' || value === 'reverse') return true;
  if (tags.junction === 'roundabout') return true;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return true;
  return false;
}

function isReverseOneWayRoad(tags = {}) {
  const value = String(tags.oneway ?? '').trim().toLowerCase();
  return value === '-1' || value === 'reverse';
}

function shouldGenerateNavigationRoad(feature) {
  if (feature?.type !== 'road' || !Array.isArray(feature.geometry) || feature.geometry.length < 2) {
    return false;
  }

  const tags = feature.tags || {};
  const highway = tags.highway;
  if (!highway || ROAD_SKIP.has(highway)) return false;
  if (tags.area === 'yes') return false;

  const service = String(tags.service ?? '').trim().toLowerCase();
  if (['parking_aisle', 'driveway', 'alley', 'emergency_access'].includes(service)) {
    return false;
  }

  return true;
}

function inferMapSegmentDrivability(highway, tags = {}) {
  const access = String(tags.access ?? '').trim().toLowerCase();
  if (access === 'private') return 0.6;

  if (highway === 'track') return 0.7;
  if (highway === 'service') return 0.8;
  return 1;
}

function inferMapSegmentRoadMetadata(highway, tags = {}) {
  const access = String(tags.access ?? '').trim().toLowerCase();
  const service = String(tags.service ?? '').trim().toLowerCase();
  const privateLike = access === 'private' || service === 'driveway' || highway === 'track';

  if (!privateLike) {
    return {
      hiddenInNavi: false,
    };
  }

  return {
    type: 'private',
    gatedRoad: true,
    hiddenInNavi: true,
  };
}

function isLinkRoad(highway) {
  return typeof highway === 'string' && highway.endsWith('_link');
}

function inferMapSegmentJunctionMetadata(segment, tags = {}, endpointDegree = 0) {
  const bridge = String(tags.bridge ?? '').trim().toLowerCase();
  const tunnel = String(tags.tunnel ?? '').trim().toLowerCase();
  const covered = String(tags.covered ?? '').trim().toLowerCase();
  const location = String(tags.location ?? '').trim().toLowerCase();
  const embankment = String(tags.embankment ?? '').trim().toLowerCase();
  const cutting = String(tags.cutting ?? '').trim().toLowerCase();

  const isBridgeLike =
    bridge === 'yes' ||
    bridge === 'viaduct' ||
    tags.man_made === 'bridge' ||
    location === 'overground' ||
    location === 'elevated';
  const isTunnelLike =
    tunnel === 'yes' ||
    covered === 'yes' ||
    location === 'underground' ||
    location === 'underwater';
  const isGradeSeparated =
    isBridgeLike ||
    isTunnelLike ||
    embankment === 'yes' ||
    cutting === 'yes' ||
    Number.isFinite(segment?.layer) && Math.abs(Number(segment.layer)) >= 1;
  const denseIntersection = endpointDegree >= 4 || (isLinkRoad(segment?.highway) && endpointDegree >= 3);

  return {
    // Prevent BeamNG auto-junctions on obvious grade-separated links.
    autoJunction: !(isGradeSeparated || denseIntersection),
  };
}

function getIntersectionDegree(intersections, nodeKey) {
  if (!nodeKey || !intersections || typeof intersections.get !== 'function') return 0;
  const entries = intersections.get(nodeKey);
  return Array.isArray(entries) ? entries.length : 0;
}

function shouldPreserveOriginalSegment(segment, intersections) {
  if (!Array.isArray(segment?.members) || segment.members.length < 2) return false;

  const tags = segment.tags || {};
  const endpointDegree = Math.max(
    getIntersectionDegree(intersections, segment.startKey),
    getIntersectionDegree(intersections, segment.endKey),
  );

  return isLinkRoad(segment.highway) || tags.junction === 'roundabout' || endpointDegree >= 4;
}

function resolveNavigationSegments(roadNetwork, mergedRoadSegments) {
  if (!Array.isArray(mergedRoadSegments) || mergedRoadSegments.length === 0) {
    return roadNetwork.segments;
  }

  const out = [];
  for (const segment of mergedRoadSegments) {
    if (shouldPreserveOriginalSegment(segment, roadNetwork.intersections)) {
      out.push(...segment.members);
      continue;
    }
    out.push(segment);
  }
  return out;
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getDefaultLaneCount(highway, isOneWay) {
  if (['motorway', 'trunk'].includes(highway)) return isOneWay ? 2 : 4;
  if (['motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'].includes(highway)) {
    return 1;
  }
  if (['service', 'track'].includes(highway)) return 1;
  return isOneWay ? 1 : 2;
}

function inferManualLaneData(highway, tags = {}, isOneWay = false) {
  const forward = parsePositiveInt(tags['lanes:forward']);
  const backward = parsePositiveInt(tags['lanes:backward']);
  const total = parsePositiveInt(tags.lanes);

  if (isOneWay) {
    const laneCount = Math.max(1, forward || total || getDefaultLaneCount(highway, true));
    return { autoLanes: false, lanesLeft: laneCount, lanesRight: 0 };
  }

  if (forward > 0 || backward > 0) {
    const left = Math.max(1, forward || Math.ceil((forward + backward) / 2));
    const right = Math.max(1, backward || Math.floor((forward + backward) / 2));
    return { autoLanes: false, lanesLeft: left, lanesRight: right };
  }

  if (total > 0) {
    const left = Math.max(1, Math.ceil(total / 2));
    const right = Math.max(1, Math.floor(total / 2));
    return { autoLanes: false, lanesLeft: left, lanesRight: right };
  }

  const fallback = Math.max(2, getDefaultLaneCount(highway, false));
  return {
    autoLanes: false,
    lanesLeft: Math.max(1, Math.ceil(fallback / 2)),
    lanesRight: Math.max(1, Math.floor(fallback / 2)),
  };
}

function parseMaxspeedMps(tags = {}) {
  const raw = String(tags.maxspeed ?? '').trim().toLowerCase();
  if (!raw) return null;

  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  // OSM maxspeed is km/h by default unless unit suffix indicates otherwise.
  const mps = raw.includes('mph') ? numeric * 0.44704 : numeric / 3.6;
  return Number.isFinite(mps) && mps > 0 ? Math.round(mps * 1000) / 1000 : null;
}

function clipGeometryToMargin(geometry, bounds) {
  if (!Array.isArray(geometry) || geometry.length < 2 || !bounds) return [];

  const marginDegLat = 8 / 111320;
  const centerLat = (bounds.north + bounds.south) / 2;
  const metersPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const marginDegLng = metersPerDegLng > 1e-6 ? 8 / metersPerDegLng : 0;

  const left = bounds.west + marginDegLng;
  const right = bounds.east - marginDegLng;
  const bottom = bounds.south + marginDegLat;
  const top = bounds.north - marginDegLat;

  const inside = (pt) => pt.lng >= left && pt.lng <= right && pt.lat >= bottom && pt.lat <= top;

  const intersect = (a, b, edge) => {
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    if (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12) return { lat: a.lat, lng: a.lng };

    let t = 0;
    if (edge === 'left') t = (left - a.lng) / dx;
    else if (edge === 'right') t = (right - a.lng) / dx;
    else if (edge === 'bottom') t = (bottom - a.lat) / dy;
    else t = (top - a.lat) / dy;

    t = Math.max(0, Math.min(1, t));
    return {
      lng: a.lng + dx * t,
      lat: a.lat + dy * t,
    };
  };

  const segments = [];
  let current = [];

  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const aIn = inside(a);
    const bIn = inside(b);

    if (aIn && bIn) {
      if (current.length === 0) current.push(a);
      current.push(b);
      continue;
    }

    const edges = ['left', 'right', 'bottom', 'top'];
    const intersections = [];
    for (const edge of edges) {
      const p = intersect(a, b, edge);
      if (
        Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
        p.lng >= left - 1e-9 && p.lng <= right + 1e-9 &&
        p.lat >= bottom - 1e-9 && p.lat <= top + 1e-9
      ) {
        intersections.push(p);
      }
    }

    const uniq = [];
    for (const p of intersections) {
      if (!uniq.some((q) => Math.abs(q.lat - p.lat) < 1e-9 && Math.abs(q.lng - p.lng) < 1e-9)) {
        uniq.push(p);
      }
    }

    uniq.sort((p1, p2) => {
      const d1 = (p1.lng - a.lng) ** 2 + (p1.lat - a.lat) ** 2;
      const d2 = (p2.lng - a.lng) ** 2 + (p2.lat - a.lat) ** 2;
      return d1 - d2;
    });

    if (aIn && !bIn) {
      if (current.length === 0) current.push(a);
      if (uniq[0]) current.push(uniq[0]);
      if (current.length >= 2) segments.push(current);
      current = [];
    } else if (!aIn && bIn) {
      current = [];
      if (uniq[0]) current.push(uniq[0]);
      current.push(b);
    } else if (!aIn && !bIn && uniq.length === 2) {
      segments.push([uniq[0], uniq[1]]);
      current = [];
    }
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

function chunkPolyline(points, maxNodes = 80) {
  if (!Array.isArray(points) || points.length < 2) return [];
  if (points.length <= maxNodes) return [points];

  const out = [];
  for (let i = 0; i < points.length - 1; i += (maxNodes - 1)) {
    const chunk = points.slice(i, i + maxNodes);
    if (chunk.length >= 2) out.push(chunk);
  }
  return out;
}

function geoToWorld(lat, lng, terrainData, squareSize, zOffset = 0) {
  const { bounds, width, height, heightMap, minHeight } = terrainData;
  const worldSize = width * squareSize;

  const u = Math.max(0, Math.min(1, (lng - bounds.west) / (bounds.east - bounds.west)));
  const v = Math.max(0, Math.min(1, (bounds.north - lat) / (bounds.north - bounds.south)));

  const fx = u * (width - 1);
  const fy = v * (height - 1);
  const c0 = Math.min(width - 1, Math.floor(fx));
  const c1 = Math.min(width - 1, c0 + 1);
  const r0 = Math.min(height - 1, Math.floor(fy));
  const r1 = Math.min(height - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const sanitizeHeight = (h) => (Number.isFinite(h) && h > -10000 ? h : minHeight);
  const h00 = sanitizeHeight(heightMap[r0 * width + c0]);
  const h10 = sanitizeHeight(heightMap[r0 * width + c1]);
  const h01 = sanitizeHeight(heightMap[r1 * width + c0]);
  const h11 = sanitizeHeight(heightMap[r1 * width + c1]);
  const worldH = (h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty) - minHeight;

  const worldX = (u - 0.5) * worldSize;
  const worldY = (0.5 - v) * worldSize;

  return [
    Math.round(worldX * 10) / 10,
    Math.round(worldY * 10) / 10,
    Math.round((worldH + zOffset) * 10) / 10,
  ];
}

export function buildManualMapNavigationData(terrainData, squareSize, roadType) {
  if (roadType !== 'architect' && roadType !== 'mesh') {
    return { segments: {}, waypoints: [] };
  }

  const sourceRoadFeatures = Array.isArray(terrainData?.osmFeatures)
    ? terrainData.osmFeatures.filter(shouldGenerateNavigationRoad)
    : [];
  if (sourceRoadFeatures.length === 0) {
    return { segments: {}, waypoints: [] };
  }

  const roadNetwork = buildRoadNetwork(sourceRoadFeatures);
  const mergedRoadSegments = mergeLinearRoadSegments(roadNetwork.segments, roadNetwork.intersections);
  const navSegmentsSource = resolveNavigationSegments(roadNetwork, mergedRoadSegments);

  const waypointNameByGeoKey = new Map();
  const waypoints = [];
  const segments = {};
  let waypointIndex = 0;
  let segmentIndex = 0;

  const getWaypointNameForPoint = (point, layer) => {
    const geoKey = `${Number(point.lat).toFixed(7)}:${Number(point.lng).toFixed(7)}|${String(layer)}`;
    const existingName = waypointNameByGeoKey.get(geoKey);
    if (existingName) return existingName;

    const name = `nav_wp_${waypointIndex++}`;
    waypointNameByGeoKey.set(geoKey, name);

    const [wx, wy, wz] = geoToWorld(point.lat, point.lng, terrainData, squareSize, 0.15);
    waypoints.push({
      __parent: 'AIWaypointsGroup',
      class: 'BeamNGWaypoint',
      name,
      position: [wx, wy, wz],
      scale: [1, 1, 1],
    });

    return name;
  };

  for (const segment of navSegmentsSource) {
    const tags = segment.tags || {};
    const clippedSegments = clipGeometryToMargin(segment.geometry, terrainData.bounds)
      .flatMap((piece) => chunkPolyline(piece, 80));

    for (const piece of clippedSegments) {
      if (!Array.isArray(piece) || piece.length < 2) continue;

      const nodeNames = piece.map((point) => getWaypointNameForPoint(point, segment.layer));
      const dedupedNodeNames = nodeNames.filter((name, idx) => idx === 0 || name !== nodeNames[idx - 1]);
      if (dedupedNodeNames.length < 2) continue;

      const oneWay = isOneWayRoad(tags);
      const endpointDegree = Math.max(
        getIntersectionDegree(roadNetwork.intersections, segment.startKey),
        getIntersectionDegree(roadNetwork.intersections, segment.endKey),
      );
      const mapSegment = {
        nodes: dedupedNodeNames,
        drivability: inferMapSegmentDrivability(segment.highway, tags),
        ...inferManualLaneData(segment.highway, tags, oneWay),
        ...inferMapSegmentJunctionMetadata(segment, tags, endpointDegree),
      };

      const speedLimit = parseMaxspeedMps(tags);
      if (Number.isFinite(speedLimit) && speedLimit > 0) {
        mapSegment.speedLimit = speedLimit;
      }

      if (oneWay) {
        mapSegment.oneWay = true;
        if (isReverseOneWayRoad(tags)) {
          mapSegment.flipDirection = true;
        }
      }

      Object.assign(mapSegment, inferMapSegmentRoadMetadata(segment.highway, tags));
      segments[`osm_segment_${segmentIndex++}`] = mapSegment;
    }
  }

  return { segments, waypoints };
}
