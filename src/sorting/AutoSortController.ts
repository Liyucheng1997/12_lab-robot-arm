import type { VisionDetection, VisionMode, VisionSystem } from '../vision/VisionSystem';
import type { BinColor } from './SortingStation';

export type SkipReason = 'ambiguous-color' | 'unreachable' | 'grasp-failed' | 'cluster';

export type ControllerState =
  | 'idle'
  | 'observing'
  | 'planning'
  | 'picking'
  | 'placing'
  | 'blind'
  | 'reporting'
  | 'done';

/** The controller's per-ball disposition, collected for the end-of-run report. */
export interface SortDecision {
  detection: VisionDetection;
  outcome: 'sorted' | 'skipped';
  skipReason: SkipReason | null;
  bin: BinColor | null;
  attempts: number;
}

/** Emitted when the run finishes (FR-013). */
export interface SortReport {
  startedAt: number;
  finishedAt: number;
  mode: VisionMode;
  totalSeen: number;
  sortedCount: number;
  sorted: SortDecision[];
  skipped: SortDecision[];
  endedBlind: boolean;
}

/** Host wiring the controller drives. Implemented in main.ts against the real arm/station. */
export interface AutoSortDeps {
  vision: VisionSystem;
  /** Plan + start executing a pick for this detection. */
  planAndExecute(detection: VisionDetection): 'started' | 'unreachable';
  /** True while a trajectory is playing. */
  isArmBusy(): boolean;
  /** Surface the end-of-run report (FR-013). */
  onReport(report: SortReport): void;
  /** Surface state/status for HUD feedback (FR-009). */
  onState(state: ControllerState, status: string): void;
}

export interface AutoSortControllerApi {
  start(): void;
  stop(): void;
  /** Called once per animation frame. */
  tick(): void;
  /** Called by the trajectory completion callback. */
  onTrajectoryComplete(graspOk: boolean): void;
  getState(): ControllerState;
}

export interface AutoSortOptions {
  /** Detections below this confidence are skipped as ambiguous (FR-006). */
  ambiguousThreshold: number;
  /** Components larger than this (px) are treated as touching balls and skipped (FR-003 edge). */
  clusterThreshold: number;
  /** Consecutive grasp failures tolerated before a ball is skipped as grasp-failed (FR-010). */
  maxGraspRetries: number;
}

const DEFAULT_OPTIONS: AutoSortOptions = {
  ambiguousThreshold: 0.6,
  clusterThreshold: Number.POSITIVE_INFINITY,
  maxGraspRetries: 2,
};

/**
 * Drives the hands-off observe -> identify -> pick -> place loop.
 * `tick()` advances the observing/planning transitions; `onTrajectoryComplete()`
 * advances picking/placing. No WebGL/DOM dependencies — testable headless.
 */
export class AutoSortController implements AutoSortControllerApi {
  private readonly options: AutoSortOptions;
  private state: ControllerState = 'idle';
  private running = false;
  private startedAt = 0;

  private currentDetection: VisionDetection | null = null;
  private readonly decisions: SortDecision[] = [];
  private readonly attempts = new Map<string, number>();
  private readonly skippedKeys = new Set<string>();
  private readonly seenKeys = new Set<string>();

