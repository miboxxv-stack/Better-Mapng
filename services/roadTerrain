/**
 * Road-aware terrain utilities.
 *
 * Roads should remain driveable and should follow their natural longitudinal
 * grade instead of being flattened to one giant horizontal plane.
 *
 * Building foundations can use this module to avoid raising terrain onto roads.
 */

/**
 * Convert WGS84 coordinates to terrain heightmap pixels.
 */
export function geoToHeightMapPx(lat, lng, bounds, size) {
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

/**
 * Detect OSM road features without requiring one exact feature schema.
 */
export function isRoadFeature(feature) {
  if (!feature) return false;

  const properties = feature.properties || {};
  const tags = feature.tags || {};

  const type = String(feature.type || "").toLowerCase();

  return (
    type === "road" ||
    type === "highway" ||
    Boolean(properties.highway) ||
    Boolean(tags.highway)
  );
}

/**
 * Return all OSM road features.
 */
export function getRoadFeatures(osmFeatures = []) {
  return osmFeatures.filter(
    feature =>
      isRoadFeature(feature) &&
      Array.isArray(feature.geometry) &&
      feature.geometry.length >= 2
  );
}

/**
 * Estimate road width from OSM tags.
 *
 * Typical fallback:
 *   2 lanes ≈ 7 m
 *   local road ≈ 6 m
 */
export function getRoadWidthMeters(feature) {
  const tags = feature?.tags || feature?.properties || {};

  const explicitWidth = Number.parseFloat(
    String(tags.width || "").replace(/[^\d.]/g, "")
  );

  if (Number.isFinite(explicitWidth) && explicitWidth >= 2) {
    return Math.min(40, Math.max(3, explicitWidth));
  }

  const lanes = Number.parseFloat(tags.lanes);

  if (Number.isFinite(lanes) && lanes > 0) {
    return Math.min(30, Math.max(4, lanes * 3.2));
  }

  const highway = String(tags.highway || "").toLowerCase();

  switch (highway) {
    case "motorway":
    case "trunk":
      return 12;

    case "primary":
    case "secondary":
      return 9;

    case "tertiary":
      return 8;

    case "residential":
      return 7;

    case "service":
      return 5;

    case "living_street":
      return 6;

    case "track":
      return 4;

    default:
      return 7;
  }
}

/**
 * Squared distance from a point to a line segment.
 */
function distanceSquaredPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0 && dy === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((px - ax) * dx + (py - ay) * dy) /
        (dx * dx + dy * dy)
    )
  );

  const cx = ax + t * dx;
  const cy = ay + t * dy;

  const ex = px - cx;
  const ey = py - cy;

  return ex * ex + ey * ey;
}

/**
 * Build a raster mask around roads.
 *
 * The mask is intentionally a little wider than the actual pavement so
 * building foundations don't accidentally modify road shoulders.
 */
export function buildRoadMask(
  osmFeatures,
  bounds,
  size,
  metersPerPixel,
  extraMeters = 2
) {
  const mask = new Uint8Array(size * size);
  const roads = getRoadFeatures(osmFeatures);

  if (!roads.length) {
    return {
      mask,
      roads,
      hasRoads: false,
    };
  }

  for (const road of roads) {
    const geometry = road.geometry;

    const pixels = geometry.map(point =>
      geoToHeightMapPx(
        point.lat,
        point.lng,
        bounds,
        size
      )
    );

    const widthMeters =
      getRoadWidthMeters(road) / 2 + extraMeters;

    const radiusPx = Math.max(
      1,
      Math.ceil(widthMeters / Math.max(0.01, metersPerPixel))
    );

    for (let i = 0; i < pixels.length - 1; i++) {
      const a = pixels[i];
      const b = pixels[i + 1];

      const minRow = Math.max(
        0,
        Math.floor(Math.min(a.row, b.row) - radiusPx)
      );

      const maxRow = Math.min(
        size - 1,
        Math.ceil(Math.max(a.row, b.row) + radiusPx)
      );

      const minCol = Math.max(
        0,
        Math.floor(Math.min(a.col, b.col) - radiusPx)
      );

      const maxCol = Math.min(
        size - 1,
        Math.ceil(Math.max(a.col, b.col) + radiusPx)
      );

      const radiusSq = radiusPx * radiusPx;

      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const d2 = distanceSquaredPointToSegment(
            col,
            row,
            a.col,
            a.row,
            b.col,
            b.row
          );

          if (d2 <= radiusSq) {
            mask[row * size + col] = 1;
          }
        }
      }
    }
  }

  return {
    mask,
    roads,
    hasRoads: true,
  };
}

/**
 * Return whether a building footprint touches or approaches a road.
 */
export function buildingIsNearRoad(
  buildingIndices,
  roadMask,
  size,
  searchPixels = 12
) {
  if (!buildingIndices.length) return false;

  const visited = new Set();

  for (const index of buildingIndices) {
    const row = Math.floor(index / size);
    const col = index - row * size;

    for (let dr = -searchPixels; dr <= searchPixels; dr++) {
      for (let dc = -searchPixels; dc <= searchPixels; dc++) {
        const rr = row + dr;
        const cc = col + dc;

        if (
          rr < 0 ||
          rr >= size ||
          cc < 0 ||
          cc >= size
        ) {
          continue;
        }

        const idx = rr * size + cc;

        if (visited.has(idx)) continue;
        visited.add(idx);

        if (roadMask[idx]) {
          return true;
        }
      }
    }
  }

  return false;
}
