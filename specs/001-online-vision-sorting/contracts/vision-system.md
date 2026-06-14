# Contract: VisionSystem

The internal interface that both recognition paths implement. This is the seam that makes
online (default) and offline (debug) **coexist** behind a runtime mode switch (FR-011/FR-012).
It is a code-level contract (TypeScript), not a network API.

## Interface

```ts
export type VisionMode = 'online' | 'offline';

export interface VisionFrame {
  width: number;
  height: number;
  pixels: Uint8Array;        // RGBA, length = width*height*4
  usablePixelRatio: number;  // 0..1
  isObservable: boolean;     // false ⇒ obstructed/unreadable view
}

export interface VisionDetection {
  ballId: string | null;     // online: null (not from ground truth); resolved at execution
  color: BallColor;          // 'red' | 'blue'
  pixel: Vector2;            // blob centroid, image space
  estimatedWorldPosition: Vector3;
  confidence: number;        // 0..1
  areaPx: number;            // component pixel count
}

export interface VisionSystem {
  readonly mode: VisionMode;
  /** Capture one observation of the work area. Online: render + readback pixels.
   *  Offline: synthesize a frame; isObservable always true. */
  observe(): VisionFrame;
  /** Recognize balls from a captured frame. Sorted by confidence desc. */
  detectBalls(frame: VisionFrame): VisionDetection[];
}
```

## Behavioral guarantees

| ID | Guarantee |
|----|-----------|
| VS-1 | `OnlineVisionSystem.detectBalls` derives `color`, `pixel`, `estimatedWorldPosition`, `confidence` **only** from `frame.pixels`. It MUST NOT read `SortableBall.body`/`mesh` world positions or `.color`. (FR-001, SC-004) |
| VS-2 | Results are sorted by `confidence` descending. |
| VS-3 | A ball whose hue falls outside both red and blue clear bands yields a detection with `confidence` below the ambiguous threshold (so the controller can skip it) or no detection at all — never a confident wrong color. (FR-006, SC-002) |
| VS-4 | A ball outside the camera frustum produces no detection. (US2 scenario 2) |
| VS-5 | When the view is obstructed/unreadable, `observe()` returns `isObservable=false` and `detectBalls` returns `[]`. (FR-008) |
| VS-6 | `OfflineVisionSystem` keeps its current ground-truth projection behavior and sets `isObservable=true`; it exists for debugging and accuracy comparison only. |
| VS-7 | Switching `VisionMode` swaps the active implementation with no code change and no app reload. (FR-012) |

## Test scenarios (Vitest, on `imageProcessing` + a stub frame)

1. Buffer with one saturated-red blob → exactly one `red` detection at the blob centroid,
   confidence high.
2. Buffer with red + blue blobs → two detections, correct colors, sorted by confidence.
3. Buffer with a desaturated/ambiguous blob → confidence below ambiguous threshold.
4. Buffer of two merged same-color blobs (area > cluster threshold) → flagged via `areaPx`.
5. Empty/black buffer → `[]`; an all-background frame → `isObservable=false` path.
