// services/buildings/realisticBuildingGenerator.js

/**
 * Realistic procedural building generator.
 *
 * Converts an OSM building feature into a renderer-friendly building
 * description.
 *
 * IMPORTANT:
 * This does NOT assume every building is a red-roof box.
 *
 * It uses OSM tags where available and otherwise makes conservative
 * architectural estimates.
 */

const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;

const METERS_PER_LEVEL = 2.9;
const MIN_BUILDING_HEIGHT = 2.5;
const DEFAULT_HOUSE_LEVELS = 1;
const DEFAULT_APARTMENT_LEVELS = 3;
const DEFAULT_OFFICE_LEVELS = 3;

/**
 * Web Mercator projection.
 *
 * This matches the projection used by terrain.js.
 */
export function project(lat, lng, zoom) {
  const d = Math.PI / 180;
  const max = MAX_LATITUDE;

  const latClamped = Math.max(
    Math.min(max, Number(lat)),
    -max
  );

  const sin = Math.sin(latClamped * d);

  const z = TILE_SIZE * Math.pow(2, zoom);

  const x =
    (z * (Number(lng) + 180)) / 360;

  const y =
    z *
    (
      0.5 -
      (
        0.25 *
        Math.log(
          (1 + sin) /
          (1 - sin)
        )
      ) /
      Math.PI
    );

  return { x, y };
}

/**
 * Convert two geographic points to approximate metres.
 */
export function distanceMeters(a, b) {
  const lat1 = Number(a.lat);
  const lat2 = Number(b.lat);

  const lng1 = Number(a.lng);
  const lng2 = Number(b.lng);

  const latRad =
    ((lat1 + lat2) / 2) *
    Math.PI /
    180;

  const metersLat = 110574;
  const metersLng =
    111320 * Math.cos(latRad);

  const dx =
    (lng2 - lng1) *
    metersLng;

  const dy =
    (lat2 - lat1) *
    metersLat;

  return Math.sqrt(
    dx * dx +
    dy * dy
  );
}

/**
 * Calculate footprint dimensions.
 */
function getFootprintDimensions(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 3) {
    return {
      width: 10,
      depth: 10,
      area: 100
    };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const point of geometry) {
    const lat = Number(point.lat);
    const lng = Number(point.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }

  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLat)
  ) {
    return {
      width: 10,
      depth: 10,
      area: 100
    };
  }

  const northWest = {
    lat: maxLat,
    lng: minLng
  };

  const northEast = {
    lat: maxLat,
    lng: maxLng
  };

  const southWest = {
    lat: minLat,
    lng: minLng
  };

  const width = distanceMeters(
    northWest,
    northEast
  );

  const depth = distanceMeters(
    northWest,
    southWest
  );

  return {
    width: Math.max(2, width),
    depth: Math.max(2, depth),
    area: Math.max(
      4,
      width * depth
    )
  };
}

/**
 * Parse a numeric OSM tag.
 */
function numericTag(tags, key) {
  const value = Number(tags?.[key]);

  return Number.isFinite(value)
    ? value
    : null;
}

/**
 * Determine building type.
 */
function getBuildingType(tags = {}) {
  const type = String(
    tags.building ||
    tags["building:type"] ||
    "yes"
  ).toLowerCase();

  if (
    type === "house" ||
    type === "detached" ||
    type === "semidetached_house" ||
    type === "terrace"
  ) {
    return "residential";
  }

  if (
    type === "apartments" ||
    type === "residential"
  ) {
    return "apartments";
  }

  if (
    type === "commercial" ||
    type === "office"
  ) {
    return "commercial";
  }

  if (
    type === "retail" ||
    type === "supermarket"
  ) {
    return "retail";
  }

  if (
    type === "industrial" ||
    type === "warehouse"
  ) {
    return "industrial";
  }

  if (
    type === "school" ||
    type === "university" ||
    type === "college"
  ) {
    return "education";
  }

  if (
    type === "church" ||
    type === "cathedral" ||
    type === "chapel"
  ) {
    return "religious";
  }

  if (
    type === "garage" ||
    type === "garages"
  ) {
    return "garage";
  }

  return "generic";
}

/**
 * Determine realistic floor count.
 */
