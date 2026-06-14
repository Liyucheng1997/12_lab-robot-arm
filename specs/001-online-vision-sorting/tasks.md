---
description: "Task list for Online Vision-Guided Ball Sorting"
---

# Tasks: Online Vision-Guided Ball Sorting

**Input**: Design documents from `/specs/001-online-vision-sorting/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: INCLUDED — the plan and the two contracts explicitly define Vitest scenarios for the
pure logic (`imageProcessing`, `AutoSortController`). Browser/WebGL behavior is validated via
[quickstart.md](./quickstart.md), not automated tests.

**Organization**: Tasks are grouped by user story. Story split (both US1 and US2 are P1):

- **US1** = autonomous hands-off loop (built against the `VisionSystem` interface using the
  existing/refactored offline provider) → proves autonomy end-to-end. **MVP.**
- **US2** = genuine **online** (image-based) recognition + operator-selectable mode switch,
  default online → swaps the recognition source behind the same interface.
- **US3** = continuous-until-clear auto-stop + end-of-run report.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- File paths are repository-root relative.

## Path Conventions

Single project: `src/` and `tests/` at repository root (per [plan.md](./plan.md) Structure Decision).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Test harness + the color alignment both stories assume.

- [ ] T001 Add Vitest as a dev dependency and a `test` script (`"test": "vitest run"`, `"test:watch": "vitest"`) in `package.json`; create `vitest.config.ts` at repo root (node environment, include `tests/**/*.test.ts`).
- [ ] T002 [P] Create the `tests/unit/` directory and a placeholder `tests/unit/.gitkeep`; confirm `npm test` runs green with zero tests.
- [ ] T003 Align ball color set spec→code (research R8): in `src/sorting/SortingStation.ts` change `BallColor` `'green'`→`'blue'`, `BinColor` `'green'`→`'blue'`, the ball material color, the bin `visualColor`/`color`, and `createInitialBalls` color array. Update any `'green'` references in `src/main.ts`/`src/ui/gui.ts`. Verify `npm run build` + `npm run lint` stay green.

**Checkpoint**: Build/lint/test green; balls are red + blue.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `VisionSystem` seam and shared types every story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T004 [P] Create `src/vision/VisionSystem.ts` defining `VisionMode`, `VisionFrame`, `VisionDetection` (with `ballId: string | null` and `areaPx`), and the `VisionSystem` interface, per [contracts/vision-system.md](./contracts/vision-system.md). Re-export `VisionDetection` type used by `main.ts`.
- [ ] T005 Refactor `src/vision/OfflineVisionSystem.ts` to `implements VisionSystem`: add `readonly mode = 'offline'`, add `observe(): VisionFrame` (synthesize a frame with `isObservable=true`), keep existing ground-truth `detectBalls` but accept the `VisionFrame` arg signature and populate `areaPx` (constant) and `ballId`. Update its import of `VisionDetection` to come from `VisionSystem.ts`.
- [ ] T006 [P] Add shared sorting/report types in `src/sorting/AutoSortController.ts` (new file, types only for now): `SkipReason`, `ControllerState`, `SortDecision`, `SortReport`, `AutoSortDeps`, `AutoSortController` interface per [contracts/auto-sort-controller.md](./contracts/auto-sort-controller.md) and [data-model.md](./data-model.md).

**Checkpoint**: Interfaces compile; offline path implements `VisionSystem`; `npm run build` green.

---

## Phase 3: User Story 1 - Autonomous hands-off sorting loop (Priority: P1) 🎯 MVP

**Goal**: Press Start → arm picks each ball and routes red→red bin, blue→blue bin with no
per-ball operator input, skipping ambiguous/unreachable balls safely.

**Independent Test**: With several red+blue balls, press Start (mode may be offline at this
stage); every ball lands in the correct bin with no human intervention; no wrong-bin placements.

### Tests for User Story 1 ⚠️ (write first, ensure they fail)

- [ ] T007 [P] [US1] Write `tests/unit/autoSortController.test.ts` covering controller scenarios 1–5 & 7 from [contracts/auto-sort-controller.md](./contracts/auto-sort-controller.md) (sort all, skip ambiguous, skip unreachable, grasp retry then sort, retry-cap→grasp-failed, stop mid-run) using a fake `VisionSystem` + fake `AutoSortDeps`.

### Implementation for User Story 1

- [ ] T008 [US1] Implement `AutoSortController` class in `src/sorting/AutoSortController.ts`: state machine (`idle→observing→planning→picking→placing→reporting→done`), `start`/`stop`/`tick`/`onTrajectoryComplete`/`getState`, selection rule (confidence ≥ ambiguousThreshold, areaPx ≤ clusterThreshold, attempts ≤ maxGraspRetries), `attempts` map, `SortDecision[]` accumulation. No WebGL/DOM imports.
- [ ] T009 [US1] Add a `planAndExecute(detection)` adapter in `src/main.ts` that maps a `VisionDetection` to the nearest `SortableBall`, calls the existing `planSortTrajectoryForTarget`, returns `'started' | 'unreachable'`, and starts the player; wire `carriedBall`/grasp-error result into `controller.onTrajectoryComplete(graspOk)` inside `handleTrajectoryComplete`.
- [ ] T010 [US1] Instantiate `AutoSortController` in `src/main.ts` with the offline `VisionSystem` as the initial provider; call `controller.tick()` inside `animate()`; route `onState` to the HUD (`operationStatus`) for visible feedback (FR-009).
- [ ] T011 [US1] Add an **"Auto Sort"** folder in `src/ui/gui.ts` with **Start** and **Stop** buttons wired to `controller.start()`/`controller.stop()`; extend `RobotGuiOptions` accordingly.
- [ ] T012 [US1] Implement skip safety in the controller path: ambiguous (low confidence) → `SortDecision skipped:'ambiguous-color'`; plan `unreachable` → `skipped:'unreachable'`; never route a skipped ball to a bin (FR-003/006/007, SC-002).

**Checkpoint**: Start runs a full hands-off batch using the existing recognition; controller tests pass.

---

## Phase 4: User Story 2 - Genuine online (image-based) recognition + mode switch (Priority: P1)

**Goal**: Recognition derives color + position **only** from rendered camera pixels; online is
the default; offline remains operator-selectable for debugging/comparison.

**Independent Test**: A ball made visible only to the camera is detected and sorted; a ball
outside the camera view is never picked; switching mode to offline works with no code change.

### Tests for User Story 2 ⚠️ (write first, ensure they fail)

- [ ] T013 [P] [US2] Write `tests/unit/imageProcessing.test.ts` covering vision scenarios 1–5 from [contracts/vision-system.md](./contracts/vision-system.md) (single red blob, red+blue sorted, ambiguous low-confidence, merged-blob area flag, empty buffer / non-observable) on synthetic RGBA buffers.

### Implementation for User Story 2

- [ ] T014 [P] [US2] Implement `src/vision/imageProcessing.ts` (pure, no three.js objects): RGB→HSV, per-pixel red/blue classification with clear-core bands, single-pass connected-component labeling, per-component centroid/`areaPx`/confidence, and a `usablePixelRatio` helper. Per [research.md](./research.md) R2/R3.
- [ ] T015 [US2] Implement `src/vision/OnlineVisionSystem.ts` `implements VisionSystem` (`mode='online'`): reuse the existing overhead `PerspectiveCamera` + camera rig; `observe()` renders to an offscreen `WebGLRenderTarget` and reads back pixels (`readRenderTargetPixels`) into a `VisionFrame` with `isObservable` from `usablePixelRatio`; `detectBalls(frame)` runs `imageProcessing` + back-projects each centroid via raycast to the ball-center plane (reuse `estimateWorldFromPixel` logic). MUST NOT read ball world positions/colors (VS-1).
- [ ] T016 [US2] Add `VisionMode` switch in `src/ui/gui.ts` (dropdown `online`/`offline`, default `online`) and `onVisionModeChanged` in `src/main.ts` that swaps the controller's active `VisionSystem` instance at runtime (FR-011/FR-012).
- [ ] T017 [US2] Make online the startup default in `src/main.ts`: construct `OnlineVisionSystem`, add its `group` to the scene, point the existing preview renderer at its camera, and pass it to the controller as the initial provider; keep offline instance available for the switch.
- [ ] T018 [US2] Implement blind-halt in the controller's `observing` step: when `frame.isObservable === false`, transition to `blind`→`reporting` with `endedBlind=true` and issue **zero** trajectories (FR-008, SC-005); surface "cannot observe work area" via `onState`.

**Checkpoint**: Online recognition drives the loop by default; mode switch and blind-halt work; both test suites pass.

---

## Phase 5: User Story 3 - Continuous unattended run + end-of-run report (Priority: P2)

**Goal**: The station repeats cycles on its own, stops automatically when no actionable ball
remains, and presents an end-of-run report; a skip never halts the run.

**Independent Test**: Start with multiple balls of both colors → runs to completion and stops on
its own; a run containing skipped balls finishes the rest and reports each skip with its reason.

### Tests for User Story 3 ⚠️ (write first, ensure they fail)

- [ ] T019 [P] [US3] Extend `tests/unit/autoSortController.test.ts` with scenario 6 (non-observable → `blind`/`endedBlind=true`) and a "skip does not end the run; run ends only on no-actionable-ball" assertion, plus report-content assertions (counts + every skip reason).

### Implementation for User Story 3

- [ ] T020 [US3] Implement run termination in the controller: end only when an observation yields no actionable detection (or `stop()`), never solely because a ball was skipped; emit `SortReport` via `AutoSortDeps.onReport` on entering `reporting` (FR-005, FR-013).
- [ ] T021 [US3] Implement grasp-failure recovery loop in the controller: on `onTrajectoryComplete(graspOk=false)` increment `attempts`, return to `observing`; after `maxGraspRetries` record `skipped:'grasp-failed'` and continue (FR-010).
- [ ] T022 [US3] Render the end-of-run report in the UI: add a report/status area (in the GUI "Auto Sort" folder or the HUD/vision panel via `src/main.ts`) showing `sortedCount`, `totalSeen`, `endedBlind`, and the skipped list with reasons (FR-013, FR-009).

**Checkpoint**: Full unattended batch terminates on its own and reports; all stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T023 [P] Update panel labels/copy in `src/main.ts` and `src/style.css` from "Offline Vision" to reflect the active mode (e.g. "Vision Camera (online)") and style the report area.
- [ ] T024 [P] Tune thresholds (ambiguous confidence, cluster area, `usablePixelRatio` floor, `maxGraspRetries`) as named constants in `src/vision/imageProcessing.ts` / `src/sorting/AutoSortController.ts` and document them inline.
- [ ] T025 Run the full [quickstart.md](./quickstart.md) scenarios S1–S8 in the browser and record pass/fail; fix regressions.
- [ ] T026 Final gate: `npm run build`, `npm run lint`, `npm test` all green; code-review `OnlineVisionSystem` to confirm no ground-truth reads (VS-1 / SC-004).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup; BLOCKS all user stories.
- **US1 (Phase 3)**: depends on Foundational. MVP; uses offline provider.
- **US2 (Phase 4)**: depends on Foundational; integrates with the US1 controller (swaps its provider) but the online vision module + tests are independently verifiable.
- **US3 (Phase 5)**: depends on the US1 controller existing; hardens termination/report/retry.
- **Polish (Phase 6)**: depends on all targeted stories.

### Within Each User Story

- Test task first (write failing), then implementation.
- Controller core (T008) before its main.ts wiring (T009–T012).
- `imageProcessing` (T014) before `OnlineVisionSystem` (T015) before mode switch/default (T016–T017).

### Parallel Opportunities

- T002 ∥ within Setup; T004 ∥ T006 in Foundational.
- T007 (US1 tests) ∥ T013 (US2 tests) — different files.
- T014 (pure image processing) can be built ∥ with US1 wiring since it touches a new file.

---

## Parallel Example: Foundational + test scaffolding

```bash
Task: "T004 Create src/vision/VisionSystem.ts interface + types"
Task: "T006 Create src/sorting/AutoSortController.ts types (SortReport, AutoSortDeps, ...)"
# then, once interfaces exist:
Task: "T007 Write tests/unit/autoSortController.test.ts (fake VisionSystem + deps)"
Task: "T013 Write tests/unit/imageProcessing.test.ts (synthetic RGBA buffers)"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 (autonomous loop on offline provider).
4. **STOP & VALIDATE**: hands-off batch sorts correctly (quickstart S1, with mode=offline acceptable here).

### Incremental Delivery

1. Setup + Foundational → seam ready.
2. US1 → hands-off autonomy (MVP demo).
3. US2 → swap in real online recognition + mode switch (delivers the feature's defining property; quickstart S2/S3/S8).
4. US3 → unattended termination + report (quickstart S5–S7).

---

## Notes

- [P] = different files, no incomplete-task dependency.
- Online path must never read `SortableBall.body`/`mesh` world position or `.color` (VS-1, SC-004) — enforced in T015 and re-checked in T026.
- Commit after each task or logical group; verify tests fail before implementing.
