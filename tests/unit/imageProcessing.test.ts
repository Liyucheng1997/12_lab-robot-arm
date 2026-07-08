import { describe, expect, it } from 'vitest';
import {
  classifyPixel,
  detectBlobs,
  rgbToHsv,
  usablePixelRatio,
} from '../../src/vision/imageProcessing';

const WIDTH = 48;
const HEIGHT = 36;

function makeBuffer(): Uint8Array {
  return new Uint8Array(WIDTH * HEIGHT * 4); // all zeros = black
}

function fillRect(
  buffer: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * WIDTH + x) * 4;
      buffer[index] = r;
      buffer[index + 1] = g;
      buffer[index + 2] = b;
      buffer[index + 3] = 255;
    }
  }
}

describe('rgbToHsv / classifyPixel', () => {
  it('classifies saturated red and blue, rejects gray', () => {
    expect(classifyPixel(255, 30, 30)).toBe('red');
    expect(classifyPixel(40, 80, 255)).toBe('blue');
    expect(classifyPixel(128, 128, 128)).toBe('background');
    const [h] = rgbToHsv(255, 0, 0);
    expect(h).toBeCloseTo(0, 5);
  });

  it('classifies the yellow nut fiducial and brass tones as yellow', () => {
    expect(classifyPixel(255, 214, 10)).toBe('yellow'); // marker 0xffd60a
    expect(classifyPixel(201, 162, 63)).toBe('yellow'); // brass body
    expect(classifyPixel(255, 120, 20)).toBe('background'); // orange stays out
  });
});

describe('detectBlobs', () => {
  it('scenario 1: a single saturated red blob is detected with high confidence', () => {
    const buffer = makeBuffer();
    fillRect(buffer, 10, 8, 20, 18, 255, 30, 30);

    const blobs = detectBlobs(buffer, WIDTH, HEIGHT);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].color).toBe('red');
    expect(blobs[0].confidence).toBeGreaterThan(0.6);
    expect(blobs[0].centroidX).toBeCloseTo(14.5, 0);
    expect(blobs[0].centroidY).toBeCloseTo(12.5, 0);
  });

  it('scenario 2: red + blue blobs are both detected and sorted by confidence', () => {
    const buffer = makeBuffer();
    fillRect(buffer, 4, 4, 12, 12, 255, 25, 25);
    fillRect(buffer, 30, 20, 40, 30, 40, 70, 255);

    const blobs = detectBlobs(buffer, WIDTH, HEIGHT);
    expect(blobs).toHaveLength(2);
    expect(new Set(blobs.map((blob) => blob.color))).toEqual(new Set(['red', 'blue']));
    for (let i = 1; i < blobs.length; i += 1) {
      expect(blobs[i - 1].confidence).toBeGreaterThanOrEqual(blobs[i].confidence);
    }
  });

  it('scenario 3: a desaturated blob is detected but with low confidence', () => {
    const buffer = makeBuffer();
    fillRect(buffer, 12, 10, 24, 22, 220, 105, 105);

    const blobs = detectBlobs(buffer, WIDTH, HEIGHT);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].color).toBe('red');
    expect(blobs[0].confidence).toBeLessThan(0.6);
  });

  it('scenario 4: two touching same-color balls are split along the component major axis', () => {
    const buffer = makeBuffer();
    // one contiguous red region representing two touching balls
    fillRect(buffer, 6, 10, 30, 22, 255, 30, 30);

    const blobs = detectBlobs(buffer, WIDTH, HEIGHT);
    expect(blobs).toHaveLength(2);
    expect(blobs.every((blob) => blob.color === 'red')).toBe(true);
    expect(blobs.reduce((sum, blob) => sum + blob.areaPx, 0)).toBe(24 * 12);
  });

  it('detects all three marker classes in one frame', () => {
    const buffer = makeBuffer();
    fillRect(buffer, 2, 2, 10, 10, 255, 30, 30);
    fillRect(buffer, 18, 2, 26, 10, 40, 70, 255);
    fillRect(buffer, 34, 2, 42, 10, 255, 214, 10);

    const blobs = detectBlobs(buffer, WIDTH, HEIGHT);
    expect(blobs).toHaveLength(3);
    expect(new Set(blobs.map((blob) => blob.color))).toEqual(new Set(['red', 'blue', 'yellow']));
    const yellow = blobs.find((blob) => blob.color === 'yellow');
    expect(yellow?.confidence ?? 0).toBeGreaterThan(0.6);
  });

  it('scenario 5: an all-black buffer yields no blobs and ~0 usable ratio', () => {
    const buffer = makeBuffer();
    expect(detectBlobs(buffer, WIDTH, HEIGHT)).toEqual([]);
    expect(usablePixelRatio(buffer, WIDTH, HEIGHT)).toBeLessThan(0.05);
  });

  it('a lit scene reports a high usable pixel ratio', () => {
    const buffer = makeBuffer();
    fillRect(buffer, 0, 0, WIDTH, HEIGHT, 90, 90, 90);
    expect(usablePixelRatio(buffer, WIDTH, HEIGHT)).toBeGreaterThan(0.9);
  });
});
