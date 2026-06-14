# Phase 1 Data Model: Online Vision-Guided Ball Sorting

In-memory, per-session entities. Types are TypeScript; no persistence. Field types use three.js
math types (`Vector2`, `Vector3`) where the existing code already does.

## Enums / value types

```text
BallColor   = 'red' | 'blue'                 # sortable colors (was 'red' | 'green')
BinColor    = 'white' | 'red' | 'blue'       # 'white' = staging bin, unchanged
VisionMode  = 'online' | 'offline'           # operator-selectable; default 'online'
SkipReason  = 'ambiguous-color' | 'unreachable' | 'grasp-failed' | 'cluster'
ControllerState =
  'idle' | 'observing' | 'planning' | 'picking' | 'placing' |
  'blind' | 'reporting' | 'done'
```

## Entity: Ball (existing — `SortableBall`)

The physical sortable item. Already exists in `SortingStation.ts`; only the color domain changes.

| Field      | Type        | Notes                                              |
|------------|-------------|----------------------------------------------------|
| id         | string      | e.g. `B1`                                          |
| color      | BallColor   | red \| blue (ground truth; used only by offline path) |
| mesh       | Mesh        | three.js sphere                                    |
| body       | CANNON.Body | physics body                                       |
| targetBin  | BinColor    | red→red, blue→blue                                 |

**States** (conceptual, tracked by the controller, not stored on the ball):
`detected → targeted → picked → sorted`, or `detected → skipped(reason)`.

## Entity: Bin (existing — `BinConfig`)

Fixed destination container, one per color. Unchanged except `green`→`blue`.

| Field       | Type    | Notes                          |
|-------------|---------|--------------------------------|
| color       | BinColor| white \| red \| blue           |
| center      | Vector3 | fixed known location           |
| visualColor | number  | render color                   |

## Entity: VisionFrame (NEW)

One captured observation of the work area from the overhead camera.

| Field           | Type           | Notes                                                        |
|-----------------|----------------|-------------------------------------------------------------|
| width           | number         | e.g. 320                                                    |
| height          | number         | e.g. 240                                                    |
| pixels          | Uint8Array     | RGBA buffer read back from the render target                |
| usablePixelRatio| number         | fraction of non-background pixels; drives FR-008 blind check |
| isObservable    | boolean        | false → view obstructed/unreadable → controller goes `blind` |

## Entity: VisionDetection (existing — extended)

A single observation of one ball from the image. Already exists; meaning of fields tightens so
the **online** path populates them from pixels only.

| Field                 | Type      | Notes                                                          |
|-----------------------|-----------|----------------------------------------------------------------|
| ballId                | string \| null | online path may not know the true id → null; matched by nearest position when needed |
| color                 | BallColor | classified from hue                                            |
| pixel                 | Vector2   | blob centroid in image space                                  |
| estimatedWorldPosition| Vector3   | back-projected onto ball-center plane                          |
| confidence            | number    | 0..1 from hue purity / blob quality                           |
| areaPx                | number    | NEW: component pixel count (cluster/size checks, FR-003 edge) |

> Note: in the online path `ballId` is not derived from ground truth. For execution the
> controller maps a detection to a `SortableBall` by nearest `estimatedWorldPosition`, since
> the existing pick/attach plumbing operates on a `SortableBall`. This mapping is an
> execution convenience and is **not** used for recognition.

## Entity: SortDecision (NEW)

The controller's per-ball decision for the end-of-run report.

| Field      | Type                  | Notes                                  |
|------------|-----------------------|----------------------------------------|
| detection  | VisionDetection       | what was seen                          |
| outcome    | 'sorted' \| 'skipped' | terminal disposition                   |
| skipReason | SkipReason \| null    | set when outcome = 'skipped'           |
| bin        | BinColor \| null      | bin used when sorted                   |
| attempts   | number                | grasp attempts spent                   |

## Entity: SortReport (NEW)

Emitted when the run reaches `reporting`/`done` (FR-013).

| Field        | Type            | Notes                                          |
|--------------|-----------------|------------------------------------------------|
| startedAt    | number          | timestamp                                      |
| finishedAt   | number          | timestamp                                      |
| mode         | VisionMode      | mode the run used                              |
| totalSeen    | number          | distinct balls observed                        |
| sortedCount  | number          | placed correctly                               |
| skipped      | SortDecision[]  | each skip with reason (ambiguous/unreachable/…) |
| endedBlind   | boolean         | true if halted because view was unobservable   |

## Entity: AutoSortController (NEW — behavioral)

Owns the loop. Holds: current `state`, active `VisionSystem`, the `VisionMode`, a per-ball
`attempts` map, the accumulating `SortDecision[]`, and `maxGraspRetries` (default 2).
Transitions are defined in [contracts/auto-sort-controller.md](./contracts/auto-sort-controller.md).

## Relationships

```text
SortingStation 1───* Ball
SortingStation 1───* Bin
AutoSortController 1───1 VisionSystem (online|offline, swappable)
AutoSortController 1───* SortDecision ──1 VisionDetection
AutoSortController 1───1 SortReport
VisionSystem.observe() ──> VisionFrame ──> detectBalls() ──> VisionDetection[]
```

## Validation rules (from requirements)

- A detection with `confidence` below the ambiguous threshold ⇒ `skipped: ambiguous-color`
  (FR-006); never placed in a bin (SC-002).
- A detection whose plan fails IK/ground-safety ⇒ `skipped: unreachable` (FR-007).
- A detection with `areaPx` above the cluster threshold ⇒ `skipped: cluster` for this cycle.
- `VisionFrame.isObservable === false` ⇒ controller `blind`, **zero** arm motion (FR-008/SC-005).
- Grasp error > tolerance ⇒ re-observe + retry until `attempts > maxGraspRetries`, then
  `skipped: grasp-failed` (FR-010).
- Run ends only when an observation yields no actionable detection, or Stop is pressed; a skip
  alone never ends the run (FR-005/FR-013).
