import { createMetricProjector } from './geoUtils.js';

/**
 * Computes distance and projection parameter t of point (x,y) onto line segment (x1,y1)-(x2,y2)
 */
function pointLineProjection(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) {
        const dx0 = x - x1;
        const dy0 = y - y1;
        return { t: 0, dist: Math.sqrt(dx0 * dx0 + dy0 * dy0) };
    }

    let t = ((x - x1) * dx + (y - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx;
    const py = y1 + t * dy;
    const dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    
    return { t, dist };
}

/**
 * Resample a polyline so that segments are no longer than maxSegmentLength (in pixels).
 */
function resamplePolyline(points, maxSegmentLength) {
    if (points.length < 2) return points;
    const resampled = [points[0]];
    
    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > maxSegmentLength) {
            const numSegments = Math.ceil(dist / maxSegmentLength);
            for (let j = 1; j < numSegments; j++) {
                const t = j / numSegments;
                resampled.push({
                    x: p1.x + t * dx,
                    y: p1.y + t * dy
                });
            }
        }
        resampled.push(p2);
    }
    return resampled;
}

/**
 * Samples heightmap at a specific pixel coordinate (bilinear interpolation).
 */
function sampleHeight(heightMap, width, height, px, py) {
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    
    const h00 = heightMap[y0 * width + x0];
    const h10 = heightMap[y0 * width + x1];
    const h01 = heightMap[y1 * width + x0];
    const h11 = heightMap[y1 * width + x1];
    
    // Simple fallback if NO_DATA_VALUE
    if (h00 === -99999 || h10 === -99999 || h01 === -99999 || h11 === -99999) {
        return h00;
    }
    
    const dx = px - x0;
    const dy = py - y0;
    
    const top = h00 * (1 - dx) + h10 * dx;
    const bottom = h01 * (1 - dx) + h11 * dx;
    return top * (1 - dy) + bottom * dy;
}

/**
 * Smooths an array of Z values using a moving average window.
 */
function smooth1DArray(arr, windowSize) {
    const result = new Float32Array(arr.length);
    const half = Math.floor(windowSize / 2);
    for (let i = 0; i < arr.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = -half; j <= half; j++) {
            const idx = i + j;
            if (idx >= 0 && idx < arr.length && arr[idx] !== -99999) {
                sum += arr[idx];
                count++;
            }
        }
        result[i] = count > 0 ? sum / count : arr[i];
    }
    return result;
}

/**
 * Modifies the heightMap in-place by creating flat road terraces that follow the natural slope.
 */
export function smoothRoadsInHeightmap(heightMap, width, height, bounds, osmFeatures, metersPerPixel, enhanceRoads, levelRoads) {
    if (!osmFeatures || osmFeatures.length === 0) return;

    const project = createMetricProjector(bounds, width, height);
    
    // Buffers to keep track of the strongest requested blend weight and target height per-pixel.
    const roadZ = new Float32Array(width * height);
    const roadW = new Float32Array(width * height);
    let hasRoads = false;

    // Resample segments to max 5 meters to accurately trace terrain bumps
    const maxSegmentLengthPx = Math.max(1, 5 / metersPerPixel);
    // Smooth over a ~30 meter window
    const smoothingWindowSize = Math.max(3, Math.floor(30 / metersPerPixel / maxSegmentLengthPx));

    for (const feature of osmFeatures) {
        if (feature.type !== 'road') continue;
        
        const tags = feature.tags || {};
        const layer = Number.parseInt(tags.layer, 10) || 0;
        
        // Skip bridges, overpasses, tunnels, and elevated roads
        if (layer > 0 || tags.bridge === 'yes' || tags.tunnel === 'yes' || tags.covered === 'yes' || tags.location === 'elevated') {
            continue;
        }

        const geom = feature.geometry;
        if (!geom || geom.length < 2) continue;

        // 1. Project centerline to pixels
        const rawPoints = geom.map(pt => project(pt.lat, pt.lng));
        
        // 2. Resample polyline to ensure high sampling density
        const points = resamplePolyline(rawPoints, maxSegmentLengthPx);
        
        // 3. Extract and smooth Z profile
        const zProfile = new Float32Array(points.length);
        for (let i = 0; i < points.length; i++) {
            zProfile[i] = sampleHeight(heightMap, width, height, points[i].x, points[i].y);
        }
        const smoothedZ = smooth1DArray(zProfile, smoothingWindowSize);

        // Determine road width in pixels (add an embankment feathering margin)
        const roadWidthMeters = tags.width ? parseFloat(tags.width) : 6.0;
        const radiusMeters = roadWidthMeters / 2;
        // The core is flat. We add an extra margin for feathering back to the terrain.
        const featherMeters = 6.0;
        const radiusPx = Math.max(1, (radiusMeters + featherMeters) / metersPerPixel);
        const coreRadiusPx = Math.max(1, radiusMeters / metersPerPixel);

        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i+1];
            const z1 = smoothedZ[i];
            const z2 = smoothedZ[i+1];
            
            if (z1 === -99999 || z2 === -99999) continue;
            hasRoads = true;

            const minX = Math.max(0, Math.floor(Math.min(p1.x, p2.x) - radiusPx));
            const maxX = Math.min(width - 1, Math.ceil(Math.max(p1.x, p2.x) + radiusPx));
            const minY = Math.max(0, Math.floor(Math.min(p1.y, p2.y) - radiusPx));
            const maxY = Math.min(height - 1, Math.ceil(Math.max(p1.y, p2.y) + radiusPx));

            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const { t, dist } = pointLineProjection(x, y, p1.x, p1.y, p2.x, p2.y);
                    
                    if (dist <= radiusPx) {
                        let w = 1.0;
                        if (dist > coreRadiusPx) {
                            // Feather from 1.0 to 0.0 using cosine for a smooth curve
                            const f = (dist - coreRadiusPx) / (radiusPx - coreRadiusPx);
                            w = 0.5 * (1 + Math.cos(Math.PI * f));
                        }

                        const idx = y * width + x;
                        // Prioritize the road segment with the strongest influence
                        if (w > roadW[idx]) {
                            roadW[idx] = w;
                            
                            // The flat target elevation is determined by the smoothed centerline
                            let z_target = z1 + t * (z2 - z1);
                            
                            if (!levelRoads) {
                                // If not leveling, we only apply the longitudinal smoothing delta.
                                // delta = smoothed_centerline - original_centerline
                                const origZ = zProfile[i] + t * (zProfile[i+1] - zProfile[i]);
                                const delta = z_target - origZ;
                                
                                // Apply this vertical shift to the pixel's original height
                                const pxOrigZ = heightMap[idx];
                                if (pxOrigZ !== -99999) {
                                    z_target = pxOrigZ + delta;
                                }
                            }
                            
                            roadZ[idx] = z_target;
                        }
                    }
                }
            }
        }
    }

    if (!hasRoads) return;

    // 4. Blend the leveled roads back into the heightmap
    for (let i = 0; i < heightMap.length; i++) {
        const w = roadW[i];
        if (w > 0 && heightMap[i] !== -99999) {
            heightMap[i] = heightMap[i] * (1 - w) + roadZ[i] * w;
        }
    }
}
