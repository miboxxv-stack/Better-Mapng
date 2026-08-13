export const BUILDING_TYPES = {
  HOUSE: "house",
  DETACHED: "detached",
  SEMI_DETACHED: "semi_detached",
  APARTMENTS: "apartments",

  COMMERCIAL: "commercial",
  RETAIL: "retail",
  OFFICE: "office",

  INDUSTRIAL: "industrial",
  WAREHOUSE: "warehouse",

  SCHOOL: "school",
  CHURCH: "church",

  GARAGE: "garage",
  SHED: "shed",

  GENERIC: "generic",
};

export function normalizeBuildingType(feature) {
  const tags =
    feature?.tags ||
    feature?.properties ||
    {};

  const type = String(
    tags.building || ""
  ).toLowerCase();

  switch (type) {
    case "house":
      return BUILDING_TYPES.HOUSE;

    case "detached":
      return BUILDING_TYPES.DETACHED;

    case "semidetached_house":
      return BUILDING_TYPES.SEMI_DETACHED;

    case "apartments":
      return BUILDING_TYPES.APARTMENTS;

    case "commercial":
      return BUILDING_TYPES.COMMERCIAL;

    case "retail":
      return BUILDING_TYPES.RETAIL;

    case "office":
      return BUILDING_TYPES.OFFICE;

    case "industrial":
      return BUILDING_TYPES.INDUSTRIAL;

    case "warehouse":
      return BUILDING_TYPES.WAREHOUSE;

    case "school":
      return BUILDING_TYPES.SCHOOL;

    case "church":
      return BUILDING_TYPES.CHURCH;

    case "garage":
      return BUILDING_TYPES.GARAGE;

    case "shed":
      return BUILDING_TYPES.SHED;

    default:
      return BUILDING_TYPES.GENERIC;
  }
}