  constructor(
    private readonly deps: AutoSortDeps,
    options: Partial<AutoSortOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getState(): ControllerState {
    return this.state;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.startedAt = Date.now();
    this.currentDetection = null;
    this.decisions.length = 0;
    this.attempts.clear();
    this.skippedKeys.clear();
    this.seenKeys.clear();
    this.setState('observing', 'observing work area');
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.finishRun(false);
  }

  tick(): void {
    if (!this.running || this.state !== 'observing' || this.deps.isArmBusy()) {
      return;
    }
    this.runObservationCycle();
  }

  onTrajectoryComplete(graspOk: boolean): void {
    if (!this.running || !this.currentDetection) {
      return;
    }

    if (this.state === 'picking') {
      if (!graspOk) {
        const key = this.keyOf(this.currentDetection);
        const next = (this.attempts.get(key) ?? 0) + 1;
        this.attempts.set(key, next);
        if (next > this.options.maxGraspRetries) {
          this.recordSkip(this.currentDetection, 'grasp-failed');
        }
        this.currentDetection = null;
        this.setState('observing', 'grasp failed; re-observing');
        return;
      }
      this.setState('placing', 'carrying ball to bin');
      return;
    }

    if (this.state === 'placing') {
      this.recordSorted(this.currentDetection);
      this.currentDetection = null;
      this.setState('observing', 'placed; re-observing');
    }
  }

  private runObservationCycle(): void {
    const frame = this.deps.vision.observe();
    if (!frame.isObservable) {
      this.setState('blind', 'cannot observe work area');
      this.finishRun(true);
      return;
    }

    const detections = this.deps.vision.detectBalls(frame);
    const target = this.selectActionable(detections);
    if (!target) {
      this.finishRun(false);
      return;
    }

    this.setState('planning', `planning ${this.label(target)}`);
    const result = this.deps.planAndExecute(target);
    if (result === 'unreachable') {
      this.recordSkip(target, 'unreachable');
      this.setState('observing', `${this.label(target)} unreachable; re-observing`);
      return;
    }

    this.currentDetection = target;
    this.setState('picking', `picking ${this.label(target)}`);
  }

  /** First detection that is classifiable, not a cluster, and under the retry cap. */
  private selectActionable(detections: VisionDetection[]): VisionDetection | null {
    for (const detection of detections) {
      const key = this.keyOf(detection);
      this.seenKeys.add(key);
      if (this.skippedKeys.has(key)) {
        continue;
      }
      if (detection.confidence < this.options.ambiguousThreshold) {
        this.recordSkip(detection, 'ambiguous-color');
        continue;
      }
      if (detection.areaPx > this.options.clusterThreshold) {
        this.recordSkip(detection, 'cluster');
        continue;
      }
      if ((this.attempts.get(key) ?? 0) > this.options.maxGraspRetries) {
        this.recordSkip(detection, 'grasp-failed');
        continue;
      }
      return detection;
    }
    return null;
  }

  private recordSorted(detection: VisionDetection): void {
    const key = this.keyOf(detection);
    this.decisions.push({
      detection,
      outcome: 'sorted',
      skipReason: null,
      bin: detection.color,
      attempts: (this.attempts.get(key) ?? 0) + 1,
    });
  }

  private recordSkip(detection: VisionDetection, reason: SkipReason): void {
    const key = this.keyOf(detection);
    this.skippedKeys.add(key);
    this.decisions.push({
      detection,
      outcome: 'skipped',
      skipReason: reason,
      bin: null,
      attempts: this.attempts.get(key) ?? 0,
    });
  }

  private finishRun(endedBlind: boolean): void {
    this.running = false;
    this.currentDetection = null;
    this.setState('reporting', endedBlind ? 'halted: work area not observable' : 'run complete');
    const sorted = this.decisions.filter((decision) => decision.outcome === 'sorted');
    const skipped = this.decisions.filter((decision) => decision.outcome === 'skipped');
    this.deps.onReport({
      startedAt: this.startedAt,
      finishedAt: Date.now(),
      mode: this.deps.vision.mode,
      totalSeen: this.seenKeys.size,
      sortedCount: sorted.length,
      sorted,
      skipped,
      endedBlind,
    });
    this.setState('done', endedBlind ? 'done (blind halt)' : 'done');
  }

  private setState(state: ControllerState, status: string): void {
    this.state = state;
    this.deps.onState(state, status);
  }

  private keyOf(detection: VisionDetection): string {
    if (detection.ballId) {
      return detection.ballId;
    }
    const { x, z } = detection.estimatedWorldPosition;
    return `${x.toFixed(2)},${z.toFixed(2)}`;
  }

  private label(detection: VisionDetection): string {
    return `${detection.ballId ?? 'ball'} (${detection.color})`;
  }
}
