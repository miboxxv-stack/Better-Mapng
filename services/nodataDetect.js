/**
 * Detection of *undeclared* no-data fill values in uploaded elevation rasters.
 *
 * National LiDAR portals routinely clip a DTM export to a project polygon and
 * fill everything outside it with a constant — but ship the GeoTIFF without a
 * GDAL_NODATA tag. Kartverket's hoydedata.no fills with 0.0; others use -9999,
 * -32767 or the float32 extremes. Read literally, those fills are valid
 * elevations, which breaks two things at once:
 *
 *   1. Every filled pixel becomes a flat plateau at that elevation, walled off
 *      from the real terrain around it.
 *   2. Where tiles overlap, the mosaic picks the first tile that returns a
 *      non-nodata value (see sampleHeightAt in resamplerWorker.js). A filled
 *      tile therefore *wins* over an overlapping tile that has real data
 *      there, so an area covered by two complete surveys still comes out full
 *      of holes.
 *
 * The detector below is deliberately conservative: it only reports a value it
 * can argue is not terrain, and the user can always override the result.
 */

export const NODATA_AUTO = 'auto';
export const NODATA_NONE = 'none';

/** Fallback used throughout the pipeline when nothing declares a no-data value. */
export const NODATA_FALLBACK = -99999;

// Elevations outside this range are not terrain in metres or feet, so any value
// repeated here is a sentinel. Floor sits below the Dead Sea shore (-430 m) and
// below plausible bathymetry noise; ceiling sits above Everest in feet (29 032 ft).
const MIN_PLAUSIBLE_ELEVATION = -1000;
const MAX_PLAUSIBLE_ELEVATION = 30000;

// A value that cannot be terrain needs only a token presence to be believed…
const MIN_IMPLAUSIBLE_SHARE = 0.001;
// …but a plausible one (0.0 above all) has to carry the raster to be suspected.
const MIN_PLAUSIBLE_SHARE = 0.02;

// A fill constant is a lone spike: nothing sits just next to it in value space.
// A genuine plateau (lake surface, polder, flat plain) is surrounded by its own
// shoreline, so its immediate neighbourhood is populated.
const SPIKE_RATIO = 50;
// Neighbourhood width, as a fraction of the raster's real elevation range.
const NEIGHBOURHOOD_FRACTION = 0.02;
// A fill constant also sits at the edge of the distribution — at most this
// share of the raster may lie beyond it.
const MAX_BEYOND_SHARE = 0.005;

// Cap the work per raster; fill regions are large and contiguous, so a strided
// sample estimates their share accurately.
const MAX_SAMPLES = 400000;
// Guard against pathological rasters (e.g. noise) blowing up the value map.
const MAX_DISTINCT_TRACKED = 200000;

const isPlausibleElevation = (v) => v > MIN_PLAUSIBLE_ELEVATION && v < MAX_PLAUSIBLE_ELEVATION;

/**
 * Inspect a raster for an undeclared no-data fill value.
 *
 * @param {Float32Array|Array<number>} raster
 * @param {{ taggedNoData?: number|null }} [options]
 * @returns {{
 *   value: number|null,          // the no-data value to apply, if any
 *   source: 'tag'|'detected'|null,
 *   share: number,               // fraction of the raster holding that value
 *   reason: string|null,         // 'implausible' | 'isolated-spike'
 *   candidate: number|null,      // most frequent value, even when rejected
 *   candidateShare: number,
 *   rejectedBecause: string|null,
 * }}
 */
