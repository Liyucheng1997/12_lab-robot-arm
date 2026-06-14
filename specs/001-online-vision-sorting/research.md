# Phase 0 Research: Online Vision-Guided Ball Sorting

All open questions from the Technical Context are resolved below. Each item follows
Decision / Rationale / Alternatives.

## R1 — How to make recognition genuinely "online" (image-based)

**Decision**: Render the scene from the existing overhead `PerspectiveCamera` into an
offscreen target, read the RGBA pixel buffer back to the CPU, then run color segmentation +
connected-component blob detection on those pixels. Recover each blob's ground position by
casting a ray through the blob centroid pixel and intersecting the ball-center plane
(`y = BALL_RADIUS`), exactly as `OfflineVisionSystem.estimateWorldFromPixel` already does for
back-projection — but the input pixel comes from the *image*, not from a projected
ground-truth point.

**Rationale**: The simulator already renders the overhead view every frame
(`visionPreviewRenderer.render(scene, vision.camera)` in `main.ts`). Reading that buffer
(via `WebGLRenderer.readRenderTargetPixels` on a `WebGLRenderTarget`, or `gl.readPixels` /
`canvas.getContext` on the existing preview canvas) gives us true pixels with zero new
dependencies. Color + centroid from pixels is the standard "online" pipeline and satisfies
FR-001/SC-004 because no ball world coordinate is consulted.

**Alternatives considered**:
- *Keep projecting ground-truth and just relabel it "online"* — rejected; violates the
  feature's defining property and SC-004's independent test.
- *Import OpenCV.js / a CV library* — rejected; heavyweight (multi-MB WASM) for what is a
  two-color threshold + flood-fill on a 320×240 buffer we can write in ~100 lines.

## R2 — Color classification + blob detection algorithm

**Decision**: Classify each pixel in HSV: red = high saturation + value with hue near 0°/360°;
blue = high saturation + value with hue near 220°. Pixels failing both thresholds are
background/ambiguous. Group same-color pixels with a single-pass connected-component
(flood-fill / union-find) labeler; keep components above a minimum area; a component's color
is its pixel-majority color and its location is the area-weighted centroid. Per-blob
**confidence** = fraction of in-component pixels whose hue sits in the "clear" core band
(used for the ambiguous-skip rule, FR-006).

**Rationale**: HSV thresholds are robust to the simulator's lighting/shading far better than
raw RGB; connected components naturally separate balls and give centroids for back-projection
(FR-002). Confidence-from-hue-purity gives a principled handle for the "ambiguous color →
skip" edge case without a learned model.

**Alternatives considered**:
- *RGB distance thresholds* — rejected; shadows on the spheres shift RGB enough to misclassify;
  HSV decouples hue from brightness.
- *Hough circles* — rejected; unnecessary when color blobs already isolate the balls, and more
  expensive per frame.

## R3 — Touching/overlapping balls (edge case)

**Decision**: If a single connected component's area or bounding-box aspect implies more than
one ball (area ≳ 1.6× the expected single-ball pixel area), mark it low-confidence and skip
it this cycle rather than risk grabbing two. As the run clears neighbors, the cluster
separates on a later cycle and is picked normally.

**Rationale**: Matches the spec edge case ("avoid treating them as one or grabbing both") and
the FR-013 "skip-and-report, keep going" policy without needing watershed segmentation in v1.

**Alternatives considered**: Watershed/distance-transform splitting — deferred as
over-engineering for a 2-color demo.

## R4 — Online vs offline coexistence & mode switch (FR-011/FR-012)

**Decision**: Introduce a `VisionSystem` interface (`detectBalls(frame) → VisionDetection[]`,
plus `observe()` to capture the current image) implemented by both `OnlineVisionSystem`
(default) and the refactored `OfflineVisionSystem`. A `VisionMode = 'online' | 'offline'`
enum drives a lil-gui dropdown; `main.ts` holds the active implementation and swaps it on
change. Offline stays available purely for debugging / accuracy comparison and is never the
startup default.

