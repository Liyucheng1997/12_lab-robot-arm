/**
 * Pure (no three.js / DOM) image analysis for the online vision path.
 * Operates on an RGBA byte buffer and recovers red/blue ball blobs by HSV color
 * segmentation + connected-component labeling. See research.md R2/R3.
 */

export type PixelColor = 'red' | 'blue' | 'background';

export interface BlobDetection {
  color: 'red' | 'blue';
  /** Centroid in buffer coordinates: x from left, y by row index (as supplied). */
  centroidX: number;
  centroidY: number;
  areaPx: number;
  /** 0..1 mean hue/saturation purity of the component. */
  confidence: number;
}

export interface BlobOptions {
  /** Components smaller than this are discarded as noise. */
  minArea: number;
  /** Saturation floor for a pixel to count as colored. */
  minSaturation: number;
  /** Value (brightness) floor for a pixel to count as colored. */
  minValue: number;
}

export const DEFAULT_BLOB_OPTIONS: BlobOptions = {
  minArea: 8,
  minSaturation: 0.3,
  minValue: 0.2,
};

interface ComponentPixel {
  x: number;
  y: number;
  purity: number;
}

/** Convert 0..255 RGB to HSV with h in [0,360), s and v in [0,1]. */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rn) {
      h = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      h = 60 * ((bn - rn) / delta + 2);
    } else {
      h = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (h < 0) {
    h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return [h, s, max];
}

export function classifyPixel(
  r: number,
  g: number,
  b: number,
  options: BlobOptions = DEFAULT_BLOB_OPTIONS,
): PixelColor {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (s < options.minSaturation || v < options.minValue) {
    return 'background';
  }
  if (h <= 25 || h >= 335) {
    return 'red';
  }
  if (h >= 200 && h <= 260) {
    return 'blue';
  }
  return 'background';
}

/** Per-pixel hue/saturation purity in [0,1] for the given color class. */
function pixelPurity(h: number, s: number, v: number, color: 'red' | 'blue'): number {
  const hueDist =
    color === 'red' ? Math.min(Math.abs(h - 0), Math.abs(h - 360)) : Math.abs(h - 220);
  const hueScore = clamp01(1 - hueDist / 60);
  return clamp01(s) * hueScore * clamp01(v * 1.5);
}

/** Fraction of pixels bright enough to be part of the scene (low → view obstructed/black). */
export function usablePixelRatio(pixels: Uint8Array, width: number, height: number): number {
  const total = width * height;
  if (total === 0) {
    return 0;
  }
  let lit = 0;
  for (let i = 0; i < total; i += 1) {
    const v = Math.max(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]) / 255;
    if (v > 0.05) {
      lit += 1;
    }
  }
  return lit / total;
}

/** Detect red/blue blobs via 4-connectivity connected components. */
export function detectBlobs(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: BlobOptions = DEFAULT_BLOB_OPTIONS,
): BlobDetection[] {
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);
  const blobs: BlobDetection[] = [];
  const stack: number[] = [];

  for (let start = 0; start < total; start += 1) {
    if (labels[start] !== -1) {
      continue;
    }
    const startColor = colorAt(pixels, start, options);
    if (startColor === 'background') {
      labels[start] = -2;
      continue;
    }

    let area = 0;
    const componentPixels: ComponentPixel[] = [];
    stack.length = 0;
    stack.push(start);
    labels[start] = blobs.length;

    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      const [h, s, v] = rgbToHsv(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]);
      componentPixels.push({ x, y, purity: pixelPurity(h, s, v, startColor) });

      pushNeighbor(stack, labels, pixels, options, startColor, x - 1, y, width, height, blobs.length);
      pushNeighbor(stack, labels, pixels, options, startColor, x + 1, y, width, height, blobs.length);
      pushNeighbor(stack, labels, pixels, options, startColor, x, y - 1, width, height, blobs.length);
      pushNeighbor(stack, labels, pixels, options, startColor, x, y + 1, width, height, blobs.length);
    }

    if (area < options.minArea) {
      continue;
    }
    blobs.push(...splitElongatedComponent(componentPixels, startColor, options.minArea));
  }

  return blobs.sort((left, right) => right.confidence - left.confidence);
}

