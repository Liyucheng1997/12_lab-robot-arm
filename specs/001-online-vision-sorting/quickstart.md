# Quickstart & Validation: Online Vision-Guided Ball Sorting

Validates the feature end-to-end in the browser. Assumes the implementation from
[plan.md](./plan.md) is in place. References: [data-model.md](./data-model.md),
[contracts/vision-system.md](./contracts/vision-system.md),
[contracts/auto-sort-controller.md](./contracts/auto-sort-controller.md).

## Prerequisites

- Node 18+ and the repo dependencies installed.
- A WebGL2-capable desktop browser.

## Setup & run

```powershell
npm install
npm run dev        # Vite dev server, open the printed http://localhost:5173
```

Headless gates (must pass before sign-off):

```powershell
npm run build      # tsc --noEmit + vite build
npm run lint       # eslint
npm test           # vitest (imageProcessing + AutoSortController)
```

## What you should see

- The scene has red and **blue** balls in the white staging bin, red and blue destination bins,
  and the overhead camera rig.
- A GUI folder **"Auto Sort"** with: a **Vision mode** dropdown (`online` default / `offline`),
  **Start** and **Stop** buttons, and a live status/report area. The overhead camera preview
  panel shows the actual top-down image used for recognition.

## Validation scenarios

### S1 — Autonomous online sorting until clear (US1, US3 / FR-004, FR-005, SC-001, SC-003)
1. Ensure mode = `online`. Press **Start**.
2. Expect: with no further input, the arm picks each ball and drops red→red bin, blue→blue bin,
   cycle after cycle, then stops on its own with a report.
3. Pass: ≥95% of clearly-colored balls land in the correct bin; run completes hands-off.

### S2 — Online recognition is image-based (US2 / FR-001, SC-004)
1. Before starting, drag/add a ball into the camera view at a fresh spot.
2. Press **Start**. Pass: it is detected and sorted using only what the camera sees.
3. Place a ball **outside** the camera frustum → Pass: it is never picked (US2 #2).

### S3 — Refuse to act when blind (FR-008, SC-005)
1. Obstruct the overhead view (e.g. move an object fully under the camera, or force
   `isObservable=false` via the debug toggle).
2. Press **Start**. Pass: status shows "cannot observe work area", arm makes **zero** moves,
   report `endedBlind=true`.

### S4 — Ambiguous & wrong-bin safety (FR-006 / SC-002)
1. Introduce a poorly-lit / desaturated ball.
2. Run. Pass: it is left in place and listed under skipped → `ambiguous-color`; **no** ball is
   ever placed in the wrong-color bin.

### S5 — Unreachable ball (FR-007)
1. Place a detectable ball outside the arm's reach.
2. Run. Pass: it is skipped → `unreachable`; the rest still sort; loop continues.

### S6 — Missed-grasp recovery (FR-010)
1. Run a normal batch and observe a cycle where a grasp misses (or inject a forced miss).
2. Pass: the controller re-observes and retries the same ball rather than dropping nothing;
   after the retry cap it skips → `grasp-failed` and continues.

### S7 — End-of-run report with skips, run not halted by a skip (FR-013)
1. Run a batch containing at least one ambiguous and one unreachable ball.
2. Pass: every other ball is sorted, the run finishes (not halted by the skips), and the report
   lists each skipped ball with its reason.

### S8 — Mode switch / offline comparison (FR-011, FR-012)
1. Switch **Vision mode** to `offline`, Start. Pass: the run uses the ground-truth path with no
   code change or reload.
2. Compare the offline detections (ground truth) against online detections for the same scene
   to sanity-check online accuracy. Switch back to `online`.

## Sign-off checklist

- [ ] S1–S8 pass in the browser
- [ ] `npm run build`, `npm run lint`, `npm test` all green
- [ ] Online path reads no ground-truth ball coordinates (code review of `OnlineVisionSystem`)
- [ ] Zero wrong-bin placements observed across runs (SC-002)