function getLevels(tags, type, dimensions) {
  const explicitLevels =
    numericTag(tags, "building:levels");

  if (
    explicitLevels !== null &&
    explicitLevels > 0
  ) {
    return Math.max(
      1,
      Math.round(explicitLevels)
    );
  }

  switch (type) {
    case "residential":
      return dimensions.area > 350
        ? 2
        : DEFAULT_HOUSE_LEVELS;

    case "apartments":
      return DEFAULT_APARTMENT_LEVELS;

    case "commercial":
      return DEFAULT_OFFICE_LEVELS;

    case "education":
      return 2;

    case "industrial":
      return 1;

    case "religious":
      return 1;

    case "garage":
      return 1;

    default:
      return 2;
  }
}

/**
 * Determine wall height.
 */
function getHeight(tags, levels) {
  const explicitHeight =
    numericTag(tags, "height");

  if (
    explicitHeight !== null &&
    explicitHeight >= MIN_BUILDING_HEIGHT
  ) {
    return explicitHeight;
  }

  const roofHeight =
    numericTag(tags, "roof:height") || 0;

  return Math.max(
    MIN_BUILDING_HEIGHT,
    levels * METERS_PER_LEVEL + roofHeight
  );
}

/**
 * Determine roof shape.
 */
function getRoofShape(tags, type) {
  const explicit =
    String(tags["roof:shape"] || "")
      .toLowerCase()
      .trim();

  if (explicit) {
    const allowed = [
      "flat",
      "gabled",
      "hipped",
      "pyramidal",
      "mansard",
      "skillion",
      "dome",
      "round",
      "half-hipped"
    ];

    if (allowed.includes(explicit)) {
      return explicit;
    }
  }

  /**
   * Don't randomly put red pitched roofs everywhere.
   *
   * Defaults are deliberately conservative.
   */
  switch (type) {
    case "residential":
      return "gabled";

    case "apartments":
      return "flat";

    case "commercial":
      return "flat";

    case "retail":
      return "flat";

    case "industrial":
      return "flat";

    case "education":
      return "flat";

    case "religious":
      return "gabled";

    case "garage":
      return "gabled";

    default:
      return "flat";
  }
}

/**
 * Determine wall material.
 */
function getWallMaterial(tags, type) {
  const material =
    String(
      tags["building:material"] ||
      tags.material ||
      ""
    ).toLowerCase();

  if (material) {
    return material;
  }

  switch (type) {
    case "residential":
      return "siding";

    case "apartments":
      return "stucco";

    case "commercial":
      return "concrete";

    case "retail":
      return "concrete";

    case "industrial":
      return "metal";

    case "education":
      return "brick";

    case "religious":
      return "stone";

    case "garage":
      return "siding";

    default:
      return "concrete";
  }
}

/**
 * Determine roof material.
 */
function getRoofMaterial(tags, roofShape, type) {
  const material =
    String(
      tags["roof:material"] ||
      ""
    ).toLowerCase();

  if (material) {
    return material;
  }

  if (
    roofShape === "flat"
  ) {
    return "membrane";
  }

  if (
    type === "industrial"
  ) {
    return "metal";
  }

  if (
    type === "religious"
  ) {
    return "tile";
  }

  return "shingles";
}

/**
 * Determine colours without forcing a red roof.
 */
function getColors(tags, type, wallMaterial, roofMaterial) {
  const wall =
    tags["building:colour"] ||
    tags.colour ||
    null;

  const roof =
    tags["roof:colour"] ||
    null;

  return {
    wall: wall || defaultWallColor(
      type,
      wallMaterial
    ),

    roof: roof || defaultRoofColor(
      roofMaterial
    )
  };
}

function defaultWallColor(type, material) {
  if (material === "brick") {
    return "#9a7560";
  }

  if (material === "stone") {
    return "#9b968c";
  }

  if (material === "metal") {
    return "#777777";
  }

  if (type === "residential") {
    return "#d0c7b7";
  }

  if (type === "apartments") {
    return "#b7afa2";
  }

  return "#a7a39b";
}

