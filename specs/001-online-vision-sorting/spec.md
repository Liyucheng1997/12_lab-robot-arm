# Feature Specification: Online Vision-Guided Ball Sorting

**Feature Branch**: `001-online-vision-sorting`

**Created**: 2026-06-14

**Status**: Draft

**Input**: User description: "生成一个带图像识别功能的机械臂。现在有红色和蓝色小球，通过摄像头识别把小球分类到不同的框，不需要人工干预。整个过程自动完成，通过在线识别，而不是离线。现在实现了大部分功能了，但是没有项目管理意识。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Autonomous color sorting from a live camera view (Priority: P1)

An operator places a mix of red and blue balls within reach of the robot arm and starts the station. Without any further human input, the system looks at the work area through its camera, recognizes each ball's color and position from what the camera actually sees, and the arm picks each ball and places it into the bin assigned to that color until the work area is clear.

**Why this priority**: This is the core promise of the product — fully autonomous, vision-driven sorting. Without it there is no feature.

**Independent Test**: Place several red and blue balls in the work area, press start, and confirm every ball ends up in the correctly colored bin with no human intervention.

**Acceptance Scenarios**:

1. **Given** a work area containing both red and blue balls, **When** the station is started, **Then** every red ball is placed in the red bin and every blue ball is placed in the blue bin without operator input.
2. **Given** the work area is empty, **When** the station is started, **Then** the system reports nothing to sort and the arm remains idle.
3. **Given** a single ball is added while the station is running, **When** the camera next observes the area, **Then** the ball is detected and sorted in the same cycle.

---

### User Story 2 - Recognition is based on what the camera sees, not pre-known positions (Priority: P1)

The system determines each ball's color and location purely from the camera image captured during operation ("online"), rather than from pre-supplied or ground-truth ball coordinates ("offline"). If a ball is not visible to the camera, the system does not act on it.

**Why this priority**: The user explicitly requires online recognition. This is the defining distinction of the feature and the property that makes the demonstration credible.

**Independent Test**: Move or add a ball that was never registered anywhere except in the camera's field of view; confirm the system still detects and sorts it. Place a ball outside the camera view; confirm the system does not act on it.

**Acceptance Scenarios**:

1. **Given** a ball whose position is known only through the live camera image, **When** a sorting cycle runs, **Then** the system locates and sorts it correctly.
2. **Given** a ball placed outside the camera's field of view, **When** a sorting cycle runs, **Then** the system does not attempt to pick it.
3. **Given** the camera view is fully obstructed, **When** a sorting cycle runs, **Then** the system reports that it cannot see the work area and does not move the arm blindly.

---

### User Story 3 - Continuous unattended operation until the area is clear (Priority: P2)

Once started, the station repeats observe → identify → pick → place cycles on its own and stops automatically when no more balls are detected, requiring no operator to advance each step.

**Why this priority**: Turns a single pick-and-place into a hands-off batch process, which is the practical value over a manual demo.

**Independent Test**: Start with multiple balls and confirm the system runs to completion and then stops on its own, without the operator triggering each ball.

**Acceptance Scenarios**:

1. **Given** multiple balls of both colors, **When** the station runs, **Then** it continues sorting cycle after cycle until none remain, then stops.
2. **Given** the area has just been cleared, **When** the next cycle begins, **Then** the system detects an empty area and halts gracefully.

---

### Edge Cases