**Rationale**: An interface + dropdown is the minimal operator-selectable switch with no code
changes at runtime (FR-012), and lets us compare online detections against the offline
ground-truth path for validation.

**Alternatives considered**: Deleting the offline path — rejected; the clarification session
explicitly chose **coexist**, and offline is the ground-truth oracle for measuring online
accuracy (SC-001).

## R5 — Autonomous loop control (FR-004/FR-005, US3)

**Decision**: An `AutoSortController` state machine with states
`idle → observing → planning → picking → placing → (loop) … → reporting → done`, advanced
from the existing `animate()` frame loop and the trajectory player's completion callback.
Each cycle: observe a frame; pick the highest-confidence detection that is classifiable and
reachable; plan via the existing `planSortTrajectoryForTarget`; on plan failure mark
unreachable + skip; execute; on trajectory completion, re-observe. The loop ends when an
observation yields no classifiable+reachable balls remaining, then emits the report.

**Rationale**: Reuses the existing event-driven trajectory completion plumbing
(`handleTrajectoryComplete`) instead of adding timers; keeps the UI responsive; makes the
"continue until clear, then stop" behavior (FR-005) a natural terminal transition.

**Alternatives considered**: `async/await` sequencing with `await sleep` — rejected; fights
the requestAnimationFrame render loop and complicates Stop/abort.

## R6 — Refuse to move when work area not observable (FR-008, SC-005)

**Decision**: After capturing a frame, compute a "view usability" check — fraction of
non-background pixels and overall buffer validity. If the frame is empty-of-scene/obstructed
(e.g., usable-pixel ratio below a floor, or readback failed), the controller transitions to a
`blind` halt: it reports "cannot observe work area" and issues **no** trajectory. Empty work
area (valid view, no balls) is distinct → graceful "nothing to sort" stop.

**Rationale**: Directly encodes FR-008 and SC-005 (zero blind movements) and distinguishes the
two "no action" cases the spec calls out (obstructed vs. genuinely empty).

## R7 — Missed-grasp recovery (FR-010)

**Decision**: Reuse the existing post-pick grasp-error check in `handleTrajectoryComplete`
(`graspError > GRASP_ATTACH_TOLERANCE`). In autonomous mode a failed grasp does **not** end
the run: the controller increments a per-ball retry counter, returns to `observing`, and the
ball reappears in the next frame to be retried. After N consecutive failures (default 2) the
ball is skipped-and-reported as "grasp failed" so the loop cannot wedge.

**Rationale**: Builds on logic already in `main.ts`; bounded retries prevent infinite loops
while honoring "re-observe and retry rather than proceeding as if the pick succeeded."

## R8 — Ball color set: spec says red/blue, code uses red/green

**Decision**: Align the implementation to the spec — rename the second sortable color from
`green` to `blue` (ball material → blue, `BinColor`/`targetBin` 'green' → 'blue', bin visual
color). The HSV classifier then targets red + blue hue bands.

**Rationale**: The spec and all acceptance criteria/edge cases are written for **red and blue**
(平 "红色和蓝色小球"). Keeping green would make a blue HSV band detect nothing. The change is
mechanical and localized to `SortingStation.ts` constants + the bin label, and the third
"white" staging bin is unaffected.

**Alternatives considered**: Rewrite the spec to red/green — rejected; the user authored the
feature around red/blue, and blue is more visually separable from the red balls under the
scene lighting than green vs. red.

## R9 — Testing approach for headless logic

**Decision**: Add Vitest (dev-dependency) and test the two pure modules: `imageProcessing`
(synthetic RGBA buffers → expected colors/centroids/confidence) and `AutoSortController`
(injected fake `VisionSystem` + fake arm/station → asserted state transitions, skip/report,
blind-halt, retry cap). WebGL/DOM-bound code (renderer, three objects) is exercised only via
the manual `quickstart.md` scenarios.

**Rationale**: Keeps the risky logic deterministic and regression-guarded without standing up a
browser test harness; preserves the existing lightweight build/lint gates.