/**
 * Touching balls of the same color form one component. Their union is elongated,
 * so split it along its PCA major axis into approximately circular sub-components.
 */
function splitElongatedComponent(
  pixels: ComponentPixel[],
  color: 'red' | 'blue',
  minArea: number,
): BlobDetection[] {
  const meanX = pixels.reduce((sum, pixel) => sum + pixel.x, 0) / pixels.length;
  const meanY = pixels.reduce((sum, pixel) => sum + pixel.y, 0) / pixels.length;
  let covarianceXX = 0;
  let covarianceYY = 0;
  let covarianceXY = 0;

  pixels.forEach((pixel) => {
    const dx = pixel.x - meanX;
    const dy = pixel.y - meanY;
    covarianceXX += dx * dx;
    covarianceYY += dy * dy;
    covarianceXY += dx * dy;
  });

  const angle = 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY);
  const majorX = Math.cos(angle);
  const majorY = Math.sin(angle);
  const minorX = -majorY;
  const minorY = majorX;
  let minMajor = Number.POSITIVE_INFINITY;
  let maxMajor = Number.NEGATIVE_INFINITY;
  let minMinor = Number.POSITIVE_INFINITY;
  let maxMinor = Number.NEGATIVE_INFINITY;

  const projected = pixels.map((pixel) => {
    const dx = pixel.x - meanX;
    const dy = pixel.y - meanY;
    const major = dx * majorX + dy * majorY;
    const minor = dx * minorX + dy * minorY;
    minMajor = Math.min(minMajor, major);
    maxMajor = Math.max(maxMajor, major);
    minMinor = Math.min(minMinor, minor);
    maxMinor = Math.max(maxMinor, minor);
    return { ...pixel, major };
  });

  const majorExtent = maxMajor - minMajor + 1;
  const minorExtent = maxMinor - minMinor + 1;
  const splitCount = Math.min(
    10,
    Math.max(1, Math.round(majorExtent / Math.max(minorExtent, 1))),
  );
  if (splitCount === 1 || pixels.length < splitCount * minArea) {
    return [createBlob(pixels, color)];
  }

  const buckets = Array.from({ length: splitCount }, () => [] as ComponentPixel[]);
  projected.forEach((pixel) => {
    const normalized = (pixel.major - minMajor) / Math.max(maxMajor - minMajor, 1);
    const bucketIndex = Math.min(splitCount - 1, Math.floor(normalized * splitCount));
    buckets[bucketIndex].push(pixel);
  });
  if (buckets.some((bucket) => bucket.length < minArea)) {
    return [createBlob(pixels, color)];
  }
  return buckets.map((bucket) => createBlob(bucket, color));
}

function createBlob(pixels: ComponentPixel[], color: 'red' | 'blue'): BlobDetection {
  const areaPx = pixels.length;
  return {
    color,
    centroidX: pixels.reduce((sum, pixel) => sum + pixel.x, 0) / areaPx,
    centroidY: pixels.reduce((sum, pixel) => sum + pixel.y, 0) / areaPx,
    areaPx,
    confidence: clamp01(pixels.reduce((sum, pixel) => sum + pixel.purity, 0) / areaPx),
  };
}

function pushNeighbor(
  stack: number[],
  labels: Int32Array,
  pixels: Uint8Array,
  options: BlobOptions,
  color: 'red' | 'blue',
  x: number,
  y: number,
  width: number,
  height: number,
  label: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const index = y * width + x;
  if (labels[index] !== -1) {
    return;
  }
  if (colorAt(pixels, index, options) !== color) {
    labels[index] = -2;
    return;
  }
  labels[index] = label;
  stack.push(index);
}

function colorAt(pixels: Uint8Array, index: number, options: BlobOptions): PixelColor {
  return classifyPixel(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2], options);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