- **Ambiguous color**: A ball whose color is neither clearly red nor clearly blue (e.g., poor lighting, shadow) — the system should leave it rather than misroute it, and surface that it was skipped.
- **Overlapping / touching balls**: Two balls close together in the image — the system should avoid treating them as one or grabbing both.
- **Unreachable ball**: A ball detected in the image but outside the arm's reach — the system should skip it and report it as unreachable.
- **Missed grasp**: The arm attempts a pick but the ball is not secured — the system should detect the failure on the next observation and retry rather than placing nothing into the bin.
- **Foreign object**: An object that is neither a red nor blue ball appears in view — the system should ignore it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST identify each ball's color (red or blue) from the live camera image captured during operation, without relying on externally supplied ball positions.
- **FR-002**: System MUST estimate each detected ball's location in the work area well enough for the arm to grasp it.
- **FR-003**: System MUST route each ball to the bin assigned to its color (red → red bin, blue → blue bin).
- **FR-004**: System MUST run the full observe-identify-pick-place sequence with no human intervention once started.
- **FR-005**: System MUST continue sorting until no more recognizable balls are detected, then stop automatically.
- **FR-006**: System MUST skip and report any ball it cannot confidently classify, rather than placing it in the wrong bin.
- **FR-007**: System MUST skip and report any detected ball that is outside the arm's reachable area.
- **FR-008**: System MUST refuse to move the arm when the work area cannot be observed (e.g., obstructed or empty camera view).
- **FR-009**: System MUST provide visible feedback of what it currently perceives (detected balls, their assumed colors, and target bins) so an observer can confirm decisions.
- **FR-010**: System MUST recover from a failed grasp by re-observing and retrying rather than proceeding as if the pick succeeded.

### Key Entities *(include if feature involves data)*

- **Ball**: A sortable item characterized by an observed color (red or blue) and an estimated location; may be in states such as detected, targeted, picked, sorted, or skipped.
- **Bin**: A destination container associated with exactly one color.
- **Detection**: A single observation of a ball from the camera image, carrying its assumed color, estimated location, and a confidence in that assumption.
- **Sorting Cycle**: One pass of observe → identify → pick → place over the currently visible balls.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a typical mix of clearly-colored red and blue balls in good lighting, at least 95% of balls are placed in the correct bin in a run.
- **SC-002**: Zero balls are placed in the wrong-color bin during a run; ambiguous balls are skipped rather than misrouted.
- **SC-003**: A full run from start to "area clear" completes with no human intervention after the initial start.
- **SC-004**: A ball made visible only to the camera (not pre-registered anywhere) is still detected and sorted, demonstrating online recognition.
- **SC-005**: When the work area cannot be observed, the arm makes zero blind movements.

## Assumptions

- The robot arm and scene operate in the existing 3D simulation environment; "camera" refers to the in-simulation vision sensor, and "online recognition" means recognition from the rendered camera image at run time rather than from ground-truth scene coordinates.
- Only two ball colors are in scope for this feature: red and blue. Additional colors are out of scope for v1.
- Lighting and ball appearance are controlled enough that clearly-colored balls are distinguishable by color; extreme lighting is treated as an edge case, not the norm.
- One camera observing the work area is sufficient; multi-camera fusion is out of scope for v1.
- Bins are at fixed, known locations; bin discovery via vision is out of scope for v1.
- The existing pick-and-place / kinematics capability of the arm is reused; this feature is about adding online recognition as the default (with offline retained as a debug mode) and making the loop autonomous, not redesigning the arm motion.

## Clarifications

### Session 2026-06-14

- Q: Should online vision **replace** the offline system outright, or should both coexist? → A: **Coexist.** Online recognition is the default operating mode; the offline (ground-truth) system is retained as a selectable debugging/comparison mode. A mode switch is in scope.
- Q: When a ball is repeatedly skipped (ambiguous color or unreachable), how should the run end? → A: **Finish the rest, report at the end.** The run does not stop; it sorts every ball it can, leaves skipped balls in place, and presents an end-of-run report listing what was skipped and why.

### Resolved requirements

- **FR-011**: System MUST default to online (image-based) recognition, while retaining the offline (ground-truth) recognition path as a selectable mode for debugging and for comparing online accuracy against ground truth.
- **FR-012**: System MUST allow switching between online and offline recognition modes without code changes (operator-selectable).
- **FR-013**: When balls are skipped, System MUST complete sorting of all other balls and then present an end-of-run report listing each skipped ball and the reason (ambiguous color, unreachable, etc.); the run MUST NOT halt solely because a ball was skipped.
