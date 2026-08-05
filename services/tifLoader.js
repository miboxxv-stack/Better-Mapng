import * as GeoTIFF from 'geotiff';
import { isLikelyGmlText, parseGmlFile, parseGmlText, parseGmlZipFile } from './gmlLoader.js';
import { parseAscFile, parseAscText } from './ascLoader.js';
import { detectNoDataInRaster, reconcileTileNoData, NODATA_FALLBACK } from './nodataDetect.js';
import { groupTilesIntoLayers } from './elevationLayers.js';
import {
  computeGeoMetadata,
  detectUnitFromText,
  summarizeCoverageBounds,
  UNIT_FEET,
  UNIT_METERS,
  UNIT_UNKNOWN,
  UNIT_US_SURVEY_FEET,
  USER_DEFINED_CRS,
} from './uploadGeoMetadata.js';

export { parseGmlText, parseAscText };

const mapLinearUnitCode = (code) => {
  if (code === 9001) return UNIT_METERS;
  if (code === 9002) return UNIT_FEET;
  if (code === 9003) return UNIT_US_SURVEY_FEET;
  return UNIT_UNKNOWN;
};

/**
 * Parse supported raster/grid-based elevation uploads into a normalized
 * metadata shape consumed by the terrain pipeline.
 *
 * Supported inputs:
 * - GeoTIFF / TIFF: .tif, .tiff
 * - ASCII Grid: .asc
 * - GML/XML (single tile) and ZIP archives containing GML tiles
 */
