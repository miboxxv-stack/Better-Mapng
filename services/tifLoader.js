import * as GeoTIFF from 'geotiff';
import { isLikelyGmlText, parseGmlFile, parseGmlText, parseGmlZipFile } from './gmlLoader.js';
import { parseAscFile, parseAscText } from './ascLoader.js';
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

  const noData = image.getGDALNoData() ?? null;
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

  return {
    sourceType: 'geotiff',
    sourceFormat: 'geotiff',
    formatLabel: `GeoTIFF (${list.length} tiles)`,
    images: parsedList.map((meta) => ({ image: meta.image, raster: meta.raster })),
    isGeoTiff: true,
    isGeoReferenced: true,
    epsgCode: parsedList[0]?.epsgCode ?? null,
    bounds: mergedBounds,
    center: coverageSummary.center,
    nativeWidth: coverageSummary.nativeWidth,
    nativeHeight: coverageSummary.nativeHeight,
    suggestedResolution: coverageSummary.suggestedResolution,
    nativeMetersPerPixel: coverageSummary.nativeMetersPerPixel,
    noData: parsedList[0]?.noData ?? null,
    isLikelyElevation: true,
    elevationValidationMessage: '',
    fileSize: totalFileSize,
    verticalUnitDetected: unitMeta?.verticalUnitDetected ?? UNIT_UNKNOWN,
    verticalUnitDetectionSource: unitMeta?.verticalUnitDetectionSource ?? null,
    uploadFileNames: list.map((file) => file.name),
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