export const detectNoDataInRaster = (raster, { taggedNoData = null } = {}) => {
  const empty = {
    value: null,
    source: null,
    share: 0,
    reason: null,
    candidate: null,
    candidateShare: 0,
    rejectedBecause: null,
  };

  // An explicit GDAL_NODATA tag is authoritative — never second-guess it.
  if (Number.isFinite(taggedNoData)) {
    return { ...empty, value: Number(taggedNoData), source: 'tag' };
  }

  const length = raster?.length || 0;
  if (length === 0) return empty;

  const stride = Math.max(1, Math.ceil(length / MAX_SAMPLES));
  const counts = new Map();
  let sampled = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < length; i += stride) {
    const v = raster[i];
    if (!Number.isFinite(v)) continue; // NaN/Inf are already treated as holes
    sampled++;
    if (v < min) min = v;
    if (v > max) max = v;
    const seen = counts.get(v);
    if (seen !== undefined) counts.set(v, seen + 1);
    else if (counts.size < MAX_DISTINCT_TRACKED) counts.set(v, 1);
  }

  if (sampled === 0) return empty;

  let candidate = null;
  let candidateCount = 0;
  for (const [value, count] of counts) {
    if (count > candidateCount) {
      candidate = value;
      candidateCount = count;
    }
  }
  if (candidate === null) return empty;

  const candidateShare = candidateCount / sampled;
  const base = { ...empty, candidate, candidateShare };

  // ── Case 1: the value cannot be an elevation at all ───────────────────────
  if (!isPlausibleElevation(candidate)) {
    if (candidateShare < MIN_IMPLAUSIBLE_SHARE) {
      return { ...base, rejectedBecause: 'too-rare' };
    }
    return {
      ...base,
      value: candidate,
      source: 'detected',
      share: candidateShare,
      reason: 'implausible',
    };
  }

  // ── Case 2: a plausible elevation (0.0 and friends) ───────────────────────
  // Only believed when it dominates the raster, sits at the edge of the value
  // distribution, and has nothing immediately next to it.
  if (candidateShare < MIN_PLAUSIBLE_SHARE) {
    return { ...base, rejectedBecause: 'too-rare' };
  }

  let below = 0;
  let above = 0;
  let realMin = Infinity;
  let realMax = -Infinity;
  for (const [value, count] of counts) {
    if (value === candidate) continue;
    if (value < candidate) below += count;
    else above += count;
    if (value < realMin) realMin = value;
    if (value > realMax) realMax = value;
  }
  if (!Number.isFinite(realMin)) {
    // Nothing but the candidate — a fully filled tile. Believe it only if the
    // upload's other tiles agree (see reconcileTileNoData).
    return {
      ...base,
      value: candidate,
      source: 'detected',
      share: candidateShare,
      reason: 'uniform',
    };
  }

  const beyondShare = Math.min(below, above) / sampled;
  if (beyondShare > MAX_BEYOND_SHARE) {
    return { ...base, rejectedBecause: 'interior-value' };
  }

  const range = realMax - realMin;
  const window = Math.max(Number.EPSILON, range * NEIGHBOURHOOD_FRACTION);
  let neighbours = 0;
  for (const [value, count] of counts) {
    if (value === candidate) continue;
    if (Math.abs(value - candidate) <= window) neighbours += count;
  }

  if (candidateCount / Math.max(1, neighbours) < SPIKE_RATIO) {
    return { ...base, rejectedBecause: 'has-neighbours' };
  }

  return {
    ...base,
    value: candidate,
    source: 'detected',
    share: candidateShare,
    reason: 'isolated-spike',
  };
};

/**
 * Reduce per-tile detections from one upload to a single no-data value.
 *
 * Tiles that sit fully inside a survey polygon carry no fill at all and detect
 * nothing; tiles clipped by a sliver carry too little to clear the threshold.
 * Both still need the mosaic to mask that value, otherwise thin seams survive
 * along the polygon edge — so the value the confident tiles agree on is applied
 * to every tile in the upload.
 *
 * @param {Array<ReturnType<typeof detectNoDataInRaster>>} detections
 * @returns {{ value: number|null, source: 'tag'|'detected'|null, tileCount: number, totalTiles: number, share: number, reason: string|null }}
 */
export const reconcileTileNoData = (detections = []) => {
  const list = detections.filter(Boolean);
  const none = { value: null, source: null, tileCount: 0, totalTiles: list.length, share: 0, reason: null };
  if (list.length === 0) return none;

  // A tagged value on any tile wins outright over anything inferred.
  const tagged = list.find((d) => d.source === 'tag');
  if (tagged) {
    const matching = list.filter((d) => d.source === 'tag' && d.value === tagged.value);
    return {
      value: tagged.value,
      source: 'tag',
      tileCount: matching.length,
      totalTiles: list.length,
      share: 0,
      reason: null,
    };
  }

  const buckets = new Map();
  for (const d of list) {
    if (d.source !== 'detected' || d.value === null) continue;
    // A uniform tile agrees with a consensus but never establishes one.
    if (d.reason === 'uniform' && list.length > 1) continue;
    const bucket = buckets.get(d.value) || { tiles: 0, shareSum: 0, reason: d.reason };
    bucket.tiles++;
    bucket.shareSum += d.share;
    buckets.set(d.value, bucket);
  }
  if (buckets.size === 0) return none;

  let best = null;
  for (const [value, bucket] of buckets) {
    if (!best || bucket.tiles > best.bucket.tiles
      || (bucket.tiles === best.bucket.tiles && bucket.shareSum > best.bucket.shareSum)) {
      best = { value, bucket };
    }
  }

  return {
    value: best.value,
    source: 'detected',
    tileCount: best.bucket.tiles,
    totalTiles: list.length,
    share: best.bucket.shareSum / best.bucket.tiles,
    reason: best.bucket.reason,
  };
};

/**
 * Apply the user's no-data choice on top of what parsing detected.
 *
 * @param {object|null} detection - the `noDataDetection` block on an upload meta
 * @param {string|number} override - NODATA_AUTO, NODATA_NONE, or an explicit value
 * @returns {number|null} the no-data value the pipeline should use
 */
export const resolveNoDataValue = (detection, override = NODATA_AUTO) => {
  if (override === NODATA_NONE) return null;
  if (override !== NODATA_AUTO && override !== undefined && override !== null && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.isFinite(detection?.value) ? detection.value : null;
};