export const parseRasterOrGridElevationFile = async (file) => {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.asc')) {
    return parseAscFile(file);
  }
  if (lowerName.endsWith('.zip')) {
    return parseGmlZipFile(file);
  }
  if (lowerName.endsWith('.gml') || lowerName.endsWith('.xml')) {
    const text = await file.text();
    if (isLikelyGmlText(text)) {
      return parseGmlFile(file);
    }
    if (lowerName.endsWith('.gml')) {
      return parseGmlFile(file);
    }
  }

  const buffer = await file.arrayBuffer();
  const tiff = await GeoTIFF.fromArrayBuffer(buffer);
  const image = await tiff.getImage();

  // Read band 0 as a Float32Array (matches the format fetchGPXZRaw produces)
  const rasters = await image.readRasters();
  const rawBand = rasters[0];
  const raster = rawBand instanceof Float32Array
    ? rawBand
    : new Float32Array(rawBand);

  const sourceWidth = image.getWidth();
  const sourceHeight = image.getHeight();
  const fileDirectory = image.getFileDirectory?.() || {};
  const bitsPerSample = Array.isArray(fileDirectory.BitsPerSample)
    ? fileDirectory.BitsPerSample
    : (fileDirectory.BitsPerSample != null ? [fileDirectory.BitsPerSample] : []);
  const samplesPerPixel = Number(fileDirectory.SamplesPerPixel || bitsPerSample.length || 1);
  const photometric = Number(fileDirectory.PhotometricInterpretation);

  // ── Detect GeoTIFF ──────────────────────────────────────────────────────────
  const geoKeys = image.getGeoKeys();
  const epsgCode = geoKeys?.ProjectedCSTypeGeoKey || geoKeys?.GeographicTypeGeoKey;

  // 32767 = user-defined CRS in GeoTIFF spec — not a real EPSG code
  const isGeoTiff = !!epsgCode && epsgCode !== USER_DEFINED_CRS;

  let bounds = null;
  let center = null;
  let nativeMetersPerPixel = null;
  let nativeWidth = null;
  let nativeHeight = null;
  let suggestedResolution = null;
  let verticalUnitDetected = UNIT_UNKNOWN;
  let verticalUnitDetectionSource = null;
  let isLikelyElevation = true;
  let elevationValidationMessage = '';

  const isColorPhotometric = [2, 5, 6, 8].includes(photometric); // RGB, CMYK, YCbCr, CIELab
  const is8BitRaster = bitsPerSample.length > 0 && bitsPerSample.every((v) => Number(v) <= 8);
  if (samplesPerPixel >= 3 && (isColorPhotometric || is8BitRaster)) {
    isLikelyElevation = false;
    elevationValidationMessage = 'Uploaded GeoTIFF appears to be color imagery (RGB/CIR), not an elevation raster (DEM/DTM). Please upload a single-band elevation GeoTIFF.';
  }

  // GeoTIFF vertical unit keys (EPSG unit codes): 9001=m, 9002=ft, 9003=US survey ft
  const verticalUnitCode = geoKeys?.VerticalUnitsGeoKey;
  const modelLinearUnitCode = geoKeys?.ProjLinearUnitsGeoKey;
  if (Number.isFinite(verticalUnitCode)) {
    verticalUnitDetected = mapLinearUnitCode(verticalUnitCode);
    verticalUnitDetectionSource = 'VerticalUnitsGeoKey';
  } else if (Number.isFinite(modelLinearUnitCode)) {
    // Fallback heuristic when explicit vertical unit is absent.
    verticalUnitDetected = mapLinearUnitCode(modelLinearUnitCode);
    verticalUnitDetectionSource = 'ProjLinearUnitsGeoKey';
  }

  if (verticalUnitDetected === UNIT_UNKNOWN) {
    const asciiText = String(fileDirectory.GeoAsciiParamsTag || '');
    const fromAscii = detectUnitFromText(asciiText);
    if (fromAscii !== UNIT_UNKNOWN) {
      verticalUnitDetected = fromAscii;
      verticalUnitDetectionSource = 'GeoAsciiParamsTag';
    }
  }

  if (isGeoTiff) {
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const geoMeta = await computeGeoMetadata({
      epsgCode,
      sourceWidth,
      sourceHeight,
      originX,
      originY,
      resX,
      resY,
      useSampleSpacing: false,
      logPrefix: 'tifLoader',
    });
    bounds = geoMeta.bounds;
    center = geoMeta.center;
    nativeMetersPerPixel = geoMeta.nativeMetersPerPixel;
    nativeWidth = geoMeta.nativeWidth;
    nativeHeight = geoMeta.nativeHeight;
    suggestedResolution = geoMeta.suggestedResolution;
  }

  // GDAL_NODATA is absent on a lot of national LiDAR exports, which fill the
  // area outside their survey polygon with a constant instead. Left unmasked
  // that fill reads as real terrain — see nodataDetect.js.
  const noDataDetection = detectNoDataInRaster(raster, { taggedNoData: image.getGDALNoData() });
  const noData = noDataDetection.value;
  if (noDataDetection.source === 'detected') {
    console.info(`[tifLoader] ${file.name}: no GDAL_NODATA tag — detected fill value ${noData} (${(noDataDetection.share * 100).toFixed(1)}% of pixels, ${noDataDetection.reason}).`);
  }

  return {
    sourceType: 'geotiff',
    sourceFormat: 'geotiff',
    formatLabel: 'GeoTIFF',
    image,
    raster,
    isGeoTiff,
    isGeoReferenced: isGeoTiff,
    epsgCode: isGeoTiff ? epsgCode : null,
    bounds,
    center,
    sourceWidth,
    sourceHeight,
    nativeWidth,
    nativeHeight,
    suggestedResolution,
    nativeMetersPerPixel,
    noData,
    noDataDetection,
    layers: [{ id: 'upload', label: file.name, year: null, indices: [0] }],
    isLikelyElevation,
    elevationValidationMessage,
    fileSize: file.size,
    verticalUnitDetected,
    verticalUnitDetectionSource,
  };
};

// Backward-compatible alias; prefer parseRasterOrGridElevationFile() in new code.
export const parseTifFile = async (file) => parseRasterOrGridElevationFile(file);

/**
 * Union a list of {north, south, east, west} bounds, ignoring any that are
 * missing or non-finite. Returns null when no valid bounds are present.
 */
