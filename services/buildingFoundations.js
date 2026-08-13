/**
 * Terrain foundation pass for BeamNG level export.
 *
 * Purpose:
 * - Fill small terrain gaps underneath buildings.
 * - Avoid raising an entire building footprint to its highest terrain point.
 * - Be conservative near roads so buildings do not create artificial hills.
 *
 * This file controls TERRAIN only.
 * It does NOT control building roofs, colors, windows, or building models.
 */

/**
 * Convert WGS84 lat/lng to heightMap pixel coordinates.
 */
function geoToHeightMapPx(lat, lng, bounds, size) {
  const col =
    ((lng - bounds.west) / (bounds.east - bounds.west)) * (size - 1);

  const py =
    ((lat - bounds.south) / (bounds.north - bounds.south)) * (size - 1);

  const row = (size - 1) - py;

  return {
    col: Math.max(0, Math.min(size - 1, col)),
    row: Math.max(0, Math.min(size - 1, row)),
  };
}

function uniqueIndices(indices) {
  return [...new Set(indices)];
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep01(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function percentileFromSorted(sorted, p) {
  if (!sorted.length) return NaN;

  const pos = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const frac = pos - lo;

  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function estimateMetersPerPixel(terrainData) {
  if (
    Number.isFinite(terrainData?.metersPerPixel) &&
    terrainData.metersPerPixel > 0
  ) {
    return terrainData.metersPerPixel;
  }

  if (
    Number.isFinite(terrainData?.processingMetersPerPixel) &&
    terrainData.processingMetersPerPixel > 0
  ) {
    return terrainData.processingMetersPerPixel;
  }

  const { bounds, width } = terrainData;

  if (!bounds || !width) return 1;

  const centerLat = (bounds.north + bounds.south) / 2;
  const latRad = (centerLat * Math.PI) / 180;

  const metersPerDegreeLng = 111320 * Math.cos(latRad);
  const metersPerDegreeLat = 110574;

  const widthMeters =
    Math.abs(bounds.east - bounds.west) * metersPerDegreeLng;

  const heightMeters =
    Math.abs(bounds.north - bounds.south) * metersPerDegreeLat;

  const avgMeters = (widthMeters + heightMeters) / 2;

  return Math.max(0.01, avgMeters / width);
}

/**
 * Get tags regardless of whether your OSM feature stores them in
 * feature.tags or feature.properties.
 */
function getFeatureTags(feature) {
  return feature?.tags || feature?.properties || {};
}

/**
 * Determine whether an OSM feature represents a road/highway.
 */
function isRoadFeature(feature) {
  const tags = getFeatureTags(feature);

  return Boolean(
    tags.highway ||
    feature?.type === "road" ||
    feature?.type === "highway"
  );
}

/**
 * Approximate distance between two geographic points in meters.
 */
function distanceMeters(a, b) {
  const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;

  const metersPerDegreeLat = 110574;
  const metersPerDegreeLng = 111320 * Math.cos(lat);

  const dx =
    (b.lng - a.lng) * metersPerDegreeLng;

  const dy =
    (b.lat - a.lat) * metersPerDegreeLat;

  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Distance from a point to a geographic line segment.
 *
 * This is an approximation suitable for determining whether
 * a building is close to a road.
 */
function pointToSegmentDistanceMeters(point, a, b) {
  const lat = point.lat * Math.PI / 180;

  const metersPerDegreeLat = 110574;
  const metersPerDegreeLng = 111320 * Math.cos(lat);

  const px = point.lng * metersPerDegreeLng;
  const py = point.lat * metersPerDegreeLat;

  const ax = a.lng * metersPerDegreeLng;
  const ay = a.lat * metersPerDegreeLat;

  const bx = b.lng * metersPerDegreeLng;
  const by = b.lat * metersPerDegreeLat;

  const abx = bx - ax;
  const aby = by - ay;

  const ab2 = abx * abx + aby * aby;

  if (ab2 <= 0.000001) {
    return distanceMeters(point, a);
  }

  const apx = px - ax;
  const apy = py - ay;

  const t = Math.max(
    0,
    Math.min(
      1,
      (apx * abx + apy * aby) / ab2
    )
  );

  const closest = {
    lat: (ay + aby * t) / metersPerDegreeLat,
    lng: (ax + abx * t) / metersPerDegreeLng,
  };

  return distanceMeters(point, closest);
}

/**
 * Determine whether a building is close to an OSM road.
 */
function findNearbyRoad(building, roads, clearanceMeters) {
  if (!roads.length || !building.geometry?.length) {
    return null;
  }

  let closest = null;
  let closestDistance = Infinity;

  for (const point of building.geometry) {
    for (const road of roads) {
      const geometry = road.geometry;

      if (!Array.isArray(geometry) || geometry.length < 2) {
        continue;
      }

      for (let i = 0; i < geometry.length - 1; i++) {
        const a = geometry[i];
        const b = geometry[i + 1];

        const d = pointToSegmentDistanceMeters(
          point,
          a,
          b
        );

        if (d < closestDistance) {
          closestDistance = d;
          closest = {
            road,
            distance: d,
          };
        }
      }
    }
  }

  if (!closest || closest.distance > clearanceMeters) {
    return null;
  }

  return closest;
}

/**
 * Rasterize a polygon ring.
 */
function rasterizePolygonIndices(
  ring,
  size,
  margin = 0
) {
  if (ring.length < 3) return [];

  const indices = [];
  const n = ring.length;

  let minRow = size;
  let maxRow = 0;

  for (const p of ring) {
    minRow = Math.min(minRow, p.row);
    maxRow = Math.max(maxRow, p.row);
  }

  minRow = Math.max(
    0,
    Math.floor(minRow) - margin
  );

  maxRow = Math.min(
    size - 1,
    Math.ceil(maxRow) + margin
  );

  for (let row = minRow; row <= maxRow; row++) {
    const sy = row + 0.5;
    const xs = [];

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;

      const r0 = ring[i].row;
      const r1 = ring[j].row;

      if (
        (r0 <= sy && r1 > sy) ||
        (r1 <= sy && r0 > sy)
      ) {
        xs.push(
          ring[i].col +
          ((sy - r0) / (r1 - r0)) *
          (ring[j].col - ring[i].col)
        );
      }
    }

    xs.sort((a, b) => a - b);

    for (
      let k = 0;
      k + 1 < xs.length;
      k += 2
    ) {
      const c0 = Math.max(
        0,
        Math.ceil(xs[k]) - margin
      );

      const c1 = Math.min(
        size - 1,
        Math.floor(xs[k + 1]) + margin
      );

      for (let col = c0; col <= c1; col++) {
        indices.push(row * size + col);
      }
    }
  }

  return indices;
}

/**
 * Apply conservative building foundations.
 */
export async function applyBuildingFoundations(
  terrainData,
  options = {}
) {
  const {
    /*
     * IMPORTANT:
     * These are deliberately conservative.
     */

    foundationRaise = 0.15,

    // Do not expand the actual building footprint much.
    marginPx = 0,

    // Much smaller transition than before.
    transitionPx = 2,

    /*
     * 0.50 = median terrain height.
     *
     * Your previous value was 0.85, which strongly favored
     * the high side of the building.
     */
    foundationPercentile = 0.50,

    reliefLowPercentile = 0.20,
    reliefHighPercentile = 0.80,

    /*
     * Do not modify tiny slopes.
     */
    minReliefMeters = 1.5,
    minSlope = 0.18,

    blurIterations = 1,

    /*
     * Road settings.
     */
    roadClearanceMeters = 10,

    /*
     * Maximum amount a foundation may be above nearby road
     * terrain when the building is close to a road.
     */
    maxFoundationAboveRoad = 0.45,

    yieldFn = null,
    yieldEveryBuildings = 8,
    yieldEveryPixels = 200000,
    onProgress = null,
  } = options;

  const {
    width,
    bounds,
    osmFeatures = [],
    maxHeight,
  } = terrainData;

  const size = width;

  const buildings = osmFeatures.filter(
    f =>
      f.type === "building" &&
      Array.isArray(f.geometry) &&
      f.geometry.length >= 3
  );

  if (!buildings.length) {
    return terrainData;
  }

  /*
   * Find roads once instead of searching the entire OSM feature
   * list repeatedly.
   */
  const roads = osmFeatures.filter(isRoadFeature);

  const heightMap =
    new Float32Array(terrainData.heightMap);

  const sourceHeightMap =
    terrainData.heightMap;

  const metersPerPixel =
    estimateMetersPerPixel(terrainData);

  let newMaxHeight = maxHeight;

  let foundationApplied = 0;
  let foundationSkipped = 0;
  let roadLimited = 0;

  for (
    let i = 0;
    i < buildings.length;
    i++
  ) {
    const building = buildings[i];

    const ring = building.geometry.map(
      pt =>
        geoToHeightMapPx(
          pt.lat,
          pt.lng,
          bounds,
          size
        )
    );

    const indices = uniqueIndices(
      rasterizePolygonIndices(
        ring,
        size,
        marginPx
      )
    );

    if (!indices.length) {
      continue;
    }

    const footprintHeights = [];

    for (const idx of indices) {
      const h = sourceHeightMap[idx];

      if (Number.isFinite(h)) {
        footprintHeights.push(h);
      }
    }

    if (!footprintHeights.length) {
      continue;
    }

    const sortedHeights =
      [...footprintHeights].sort(
        (a, b) => a - b
      );

    const reliefLow =
      percentileFromSorted(
        sortedHeights,
        reliefLowPercentile
      );

    const reliefHigh =
      percentileFromSorted(
        sortedHeights,
        reliefHighPercentile
      );

    const terrainRelief =
      Math.max(
        0,
        reliefHigh - reliefLow
      );

    const footprintRunMeters =
      Math.max(
        1,
        Math.sqrt(indices.length) *
        metersPerPixel
      );

    const slopeEstimate =
      terrainRelief /
      footprintRunMeters;

    /*
     * Skip mostly-flat terrain.
     *
     * There is no reason to flatten a building
     * that is already sitting naturally.
     */
    if (
      terrainRelief < minReliefMeters &&
      slopeEstimate < minSlope
    ) {
      foundationSkipped++;

      if (
        onProgress &&
        (i % 25 === 0 ||
          i === buildings.length - 1)
      ) {
        onProgress({
          completed: i + 1,
          total: buildings.length,
          applied: foundationApplied,
          skipped: foundationSkipped,
        });
      }

      if (
        yieldFn &&
        (i + 1) % yieldEveryBuildings === 0
      ) {
        await yieldFn();
      }

      continue;
    }

    /*
     * IMPORTANT CHANGE:
     *
     * Use the MEDIAN instead of the upper 85th percentile.
     *
     * This prevents a high side of a building from forcing
     * the entire building pad upward.
     */
    let foundationH =
      percentileFromSorted(
        sortedHeights,
        foundationPercentile
      ) + foundationRaise;

    /*
     * Look for a nearby road.
     */
    const nearbyRoad =
      findNearbyRoad(
        building,
        roads,
        roadClearanceMeters
      );

    if (nearbyRoad) {
      /*
       * Use the terrain under the closest road point
       * as a reference.
       */
      let roadReferenceHeight = NaN;
      let closestRoadDistance = Infinity;

      const roadGeometry =
        nearbyRoad.road.geometry;

      for (
        let r = 0;
        r < roadGeometry.length;
        r++
      ) {
        const roadPoint =
          roadGeometry[r];

        const roadPx =
          geoToHeightMapPx(
            roadPoint.lat,
            roadPoint.lng,
            bounds,
            size
          );

        const row =
          Math.round(roadPx.row);

        const col =
          Math.round(roadPx.col);

        if (
          row < 0 ||
          row >= size ||
          col < 0 ||
          col >= size
        ) {
          continue;
        }

        const idx =
          row * size + col;

        const roadHeight =
          sourceHeightMap[idx];

        if (!Number.isFinite(roadHeight)) {
          continue;
        }

        let distance = Infinity;

        for (
          const buildingPoint
          of building.geometry
        ) {
          distance = Math.min(
            distance,
            distanceMeters(
              roadPoint,
              buildingPoint
            )
          );
        }

        if (
          distance < closestRoadDistance
        ) {
          closestRoadDistance =
            distance;

          roadReferenceHeight =
            roadHeight;
        }
      }

      if (
        Number.isFinite(
          roadReferenceHeight
        )
      ) {
        /*
         * Do NOT allow the building pad to rise
         * dramatically above the nearby road.
         */
        const roadLimitedHeight =
          roadReferenceHeight +
          maxFoundationAboveRoad;

        if (
          foundationH >
          roadLimitedHeight
        ) {
          foundationH =
            roadLimitedHeight;

          roadLimited++;
        }
      }
    }

    /*
     * Do not lower naturally high terrain.
     *
     * Only fill the low portions.
     */
    const coreSet =
      new Set(indices);

    const touchedSet =
      new Set(indices);

    for (const idx of indices) {
      if (
        heightMap[idx] <
        foundationH
      ) {
        heightMap[idx] =
          foundationH;
      }
    }

    /*
     * Very small transition zone.
     *
     * This prevents a sharp foundation edge without
     * creating a giant artificial mound.
     */
    if (transitionPx > 0) {
      let prevRing = indices;

      for (
        let d = 1;
        d <= transitionPx;
        d++
      ) {
        const expanded =
          uniqueIndices(
            rasterizePolygonIndices(
              ring,
              size,
              marginPx + d
            )
          );

        if (!expanded.length) {
          continue;
        }

        const prevSet =
          new Set(prevRing);

        const band =
          expanded.filter(
            idx =>
              !prevSet.has(idx)
          );

        if (!band.length) {
          prevRing = expanded;
          continue;
        }

        const t =
          d /
          (transitionPx + 1);

        const alpha =
          1 -
          smoothstep01(t);

        for (const idx of band) {
          touchedSet.add(idx);

          const naturalH =
            sourceHeightMap[idx];

          const targetH =
            naturalH +
            alpha *
            Math.max(
              0,
              foundationH -
              naturalH
            );

          if (
            heightMap[idx] <
            targetH
          ) {
            heightMap[idx] =
              targetH;
          }
        }

        prevRing = expanded;
      }

      /*
       * One blur pass is enough.
       * More passes can make foundations spread
       * into roads and neighboring terrain.
       */
      await blurTransitionZone(
        heightMap,
        sourceHeightMap,
        size,
        coreSet,
        touchedSet,
        blurIterations,
        {
          yieldFn,
          yieldEveryPixels,
        }
      );
    }

    if (
      foundationH >
      newMaxHeight
    ) {
      newMaxHeight =
        foundationH;
    }

    foundationApplied++;

    if (
      onProgress &&
      (i % 25 === 0 ||
        i === buildings.length - 1)
    ) {
      onProgress({
        completed: i + 1,
        total: buildings.length,
        applied: foundationApplied,
        skipped: foundationSkipped,
        roadLimited,
      });
    }

    if (
      yieldFn &&
      (i + 1) % yieldEveryBuildings === 0
    ) {
      await yieldFn();
    }
  }

  console.info(
    `[BeamNG] Building foundations: ` +
    `applied ${foundationApplied}/${buildings.length}, ` +
    `skipped ${foundationSkipped}, ` +
    `road-limited ${roadLimited}`
  );

  return {
    ...terrainData,
    heightMap,
    maxHeight: newMaxHeight,
  };
}


/**
 * Smooth a small transition zone around foundations.
 */
async function blurTransitionZone(
  heightMap,
  sourceHeightMap,
  size,
  fixedSet,
  regionSet,
  iterations = 1,
  options = {}
) {
  if (
    iterations <= 0 ||
    !regionSet.size
  ) {
    return;
  }

  const {
    yieldFn = null,
    yieldEveryPixels = 200000,
  } = options;

  const regionMask =
    new Uint8Array(
      size * size
    );

  const regionIndices =
    Array.from(regionSet);

  for (
    const idx of regionIndices
  ) {
    regionMask[idx] = 1;
  }

  for (
    let iter = 0;
    iter < iterations;
    iter++
  ) {
    const next =
      new Float32Array(
        heightMap
      );

    let processed = 0;

    for (
      const idx of regionIndices
    ) {
      if (
        fixedSet.has(idx)
      ) {
        continue;
      }

      const row =
        Math.floor(
          idx / size
        );

      const col =
        idx -
        row * size;

      let sum = 0;
      let count = 0;

      for (
        let dr = -1;
        dr <= 1;
        dr++
      ) {
        const rr =
          row + dr;

        if (
          rr < 0 ||
          rr >= size
        ) {
          continue;
        }

        for (
          let dc = -1;
          dc <= 1;
          dc++
        ) {
          const cc =
            col + dc;

          if (
            cc < 0 ||
            cc >= size
          ) {
            continue;
          }

          const nIdx =
            rr * size + cc;

          if (
            !regionMask[nIdx]
          ) {
            continue;
          }

          sum +=
            heightMap[nIdx];

          count++;
        }
      }

      if (!count) {
        continue;
      }

      const naturalH =
        sourceHeightMap[idx];

      const smoothed =
        Math.max(
          naturalH,
          sum / count
        );

      next[idx] =
        smoothed;

      processed++;

      if (
        yieldFn &&
        processed %
          yieldEveryPixels ===
          0
      ) {
        await yieldFn();
      }
    }

    processed = 0;

    for (
      const idx of regionIndices
    ) {
      if (
        fixedSet.has(idx)
      ) {
        continue;
      }

      heightMap[idx] =
        next[idx];

      processed++;

      if (
        yieldFn &&
        processed %
          yieldEveryPixels ===
          0
      ) {
        await yieldFn();
      }
    }
  }
}
