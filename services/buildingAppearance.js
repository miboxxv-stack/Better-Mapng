import {
  BUILDING_TYPES,
  normalizeBuildingType,
} from "./buildingTypes.js";

/**
 * Deterministic number from a building ID.
 *
 * This makes the same building keep the same appearance
 * between exports without requiring random changes every time.
 */
function hashString(value = "") {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash =
      ((hash << 5) - hash) +
      value.charCodeAt(i);

    hash |= 0;
  }

  return Math.abs(hash);
}

function choose(values, seed) {
  return values[seed % values.length];
}

/**
 * Convert OSM height/level information into a useful building height.
 */
export function getBuildingHeight(feature) {
  const tags =
    feature?.tags ||
    feature?.properties ||
    {};

  const explicitHeight =
    Number.parseFloat(
      String(tags.height || "").replace(/[^\d.]/g, "")
    );

  if (
    Number.isFinite(explicitHeight) &&
    explicitHeight >= 2
  ) {
    return Math.min(80, explicitHeight);
  }

  const levels =
    Number.parseFloat(
      String(tags["building:levels"] || "")
    );

  if (
    Number.isFinite(levels) &&
    levels > 0
  ) {
    return Math.max(
      2.8,
      Math.min(80, levels * 3.0)
    );
  }

  switch (normalizeBuildingType(feature)) {
    case BUILDING_TYPES.HOUSE:
    case BUILDING_TYPES.DETACHED:
    case BUILDING_TYPES.SEMI_DETACHED:
      return 5.5;

    case BUILDING_TYPES.GARAGE:
      return 3;

    case BUILDING_TYPES.SHED:
      return 2.5;

    case BUILDING_TYPES.APARTMENTS:
      return 12;

    case BUILDING_TYPES.OFFICE:
      return 15;

    case BUILDING_TYPES.INDUSTRIAL:
    case BUILDING_TYPES.WAREHOUSE:
      return 7;

    case BUILDING_TYPES.SCHOOL:
      return 8;

    case BUILDING_TYPES.CHURCH:
      return 10;

    default:
      return 6;
  }
}

/**
 * Pick a realistic neutral architectural palette.
 *
 * No default bright-red roof.
 */
export function getBuildingAppearance(feature) {
  const id =
    String(
      feature?.id ||
      feature?.properties?.id ||
      feature?.tags?.name ||
      "building"
    );

  const seed = hashString(id);

  const wallMaterials = [
    {
      name: "light_siding",
      color: 0xd6d0c5,
    },
    {
      name: "cream",
      color: 0xc8bda8,
    },
    {
      name: "gray_siding",
      color: 0xaaa9a3,
    },
    {
      name: "beige",
      color: 0xc5b79e,
    },
    {
      name: "brick",
      color: 0x876f62,
    },
    {
      name: "concrete",
      color: 0x9b9b95,
    },
  ];

  const roofMaterials = [
    {
      name: "dark_gray",
      color: 0x4d4d4a,
    },
    {
      name: "charcoal",
      color: 0x353635,
    },
    {
      name: "brown",
      color: 0x66554a,
    },
    {
      name: "weathered_gray",
      color: 0x73736d,
    },
  ];

  const windows = [
    0x6f8588,
    0x7d8d8d,
    0x53666a,
  ];

  const doors = [
    0x5d5147,
    0x70685f,
    0x4b4b48,
  ];

  return {
    type: normalizeBuildingType(feature),

    wall: choose(
      wallMaterials,
      seed
    ),

    roof: choose(
      roofMaterials,
      seed + 3
    ),

    windowColor: choose(
      windows,
      seed + 5
    ),

    doorColor: choose(
      doors,
      seed + 7
    ),

    height: getBuildingHeight(feature),
  };
}