const unionBounds = (boundsList) => {
  const valid = (boundsList || []).filter(
    (b) => b && ['north', 'south', 'east', 'west'].every((k) => Number.isFinite(b[k])),
  );
  if (!valid.length) return null;
  return {
    north: Math.max(...valid.map((b) => b.north)),
    south: Math.min(...valid.map((b) => b.south)),
    east: Math.max(...valid.map((b) => b.east)),
    west: Math.min(...valid.map((b) => b.west)),
  };
};

/**
 * Parse multiple GeoTIFF tiles into a single merged metadata object. Each tile
 * keeps its own geo-referencing; the resampler worker (see prepareTiles in
 * resamplerClient.js) samples across all images in the returned `images` array.
 *
 * All tiles must be geo-referenced GeoTIFFs — the user-defined-CRS stretch
 * fallback in loadTerrainFromTif only supports a single image.
 */
export const parseTifFiles = async (files = []) => {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length === 0) {
    throw new Error('No GeoTIFF files selected.');
  }
  if (list.length === 1) {
    return parseRasterOrGridElevationFile(list[0]);
  }

  const parsedList = await Promise.all(list.map((file) => parseRasterOrGridElevationFile(file)));

  const ungeoreferenced = parsedList.filter((meta) => !meta?.isGeoTiff || !meta?.bounds);
  if (ungeoreferenced.length > 0) {
    throw new Error('Multiple-file GeoTIFF upload requires every tile to be a geo-referenced GeoTIFF. Upload a single GeoTIFF for files without an embedded CRS.');
  }

  const notElevation = parsedList.find((meta) => meta?.isLikelyElevation === false);
  if (notElevation) {
    throw new Error(notElevation.elevationValidationMessage || 'One of the uploaded GeoTIFFs is not a valid elevation raster.');
  }

  const mergedBounds = unionBounds(parsedList.map((meta) => meta.bounds));
  const coverageSummary = summarizeCoverageBounds(mergedBounds);
  const totalFileSize = parsedList.reduce((sum, meta) => sum + Number(meta.fileSize || 0), 0);
  const unitMeta = parsedList.find((meta) => meta.verticalUnitDetected && meta.verticalUnitDetected !== UNIT_UNKNOWN);

  // Group the tiles back into the surveys they came from. Each survey clips to
  // its own polygon, so consensus on the fill value is reached per layer and
  // the layers form the priority stack the resampler falls through.
  const layers = groupTilesIntoLayers(list.map((file) => ({ fileName: file.name })));

  // Tiles fully inside a survey polygon carry no fill and detect nothing, and
  // tiles clipped by a sliver carry too little to be sure — so the value the
  // confident tiles of that survey agree on is applied to all of its tiles.
  // Without this the mosaic keeps letting a filled tile win over an overlapping
  // tile that has real data there, and the terrain comes out full of holes.
  const layerNoData = new Array(parsedList.length).fill(null);
  const layerDetections = layers.map((layer) => {
    const detection = reconcileTileNoData(layer.indices.map((i) => parsedList[i].noDataDetection));
    for (const i of layer.indices) layerNoData[i] = detection.value;
    return detection;
  });
  const noDataDetection = reconcileTileNoData(parsedList.map((meta) => meta.noDataDetection));
  const mergedNoData = noDataDetection.value;
  layers.forEach((layer, index) => {
    const detection = layerDetections[index];
    if (detection.source === 'detected') {
      console.info(`[tifLoader] Layer "${layer.label}" (${layer.indices.length} tiles): no GDAL_NODATA tag — applying detected fill value ${detection.value} (agreed by ${detection.tileCount}/${detection.totalTiles}, ${detection.reason}).`);
    }
  });
  console.info(`[tifLoader] Upload resolved to ${layers.length} elevation layer(s): ${layers.map((l) => `${l.label} (${l.indices.length})`).join(' → ')}`);

  return {
    sourceType: 'geotiff',
    sourceFormat: 'geotiff',
    formatLabel: `GeoTIFF (${list.length} tiles)`,
    images: parsedList.map((meta, index) => ({
      image: meta.image,
      raster: meta.raster,
      fileName: list[index]?.name || '',
      // Per-survey no-data: each project clips to its own polygon, so a tile
      // keeps the fill value its own survey agreed on when there is one.
      noData: Number.isFinite(layerNoData[index]) ? layerNoData[index] : NODATA_FALLBACK,
    })),
    layers,
    isGeoTiff: true,
    isGeoReferenced: true,
    epsgCode: parsedList[0]?.epsgCode ?? null,
    bounds: mergedBounds,
    center: coverageSummary.center,
    nativeWidth: coverageSummary.nativeWidth,
    nativeHeight: coverageSummary.nativeHeight,
    suggestedResolution: coverageSummary.suggestedResolution,
    nativeMetersPerPixel: coverageSummary.nativeMetersPerPixel,
    noData: mergedNoData,
    noDataDetection,
    isLikelyElevation: true,
    elevationValidationMessage: '',
    fileSize: totalFileSize,
    verticalUnitDetected: unitMeta?.verticalUnitDetected ?? UNIT_UNKNOWN,
    verticalUnitDetectionSource: unitMeta?.verticalUnitDetectionSource ?? null,
    uploadFileNames: list.map((file) => file.name),
  };
};

