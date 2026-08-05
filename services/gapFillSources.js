/**
 * Which elevation dataset fills the gaps in an uploaded DEM.
 *
 * Uploaded LiDAR almost never covers a whole export area — survey polygons are
 * irregular, and everything outside one arrives as no-data fill (see
 * nodataDetect.js). Left alone those gaps get synthesised by the inpainter,
 * which invents terrain. Filling them from a real dataset and blending the seam
 * (blendGapFillIntoHoles in resamplerWorker.js) keeps the surroundings honest.
 */

/** Global Terrarium tiles — always available, no key required. */
export const GAP_FILL_STANDARD = 'standard';
/** GPXZ hires rasters — needs the user's API key, falls back to standard. */
export const GAP_FILL_GPXZ = 'gpxz';
/** Leave the gaps for the inpainter (the behaviour before gap filling existed). */
export const GAP_FILL_NONE = 'none';

export const GAP_FILL_SOURCES = [GAP_FILL_STANDARD, GAP_FILL_GPXZ, GAP_FILL_NONE];

export const DEFAULT_GAP_FILL_SOURCE = GAP_FILL_STANDARD;

export const normalizeGapFillSource = (value) => {
  const mode = String(value || '').toLowerCase();
  return GAP_FILL_SOURCES.includes(mode) ? mode : DEFAULT_GAP_FILL_SOURCE;
};
