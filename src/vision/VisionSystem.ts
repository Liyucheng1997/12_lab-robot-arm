import type { Vector2, Vector3 } from 'three';

/**
 * Fiducial marker colors recognized by the online vision path. Each incoming part
 * carries one saturated marker on its grip boss: red = brake disc, blue = wheel,
 * yellow = hub nut.
 */
export type DetectionColor = 'red' | 'blue' | 'yellow';

/** One captured observation of the work area from the fixed station camera. */
export interface VisionFrame {
  width: number;
  height: number;
  /** RGBA buffer, length = width * height * 4. */
  pixels: Uint8Array;
  /** Fraction of non-background pixels in [0, 1]; drives the blind-halt check. */
  usablePixelRatio: number;
  /** False when the view is obstructed/unreadable; the controller must not move the arm. */
  isObservable: boolean;
}

/** A single recognized part marker. Every field is derived from pixels only. */
export interface VisionDetection {
  color: DetectionColor;
  /** Blob centroid in image space. */
  pixel: Vector2;
  estimatedWorldPosition: Vector3;
  /** 0..1 — hue purity / blob quality; low values are treated as ambiguous. */
  confidence: number;
  /** Connected-component pixel count. */
  areaPx: number;
}

/** Image-based recognition seam consumed by the assembly controller. */
export interface VisionSystem {
  /** Capture one observation of the work area. */
  observe(): VisionFrame;
  /** Recognize part markers inside the conveyor pick window, sorted by confidence. */
  detectPickable(frame: VisionFrame): VisionDetection[];
  /** Recognize part markers across the whole monitored cell (operator preview). */
  detectAll(frame: VisionFrame): VisionDetection[];
}