function defaultRoofColor(material) {
  /**
   * Neutral roofing.
   *
   * No artificial red roof.
   */
  switch (material) {
    case "tile":
      return "#77716a";

    case "metal":
      return "#60666a";

    case "membrane":
      return "#4e5355";

    case "slate":
      return "#4c5054";

    default:
      return "#575451";
  }
}

/**
 * Generate realistic facade information.
 */
function generateFacade(
  type,
  levels,
  dimensions
) {
  let windowStyle = "standard";
  let windowRows = levels;

  if (type === "industrial") {
    windowStyle = "high-bay";
    windowRows = Math.min(
      levels,
      2
    );
  }

  if (type === "retail") {
    windowStyle = "storefront";
    windowRows = 1;
  }

  if (type === "apartments") {
    windowStyle = "apartment";
  }

  if (type === "religious") {
    windowStyle = "arched";
    windowRows = 1;
  }

  const windowsPerLongSide =
    Math.max(
      1,
      Math.min(
        12,
        Math.round(dimensions.width / 2.8)
      )
    );

  return {
    windowStyle,
    windowRows,
    windowsPerLongSide,
    doorCount:
      type === "retail"
        ? Math.max(
            1,
            Math.round(dimensions.width / 8)
          )
        : 1
  };
}

/**
 * Generate building geometry instructions.
 *
 * This does NOT directly depend on Three.js.
 * Your Vue/Three renderer can consume the result.
 */
export function generateRealisticBuilding(
  feature,
  options = {}
) {
  const tags = feature?.tags || {};

  const geometry =
    feature?.geometry || [];

  const dimensions =
    getFootprintDimensions(
      geometry
    );

  const type =
    getBuildingType(tags);

  const levels =
    getLevels(
      tags,
      type,
      dimensions
    );

  const height =
    getHeight(
      tags,
      levels
    );

  const roofShape =
    getRoofShape(
      tags,
      type
    );

  const roofHeight =
    numericTag(
      tags,
      "roof:height"
    ) ||
    (
      roofShape === "flat"
        ? 0.15
        : Math.max(
            1.2,
            dimensions.width * 0.16
          )
    );

  const wallMaterial =
    getWallMaterial(
      tags,
      type
    );

  const roofMaterial =
    getRoofMaterial(
      tags,
      roofShape,
      type
    );

  const colors =
    getColors(
      tags,
      type,
      wallMaterial,
      roofMaterial
    );

  const facade =
    generateFacade(
      type,
      levels,
      dimensions
    );

  /**
   * Small architectural details.
   */
  const details = {
    chimney:
      type === "residential" &&
      dimensions.area > 80,

    balconies:
      type === "apartments" &&
      dimensions.width > 12,

    awning:
      type === "retail",

    loadingDock:
      type === "industrial" &&
      dimensions.width > 15,

    rooftopEquipment:
      type === "commercial" ||
      type === "retail" ||
      type === "industrial"
  };

  return {
    id:
      feature.id ||
      feature.properties?.id ||
      null,

    type,

    footprint: geometry,

    dimensions: {
      width: dimensions.width,
      depth: dimensions.depth,
      area: dimensions.area
    },

    structure: {
      levels,
      height,
      wallHeight: Math.max(
        MIN_BUILDING_HEIGHT,
        height - roofHeight
      ),
      roofHeight
    },

    roof: {
      shape: roofShape,
      material: roofMaterial,
      color: colors.roof
    },

    facade: {
      material: wallMaterial,
      color: colors.wall,
      ...facade
    },

    details,

    address: {
      houseNumber:
        tags["addr:housenumber"] ||
        null,

      street:
        tags["addr:street"] ||
        null,

      city:
        tags["addr:city"] ||
        null
    },

    name:
      tags.name ||
      null,

    /**
     * Preserve original OSM data for future renderers.
     */
    osm: {
      building:
        tags.building ||
        null,

      roofShape:
        tags["roof:shape"] ||
        null,

      height:
        tags.height ||
        null,

      levels:
        tags["building:levels"] ||
        null
    },

    /**
     * Rendering hints.
     */
    render: {
      useProceduralFacade:
        options.useProceduralFacade !== false,

      useWindows:
        options.useWindows !== false,

      useRoof:
        options.useRoof !== false,

      detailLevel:
        options.detailLevel ||
        "medium"
    }
  };
}

export default generateRealisticBuilding;
