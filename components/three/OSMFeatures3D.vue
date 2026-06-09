<script setup>
import { shallowRef, watch, toRaw, onUnmounted } from 'vue';
import { createOSMGroup } from '../../services/export3d';

const props = defineProps({
  terrainData: { required: true },
  featureVisibility: { 
    type: Object, 
    default: () => ({ buildings: true, vegetation: true, barriers: true }) 
  }
});

const group = shallowRef(null);

const disposeGroup = (grp) => {
  if (!grp) return;
  grp.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
  });
};

const buildPreviewOptions = (data) => {
  // PREVIEW-ONLY SAFETY PROFILE:
  // These limits intentionally reduce 3D preview memory usage for dense OSM areas.
  // Do not reuse this profile for export pipelines (GLB/DAE/BeamNG), which must
  // preserve full export quality.
  const osmCount = Array.isArray(data?.osmFeatures) ? data.osmFeatures.length : 0;
  const maxDim = Math.max(Number(data?.width || 0), Number(data?.height || 0));
  const dense = osmCount >= 9000 || (maxDim >= 8192 && osmCount >= 5000);
  const veryDense = osmCount >= 18000 || (maxDim >= 8192 && osmCount >= 10000);

  return {
    // Build every category once; the visibility checkboxes toggle mesh.visible
    // below instead of triggering a full extrude/merge rebuild per click.
    includeBuildings: true,
    includeVegetation: true,
    includeBarriers: true,
    includeStreetFurniture: !dense,
    maxBuildings: Number.POSITIVE_INFINITY,
    maxBarriers: veryDense ? 800 : dense ? 1800 : 5000,
    maxTrees: veryDense ? 600 : dense ? 1200 : 3000,
    maxBushes: veryDense ? 400 : dense ? 800 : 3000,
    maxStreetFurniture: veryDense ? 0 : dense ? 300 : 1500,
    simplifyBuildingFootprints: true,
    footprintSimplifyTolerance: veryDense ? 1.9 : dense ? 1.2 : 0.6,
    lightweightVegetationMode: true,
  };
};

// createOSMGroup names its merged meshes by category ('buildings',
// 'vegetation', 'barriers'); flipping `visible` is free, while a rebuild
// re-extrudes and re-merges every footprint (seconds of jank in dense areas).
const applyVisibility = () => {
  const grp = group.value;
  if (!grp) return;
  const vis = {
    buildings: props.featureVisibility?.buildings !== false,
    vegetation: props.featureVisibility?.vegetation !== false,
    barriers: props.featureVisibility?.barriers !== false,
  };
  grp.traverse((child) => {
    if (child.isMesh && child.name in vis) child.visible = vis[child.name];
  });
};

const rebuildGroup = (data) => {
  if (group.value) {
    disposeGroup(group.value);
    group.value = null;
  }

  if (data) {
    const rawData = toRaw(data);
    group.value = createOSMGroup(rawData, buildPreviewOptions(rawData));
    applyVisibility();
  }
};

watch(
  () => props.terrainData,
  (data) => rebuildGroup(data),
  { immediate: true }
);

watch(
  [
    () => props.featureVisibility?.buildings,
    () => props.featureVisibility?.vegetation,
    () => props.featureVisibility?.barriers,
  ],
  () => applyVisibility()
);

onUnmounted(() => {
  if (group.value) {
    disposeGroup(group.value);
    group.value = null;
  }
});
</script>

<template>
  <primitive v-if="group" :object="group" />
</template>
