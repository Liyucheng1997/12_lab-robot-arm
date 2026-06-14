# Contract: AutoSortController

Drives the hands-off observe→identify→pick→place loop (US1/US3). Code-level contract.

## Interface

```ts
export interface AutoSortDeps {
  vision: VisionSystem;                       // active mode, swappable
  station: SortingStation;                    // ball/bin source + grasp attach/release
  planAndExecute(detection: VisionDetection): // returns how planning/execution resolved
    'started' | 'unreachable';                // 'started' kicks the trajectory player
  isArmBusy(): boolean;                        // trajectory player playing?
  onReport(report: SortReport): void;          // surface end-of-run report (FR-013)
  onState(state: ControllerState, status: string): void; // HUD feedback (FR-009)
}

export interface AutoSortController {
  start(): void;     // idle → observing
  stop(): void;      // any → reporting → done (graceful abort)
  /** Called once per animation frame by main.ts. */
  tick(): void;
  /** Called by the trajectory completion callback. */
  onTrajectoryComplete(graspOk: boolean): void;
  getState(): ControllerState;
}
```

## State machine

```text
idle ──start()──> observing
observing ──frame.isObservable == false──> blind ──> reporting (endedBlind=true)
observing ──no actionable detection──> reporting (normal "area clear")
observing ──pick best actionable detection──> planning
planning ──planAndExecute == 'unreachable'──> (mark skipped: unreachable) ──> observing
planning ──planAndExecute == 'started'──> picking
picking ──onTrajectoryComplete(graspOk=false)──> (attempts++) ──> observing   # retry (FR-010)
picking ──onTrajectoryComplete(graspOk=true)──> placing
placing ──onTrajectoryComplete(_)──> (record sorted) ──> observing
reporting ──onReport()──> done
any ──stop()──> reporting ──> done
```

## Selection rule (per `observing` cycle)

From `detectBalls(frame)` (already confidence-sorted), choose the **first** detection that is:
1. classifiable — `confidence ≥ ambiguousThreshold` (else record `skipped: ambiguous-color`);
2. not a cluster — `areaPx ≤ clusterThreshold` (else `skipped: cluster`, retry next cycle);
3. under the retry cap for its mapped ball — `attempts ≤ maxGraspRetries`.

If none qualifies **and** no ball remains that could qualify on a later cycle (e.g. nothing
left but permanently-skipped balls), transition to `reporting`.

## Behavioral guarantees

| ID | Guarantee |
|----|-----------|
| AC-1 | Once `start()`, the loop advances itself with no per-ball operator input until clear or `stop()`. (FR-004, US3) |
| AC-2 | Loop ends automatically when an observation has no actionable ball; it does **not** end merely because a ball was skipped. (FR-005, FR-013) |
| AC-3 | Wrong-bin placements never occur: ambiguous balls are skipped, not routed. (FR-006, SC-002) |
| AC-4 | Unreachable balls are skipped and reported, loop continues. (FR-007) |
| AC-5 | When `frame.isObservable === false`, controller goes `blind` and issues **zero** trajectories. (FR-008, SC-005) |
| AC-6 | A failed grasp returns to `observing` and retries up to `maxGraspRetries`, then skips as `grasp-failed`. (FR-010) |
| AC-7 | On reaching `reporting`, `onReport` fires with counts + every skip reason. (FR-013) |
| AC-8 | Each state change calls `onState` so the HUD reflects current perception/decision. (FR-009) |

## Test scenarios (Vitest, with fake `VisionSystem` + fake deps)

1. Three actionable detections across cycles → three `placing` completions, report
   `sortedCount=3`, `skipped=[]`, ends in `done`.
2. One ambiguous (low-confidence) detection among actionable ones → it is never planned;
   report lists it `skipped: ambiguous-color`; loop still completes the rest.
3. `planAndExecute` returns `unreachable` for a ball → `skipped: unreachable`, loop continues.
4. First `onTrajectoryComplete(false)` then `true` for same ball → one retry, then sorted;
   `attempts=2`.
5. `maxGraspRetries` consecutive failures → `skipped: grasp-failed`, loop continues.
6. `observe()` returns `isObservable=false` → state `blind`, no `planAndExecute` call,
   report `endedBlind=true`.
7. `stop()` mid-run → graceful `reporting`→`done` with partial counts.