/**
 * Merge the already-parsed uploads of several layer slots into one source.
 *
 * Each slot is its own upload (the base survey, then each fallback the user
 * added). Slot order *is* priority order: the layers a slot resolved to keep
 * their relative order and land behind everything from the slots above it.
 *
 * Slots are merged rather than re-parsed together because a slot can be
 * hundreds of megabytes of rasters — adding a fallback must not re-read the
 * ones already in memory.
 *
 * @param {Array<{ meta: object, files: File[] }>} slots
 * @returns {object|null} merged upload metadata, or null when nothing is loaded
 */
export const mergeElevationSlots = (slots = []) => {
  const usable = (slots || []).filter((slot) => slot?.meta);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0].meta;

  const first = usable[0].meta;
  const sourceType = first.sourceType;
  const isGrid = sourceType === 'grid';

  const images = [];
  const gridTiles = [];
  const layers = [];
  const uploadFileNames = [];
  let fileSize = 0;

  usable.forEach((slot, slotIndex) => {
    const meta = slot.meta;
    const offset = isGrid ? gridTiles.length : images.length;
    const slotEntries = isGrid ? (meta.gridTiles || []) : (meta.images || []);
    // A single-file upload has no `images` array of its own.
    const entries = (!isGrid && slotEntries.length === 0 && meta.raster)
      ? [{ image: meta.image, raster: meta.raster, fileName: meta.uploadFileNames?.[0] || '', noData: meta.noData }]
      : slotEntries;

    if (isGrid) gridTiles.push(...entries);
    else images.push(...entries);

    const slotLayers = meta.layers?.length
      ? meta.layers
      : [{ id: 'upload', label: slot.files?.[0]?.name || `Layer ${slotIndex + 1}`, year: null, indices: entries.map((_, i) => i) }];

    for (const layer of slotLayers) {
      layers.push({
        ...layer,
        // Slot-scoped so two slots holding the same survey stay distinct.
        id: `s${slotIndex}:${layer.id}`,
        slotIndex,
        indices: layer.indices.map((i) => i + offset),
      });
    }

    fileSize += Number(meta.fileSize || 0);
    uploadFileNames.push(...(meta.uploadFileNames || (slot.files || []).map((f) => f.name)));
  });

  const mergedBounds = unionBounds(usable.map((slot) => slot.meta.bounds));
  const coverageSummary = summarizeCoverageBounds(mergedBounds);
  const unitMeta = usable.find((slot) => slot.meta.verticalUnitDetected
    && slot.meta.verticalUnitDetected !== UNIT_UNKNOWN)?.meta;
  const notElevation = usable.find((slot) => slot.meta.isLikelyElevation === false)?.meta;

  return {
    sourceType,
    sourceFormat: first.sourceFormat,
    formatLabel: `${usable.length} layers (${isGrid ? gridTiles.length : images.length} tiles)`,
    images: isGrid ? undefined : images,
    gridTiles: isGrid ? gridTiles : undefined,
    layers,
    isGeoTiff: !isGrid,
    isGeoReferenced: !!mergedBounds,
    epsgCode: first.epsgCode ?? null,
    bounds: mergedBounds,
    center: coverageSummary.center,
    nativeWidth: coverageSummary.nativeWidth,
    nativeHeight: coverageSummary.nativeHeight,
    suggestedResolution: coverageSummary.suggestedResolution,
    nativeMetersPerPixel: coverageSummary.nativeMetersPerPixel,
    noData: first.noData,
    // The card reports the base layer's detection; each layer keeps its own
    // value on its tiles regardless.
    noDataDetection: first.noDataDetection,
    isLikelyElevation: !notElevation,
    elevationValidationMessage: notElevation?.elevationValidationMessage || '',
    fileSize,
    verticalUnitDetected: unitMeta?.verticalUnitDetected ?? UNIT_UNKNOWN,
    verticalUnitDetectionSource: unitMeta?.verticalUnitDetectionSource ?? null,
    uploadFileNames,
  };
};

