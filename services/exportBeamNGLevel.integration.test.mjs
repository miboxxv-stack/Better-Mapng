import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import { exportBeamNGLevel } from './exportBeamNGLevel.js';

function installCanvasPolyfill() {
  const originalDocument = globalThis.document;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalFetch = globalThis.fetch;
  const emptyZipEOCD = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);

  class FakeCanvas {
    constructor() {
      this.width = 0;
      this.height = 0;
      this._ctx = null;
    }

    getContext() {
      if (this._ctx) return this._ctx;
      this._ctx = {
        fillStyle: '#000000',
        drawImage() {},
        fillRect() {},
        putImageData() {},
        createImageData(w, h) {
          return {
            width: w,
            height: h,
            data: new Uint8ClampedArray(w * h * 4),
          };
        },
      };
      return this._ctx;
    }

    toBlob(callback, type = 'image/png') {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      bytes.__type = type;
      bytes.__width = this.width;
      bytes.__height = this.height;
      callback(bytes);
    }
  }

  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') {
        throw new Error(`Unsupported element in test polyfill: ${tag}`);
      }
      return new FakeCanvas();
    },
  };

  globalThis.createImageBitmap = async (blob) => ({
    width: Number(blob?.__width) || 64,
    height: Number(blob?.__height) || 64,
    close() {},
  });

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url === '/mapng_flag_static.zip') {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => emptyZipEOCD.buffer.slice(0),
      };
    }
    if (typeof originalFetch === 'function') {
      return originalFetch(input, init);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };

  return () => {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
    if (originalCreateImageBitmap === undefined) {
      delete globalThis.createImageBitmap;
    } else {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }
  };
}

function makeTerrainData() {
  const width = 8;
  const height = 8;

  return {
    width,
    height,
    minHeight: 0,
    maxHeight: 50,
    heightMap: new Float32Array(width * height).fill(10),
    bounds: {
      north: 1,
      south: 0,
      west: 0,
      east: 1,
    },
    osmFeatures: [
      {
        id: 'road_1',
        type: 'road',
        tags: {
          highway: 'primary',
        },
        geometry: [
          { lat: 0.8, lng: 0.2 },
          { lat: 0.2, lng: 0.8 },
        ],
      },
      {
        id: 'barrier_1',
        type: 'barrier',
        tags: {
          barrier: 'guard_rail',
        },
        geometry: [
          { lat: 0.75, lng: 0.25 },
          { lat: 0.35, lng: 0.65 },
        ],
      },
      {
        id: 'tree_1',
        type: 'vegetation',
        tags: {
          natural: 'tree',
        },
        geometry: [
          { lat: 0.6, lng: 0.4 },
        ],
      },
    ],
  };
}

function parseNDJSON(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runExportForRoadType(roadType, { includeTrees = false } = {}) {
  const result = await exportBeamNGLevel(
    makeTerrainData(),
    { lat: 0.5, lng: 0.5 },
    {
      roadType,
      levelName: 'mapng_demo',
      biomeId: 'west_coast_usa',
      baseTexture: 'none',
      pbrSource: 'none',
      includeBuildings: false,
      applyFoundations: false,
      includeBackdrop: false,
      includeWater: false,
      includeTrees,
      includeRocks: false,
      includeNativeBarriers: true,
    },
  );

  const zipBuffer = await result.blob.arrayBuffer();
  return JSZip.loadAsync(zipBuffer);
}

test('exportBeamNGLevel rewrites barrier shape paths and emits .link files across road modes', async () => {
  const restorePolyfills = installCanvasPolyfill();

  try {
    for (const roadType of ['decal', 'architect', 'mesh']) {
      const zip = await runExportForRoadType(roadType);
      const base = 'levels/mapng_demo';
      const barriersPath = `${base}/main/MissionGroup/barriers/items.level.json`;

      const barriersFile = zip.file(barriersPath);
      assert.ok(barriersFile, `Missing ${barriersPath} for roadType=${roadType}`);

      const barrierObjects = parseNDJSON(await barriersFile.async('string'));
      const barrierWithShape = barrierObjects.find((obj) => typeof obj?.shapeName === 'string');
      assert.ok(barrierWithShape, `Expected barrier shapeName for roadType=${roadType}`);
      assert.match(
        barrierWithShape.shapeName,
        /^\/levels\/mapng_demo\/map_assets\/official_assets\//,
      );

      const linkFiles = Object.keys(zip.files).filter((path) => (
        path.startsWith(`${base}/map_assets/official_assets/`) && path.endsWith('.link')
      ));

      assert.ok(linkFiles.length > 0, `Expected .link files for roadType=${roadType}`);
    }
  } finally {
    restorePolyfills();
  }
});

test('exportBeamNGLevel rewrites managed forest shape paths across road modes', async () => {
  const restorePolyfills = installCanvasPolyfill();

  try {
    for (const roadType of ['decal', 'architect', 'mesh']) {
      const zip = await runExportForRoadType(roadType, { includeTrees: true });
      const vegetationPath = 'levels/mapng_demo/main/MissionGroup/vegetation/items.level.json';
      const vegetationFile = zip.file(vegetationPath);
      assert.ok(vegetationFile, `Missing ${vegetationPath} for roadType=${roadType}`);

      const vegetationItems = parseNDJSON(await vegetationFile.async('string'));
      const forestObject = vegetationItems.find((item) => item?.class === 'Forest');
      assert.ok(forestObject, `Expected Forest object in vegetation items for roadType=${roadType}`);
      assert.equal(forestObject.name, 'theForest');

      const managedPath = 'levels/mapng_demo/art/forest/managedItemData.json';
      const managedFile = zip.file(managedPath);
      assert.ok(managedFile, `Missing ${managedPath} for roadType=${roadType}`);

      const forestDataFiles = Object.keys(zip.files).filter((path) => (
        path.startsWith('levels/mapng_demo/forest/') && path.endsWith('.forest4.json')
      ));
      assert.ok(forestDataFiles.length > 0, `Expected forest placement files for roadType=${roadType}`);

      const managedItemData = JSON.parse(await managedFile.async('string'));
      const managedEntries = Object.values(managedItemData || {});
      const shapeEntry = managedEntries.find((entry) => typeof entry?.shapeFile === 'string');
      assert.ok(shapeEntry, `Expected shapeFile in managedItemData for roadType=${roadType}`);
      assert.match(
        shapeEntry.shapeFile,
        /^\/?levels\/mapng_demo\/map_assets\/official_assets\//,
      );

      const rewrittenShapePath = String(shapeEntry.shapeFile).replace(/^\//, '');
      const forestLinkPath = `${rewrittenShapePath}.link`;
      assert.ok(zip.file(forestLinkPath), `Missing forest link file ${forestLinkPath}`);
    }
  } finally {
    restorePolyfills();
  }
});