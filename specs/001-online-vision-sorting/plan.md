# Implementation Plan: Online Vision-Guided Ball Sorting

**Branch**: `001-online-vision-sorting` | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-online-vision-sorting/spec.md`

## Summary

The simulator already has a working 6-DoF arm, IK + ground-safe trajectory planning,
a physics-backed sorting station, and a fixed overhead camera that renders a top-down
preview. What it lacks is the feature's defining property: **online** (image-based)
recognition and a **hands-off** loop. Today the "vision" path projects ground-truth ball
world positions to pixels (that is *offline* recognition in disguise), and every ball is
sorted one at a time by clicking GUI buttons.

This plan adds:

1. A real **OnlineVisionSystem** that reads the rendered overhead-camera pixels and recovers
   ball color + ground position by color segmentation and back-projection — no ground-truth
   coordinates consumed.
2. A shared **VisionSystem** abstraction so online (default) and the existing offline path
   coexist behind an operator-selectable **mode switch** (FR-011/FR-012).
3. An **AutoSortController** state machine that runs observe → identify → pick → place
   continuously until the area is clear, skipping balls it cannot confidently classify or
   reach, recovering from missed grasps by re-observing, refusing to move when it cannot see
   the work area, and emitting an end-of-run **SortReport** (FR-004…FR-010, FR-013).

The arm motion, IK, and physics are reused unchanged.

## Technical Context

**Language/Version**: TypeScript 5.8 (ES modules), bundled by Vite 6

**Primary Dependencies**: three ^0.179 (rendering + camera/raycaster math), cannon-es ^0.20
(ball/bin physics), lil-gui ^0.20 (control panel)

**Storage**: N/A — all state is in-memory per browser session

**Testing**: Project currently has no automated test runner (gates are `tsc --noEmit` +
ESLint). Plan introduces **Vitest** for the pure, headless-testable logic only
(image-segmentation math, back-projection, and the AutoSortController state machine);
end-to-end behavior is validated through `quickstart.md` scenarios in the browser.

**Target Platform**: Modern desktop browser with WebGL2 (Chrome/Edge/Firefox)

**Project Type**: Single-project front-end 3D simulation (browser app)

**Performance Goals**: Maintain interactive frame rate (~60 fps) with the autonomous loop
running; one observe→pick→place cycle completes within the existing pick/place trajectory
durations (~7 s/ball) — throughput is not a graded criterion, correctness is.

**Constraints**: Online recognition must derive color and position **only** from rendered
camera pixels (no reading `ball.body.position`/`mesh.getWorldPosition` in the online path);
the arm must make **zero** blind moves when the view is unusable (SC-005); zero wrong-bin
placements (SC-002).

**Scale/Scope**: ~10 balls per run, 2 sortable colors (red, blue), 1 overhead camera,
3 bins. Single operator, single station.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is an unpopulated template — it
defines no ratified principles or gates. There are therefore no explicit constitutional
constraints to satisfy. The plan adopts the codebase's own conventions as de-facto gates:

- **Reuse over rebuild** — existing arm/IK/physics/camera are reused, not reimplemented.
- **Buildable + lint-clean** — `npm run build` (tsc) and `npm run lint` must stay green.
- **Online-truth honesty** — the online path must not consult ground-truth scene data; this
  is enforced by code review and by a Vitest test that feeds it only an image buffer.

No violations. Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-online-vision-sorting/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── vision-system.md
│   └── auto-sort-controller.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── vision/
│   ├── VisionSystem.ts          # NEW: shared interface + VisionDetection / VisionFrame types + mode enum
│   ├── OnlineVisionSystem.ts    # NEW: reads rendered pixels → segmentation → back-projection
│   ├── OfflineVisionSystem.ts   # EXISTING: ground-truth projection, refactored to implement VisionSystem
│   └── imageProcessing.ts       # NEW: pure color-classification + connected-component blob detection
├── sorting/
│   ├── SortingStation.ts        # EXISTING: ball/bin physics; ball color 'green' → 'blue' rename (see research)
│   └── AutoSortController.ts    # NEW: observe→identify→pick→place state machine, skip/retry, SortReport
├── ui/
│   └── gui.ts                   # EXISTING: add Auto Sort folder, vision-mode switch, Start/Stop, report view
├── scene/
│   └── renderer.ts              # EXISTING (overhead preview renderer already in main.ts)
└── main.ts                      # EXISTING: wire controller + mode switch into animate() loop

tests/
└── unit/
    ├── imageProcessing.test.ts  # NEW (Vitest): color classify + blob detect on synthetic buffers
    └── autoSortController.test.ts # NEW (Vitest): state-machine transitions with a fake VisionSystem + arm
```

**Structure Decision**: Single-project layout retained. New vision logic lives under
`src/vision/` behind a `VisionSystem` interface; the autonomous loop lives under
`src/sorting/`. Pure, deterministic logic (image processing, controller transitions) is
split into modules importable by Vitest without a DOM/WebGL context. `main.ts` remains the
composition root.

## Complexity Tracking

> No constitutional violations — section intentionally empty.
