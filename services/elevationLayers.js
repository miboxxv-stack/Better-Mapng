/**
 * Elevation layers: an ordered priority stack of uploaded survey datasets.
 *
 * A single upload is often several surveys at once. Car_Killer's Trollstigen
 * export, for instance, is three Kartverket projects (2020, 2019, 2014) whose
 * tiles overlap: each one covers part of the area and fills the rest with
 * no-data, so no single project covers the map. Flattened into one pile of
 * tiles the winner at any point is whichever file happened to be first.
 *
 * Instead the tiles are grouped back into the surveys they came from, and the
 * user orders those surveys by preference: the first layer supplies everything
 * it has, the next fills what is still empty, and so on, with the global
 * dataset or GPXZ as the final backstop (see gapFillSources.js). Every handover
 * is seam-blended in the resampler worker.
 */

// More layers than this from auto-detection means the filenames have no shared
// structure (every file its own "survey"), which is noise, not a stack.
const MAX_AUTO_LAYERS = 8;

/**
 * Reduce a tile filename to the survey it belongs to.
 *
 * National portals name tiles `<survey>-<grid indices>-<product>.tif`, e.g.
 * `NDH Norddal-Rauma 2pkt 2020-32-1-489-192-16-dtm.tif`. Stripping the product
 * suffix and the trailing run of numeric grid indices leaves the survey name.
 * Anything that does not follow the pattern keeps its whole stem, which simply
 * means it forms its own layer (or, if that fans out, no layering at all).
 */
export const surveyKeyFromFileName = (fileName) => {
  const stem = String(fileName || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .trim();
  if (!stem) return '';
  const withoutProduct = stem.replace(/[-_](dtm|dom|dsm|dem)$/i, '');
  const withoutTileIndices = withoutProduct.replace(/([-_]\d+)+$/, '');
  return (withoutTileIndices || withoutProduct || stem).trim();
};

/** Trailing 4-digit year in a survey name, used to order newest-first. */
const yearFromLabel = (label) => {
  const matches = String(label || '').match(/\b(19|20)\d{2}\b/g);
  if (!matches?.length) return null;
  return Number(matches[matches.length - 1]);
};

/**
 * Group parsed tiles into survey layers, newest first.
 *
 * @param {Array<{fileName: string}>} entries - one per uploaded raster, in upload order
 * @returns {Array<{ id: string, label: string, year: number|null, indices: number[] }>}
 */
export const groupTilesIntoLayers = (entries = []) => {
  const list = (entries || []).filter(Boolean);
  if (list.length === 0) return [];

  const buckets = new Map();
  list.forEach((entry, index) => {
    const key = surveyKeyFromFileName(entry.fileName) || 'upload';
    const bucket = buckets.get(key) || { id: key, label: key, year: yearFromLabel(key), indices: [] };
    bucket.indices.push(index);
    buckets.set(key, bucket);
  });

  // No shared structure in the filenames — treat the upload as one layer rather
  // than handing the user a list of 90 "surveys".
  if (buckets.size > MAX_AUTO_LAYERS || buckets.size === list.length) {
    return [{
      id: 'upload',
      label: 'Uploaded elevation',
      year: null,
      indices: list.map((_, index) => index),
    }];
  }

  const layers = [...buckets.values()];
  // Newest survey first: it is normally the densest and most current, and it is
  // the order a user would pick by hand anyway.
  layers.sort((a, b) => {
    if (a.year !== b.year) {
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return b.year - a.year;
    }
    return a.label.localeCompare(b.label);
  });
  return layers;
};

/**
 * Apply a user ordering (array of layer ids) to the detected layers. Ids that
 * no longer exist are dropped; layers the ordering does not mention keep their
 * detected position at the end, so a stale order never hides data.
 */
export const applyLayerOrder = (layers = [], order = null) => {
  if (!Array.isArray(order) || order.length === 0) return layers;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const ordered = [];
  for (const id of order) {
    const layer = byId.get(id);
    if (layer && !ordered.includes(layer)) ordered.push(layer);
  }
  for (const layer of layers) {
    if (!ordered.includes(layer)) ordered.push(layer);
  }
  return ordered;
};

/**
 * Stamp each raster entry with the index of the layer it belongs to, so the
 * resampler worker can rebuild the priority stack on the other side of the
 * postMessage boundary.
 */
export const assignLayerIndices = (entries = [], layers = []) => {
  const layerIndexByEntry = new Map();
  layers.forEach((layer, layerIndex) => {
    for (const entryIndex of layer.indices) layerIndexByEntry.set(entryIndex, layerIndex);
  });
  return entries.map((entry, index) => ({
    ...entry,
    layerIndex: layerIndexByEntry.get(index) ?? 0,
  }));
};