/**
 * Parse multiple grid-based uploads (GML/XML coverages) into a single merged
 * metadata object by concatenating their gridTiles. Mirrors parseAscFiles().
 *
 * Vector GML results (sourceType 'vector') cannot be tile-merged; if every file
 * is vector we defer to the single-file parser for the first file.
 */
export const parseGridFiles = async (files = []) => {
  const list = Array.from(files || []).filter(Boolean);
  if (list.length === 0) {
    throw new Error('No elevation files selected.');
  }
  if (list.length === 1) {
    return parseRasterOrGridElevationFile(list[0]);
  }

  const parsedList = await Promise.all(list.map((file) => parseRasterOrGridElevationFile(file)));

  const gridMetas = parsedList.filter((meta) => meta?.sourceType === 'grid' && Array.isArray(meta.gridTiles) && meta.gridTiles.length > 0);
  if (gridMetas.length === 0) {
    // Nothing tile-mergeable (e.g. all vector GML) — fall back to the first file.
    return parsedList[0];
  }

  const gridTiles = gridMetas.flatMap((meta) => meta.gridTiles);
  const mergedBounds = unionBounds(gridMetas.map((meta) => meta.bounds));
  const coverageSummary = summarizeCoverageBounds(mergedBounds);
  const totalFileSize = parsedList.reduce((sum, meta) => sum + Number(meta.fileSize || 0), 0);
  const unitMeta = parsedList.find((meta) => meta.verticalUnitDetected && meta.verticalUnitDetected !== UNIT_UNKNOWN);
  const baseLabel = (gridMetas[0]?.formatLabel || 'Grid').replace(/\s*\(\d+\s*tiles?\)$/i, '');

  return {
    sourceType: 'grid',
    sourceFormat: 'gml-multi',
    formatLabel: `${baseLabel} (${list.length} tiles)`,
    raster: null,
    sourceWidth: null,
    sourceHeight: null,
    isGeoTiff: false,
    isGeoReferenced: !!mergedBounds,
    epsgCode: gridMetas[0]?.epsgCode ?? null,
    bounds: mergedBounds,
    center: coverageSummary.center,
    nativeWidth: coverageSummary.nativeWidth,
    nativeHeight: coverageSummary.nativeHeight,
    suggestedResolution: coverageSummary.suggestedResolution,
    nativeMetersPerPixel: coverageSummary.nativeMetersPerPixel,
    noData: null,
    gridTiles,
    fileSize: totalFileSize,
    verticalUnitDetected: unitMeta?.verticalUnitDetected ?? UNIT_UNKNOWN,
    verticalUnitDetectionSource: unitMeta?.verticalUnitDetectionSource ?? null,
    uploadFileNames: list.map((file) => file.name),
  };
};
