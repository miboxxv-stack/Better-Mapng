/**
 * Export a BeamNG terrain .ter binary (version 9).
 *
 * @param {object} terrainData
 * @param {object} [options]
 * @param {Uint8Array} [options.layerMap]       — material index per pixel (size×size),
 *                                                terrain space: 0,0=SW, y increases N.
 *                                                Defaults to all-zero (single material).
 * @param {string[]}  [options.materialNames]   — ordered material name list.
 *                                                Index 0 = fallback (must match .terrain.json).
 *                                                Defaults to ['DefaultMaterial'].
 */
export async function exportTer(terrainData, {
  layerMap: customLayerMap = null,
  materialNames: customMaterialNames = null,
} = {}) {
  const width = Number(terrainData?.width);
  const height = Number(terrainData?.height);
  const heightMap = terrainData?.heightMap;
  const minHeight = Number(terrainData?.minHeight);
  const maxHeight = Number(terrainData?.maxHeight);

  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw new Error(`Invalid terrain dimensions: ${width}x${height}`);
  }
  if (!(heightMap instanceof Float32Array) || heightMap.length < width * height) {
    throw new Error('Heightmap is missing or undersized');
  }

  // BeamNG terrains must be square power-of-two — clip down to fit.
  const squareSize = Math.min(width, height);
  const size = squareSize >= 2 ? 2 ** Math.floor(Math.log2(squareSize)) : squareSize;

  if (size !== width || size !== height) {
    console.warn('[exportTer] Terrain size normalized for BeamNG compatibility', {
      sourceWidth: width,
      sourceHeight: height,
      exportedSize: size,
    });
  }

  // Terrain-Files.md: the layer map is u8 with 255 reserved for holes, so the
  // loader supports at most 254 terrain materials — extras are ignored.
  let materialNames = customMaterialNames ?? ['DefaultMaterial'];
  if (materialNames.length > 254) {
    console.warn('[exportTer] Truncating terrain material list to the BeamNG 254-entry limit', {
      requested: materialNames.length,
    });
    materialNames = materialNames.slice(0, 254);
  }

  const encoder = new TextEncoder();

  // Pre-encode all material name strings and compute header sizes.
  const encodedNames = materialNames.map(n => encoder.encode(n));
  let materialNamesBytes = 0;
  for (const bytes of encodedNames) {
    materialNamesBytes += bytes.length < 255 ? 1 + bytes.length : 3 + bytes.length;
  }

  const headerSize        = 5;                    // version(1) + size(4)
  const heightmapSize     = size * size * 2;      // uint16 per pixel
  const layerMapSize      = size * size;           // uint8 per pixel
  const materialListHeader = 4;                   // uint32 material count

  const totalSize = headerSize + heightmapSize + layerMapSize + materialListHeader + materialNamesBytes;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  let offset = 0;

  // ── Header ─────────────────────────────────────────────────────────────
  view.setUint8(offset, 0x09);   // version 9
  offset += 1;
  view.setUint32(offset, size, true);
  offset += 4;

  // ── Heightmap ──────────────────────────────────────────────────────────
  // Row-major, first row = bottom of terrain (south edge) — Y is flipped
  // relative to the heightMap array (which has row 0 at the top/north).
  //
  // Quantization must mirror BeamNG's decode (Terrain-Files.md §Height scale):
  //   heightMeters = storedHeight × (TerrainBlock.maxHeight / 65536)
  // exportBeamNGLevel writes TerrainBlock.maxHeight = max(1, ceil(range)), so
  // we scale against that same value here. Scaling against the raw float range
  // (the old behavior) made the terrain decode up to ~1 m taller than every
  // object placed at real heights whenever the range wasn't an integer.
  const range = maxHeight - minHeight;
  const blockMaxHeight = Math.max(1, Math.ceil(range));
  const heightScale = 65536 / blockMaxHeight;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const srcIdx = y * width + x;
      const h = heightMap[srcIdx];
      let val = Math.floor((h - minHeight) * heightScale);
      if (!Number.isFinite(val)) val = 0;
      val = Math.max(0, Math.min(65535, val));
      view.setUint16(offset, val, true);
      offset += 2;
    }
  }

  // ── Layer map ──────────────────────────────────────────────────────────
  // Layer map from osmTerrainMaterials is already in terrain space (0,0=SW,
  // y increases northward), which matches the .ter bottom-left origin.
  // The heightmap Y-flip above does NOT apply here — the layer map bytes
  // are written south-to-north (row 0 of the .ter = south edge of terrain),
  // matching how the layer map Uint8Array was built.
  const layerMapView = new Uint8Array(buffer, offset, layerMapSize);
  if (customLayerMap && customLayerMap.length >= layerMapSize) {
    layerMapView.set(customLayerMap.subarray(0, layerMapSize));
  }
  // else: all zeros (DefaultMaterial everywhere)
  offset += layerMapSize;

  // ── Material name list ─────────────────────────────────────────────────
  view.setUint32(offset, materialNames.length, true);
  offset += 4;

  for (const bytes of encodedNames) {
    if (bytes.length < 255) {
      view.setUint8(offset, bytes.length);
      offset += 1;
    } else {
      view.setUint8(offset, 0xFF);
      offset += 1;
      view.setUint16(offset, bytes.length, true);
      offset += 2;
    }
    new Uint8Array(buffer, offset, bytes.length).set(bytes);
    offset += bytes.length;
  }

  return {
    blob: new Blob([buffer], { type: 'application/octet-stream' }),
    filename: 'theTerrain.ter',
  };
}
