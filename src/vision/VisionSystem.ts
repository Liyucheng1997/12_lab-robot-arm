import type { Vector2, Vector3 } from 'three';
import type { BallColor } from '../sorting/SortingStation';

/** Operator-selectable recognition mode. Online (image-based) is the default. */
export type VisionMode = 'online' | 'offline';

/** One captured observation of the work area from the overhead camera. */
export interface VisionFrame {
  width: number;
  height: number;
  /** RGBA buffer, length = width * height * 4. Empty for synthesized offline frames. */
  pixels: Uint8Array;
  /** Fraction of non-background pixels in [0, 1]; drives the blind-halt check (FR-008). */
  usablePixelRatio: number;
  /** False when the view is obstructed/unreadable; the controller must not move the arm. */
  isObservable: boolean;
}

/** A single recognized ball. In the online path every field comes from pixels only. */
export interface VisionDetection {
  /** Online: null (not derived from ground truth); resolved to a ball at execution time. */
  ballId: string | null;
  color: BallColor;
  /** Blob centroid in image space. */
  pixel: Vector2;
  estimatedWorldPosition: Vector3;
  /** 0..1 — hue purity / blob quality; low values are treated as ambiguous. */
  confidence: number;
  /** Connected-component pixel count; large values flag touching/overlapping balls. */
  areaPx: number;
}

/** Shared seam implemented by both the online and offline recognition paths. */
export interface VisionSystem {
  readonly mode: VisionMode;
  /** Capture one observation of the work area. */
  observe(): VisionFrame;
  /** Recognize balls from a captured frame, sorted by confidence descending. */
  detectBalls(frame: VisionFrame): VisionDetection[];
}
