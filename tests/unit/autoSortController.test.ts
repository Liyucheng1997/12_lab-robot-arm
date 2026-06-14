import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import {
  AutoSortController,
  type AutoSortDeps,
  type ControllerState,
  type SortReport,
} from '../../src/sorting/AutoSortController';
import type { BallColor } from '../../src/sorting/SortingStation';
import type { VisionDetection, VisionFrame, VisionSystem } from '../../src/vision/VisionSystem';

interface FakeBall {
  id: string;
  color: BallColor;
  confidence?: number;
  areaPx?: number;
  reachable?: boolean;
  /** Grasp succeeds on this attempt number (1 = first try). Infinity = never. */
  graspSucceedsOnAttempt?: number;
}

class FakeVision implements VisionSystem {
  readonly mode = 'offline' as const;
  observable = true;
  balls: FakeBall[];

  constructor(balls: FakeBall[]) {
    this.balls = [...balls];
  }

  observe(): VisionFrame {
    return {
      width: 320,
      height: 240,
      pixels: new Uint8Array(0),
      usablePixelRatio: this.observable ? 1 : 0,
      isObservable: this.observable,
    };
  }

  detectBalls(): VisionDetection[] {
    return this.balls.map((ball) => ({
      ballId: ball.id,
      color: ball.color,
      pixel: new Vector2(0, 0),
      estimatedWorldPosition: new Vector3(0, 0, 0),
      confidence: ball.confidence ?? 1,
      areaPx: ball.areaPx ?? 1,
    }));
  }

  remove(id: string): void {
    this.balls = this.balls.filter((ball) => ball.id !== id);
  }

  find(id: string): FakeBall | undefined {
    return this.balls.find((ball) => ball.id === id);
  }
}

class Harness implements AutoSortDeps {
  readonly reports: SortReport[] = [];
  readonly states: ControllerState[] = [];
  current: FakeBall | null = null;
  planCalls = 0;
  private readonly graspCount = new Map<string, number>();

  constructor(public vision: FakeVision) {}

  isArmBusy(): boolean {
    return false;
  }

  planAndExecute(detection: VisionDetection): 'started' | 'unreachable' {
    this.planCalls += 1;
    const ball = this.vision.find(detection.ballId ?? '');
    if (!ball || ball.reachable === false) {
      return 'unreachable';
    }
    this.current = ball;
    return 'started';
  }

  onReport(report: SortReport): void {
    this.reports.push(report);
  }

  onState(state: ControllerState): void {
    this.states.push(state);
  }

  /** Simulate the pick trajectory finishing; returns whether the grasp held. */
  graspOk(): boolean {
    const ball = this.current;
    if (!ball) {
      return false;
    }
    const n = (this.graspCount.get(ball.id) ?? 0) + 1;
    this.graspCount.set(ball.id, n);
    return n >= (ball.graspSucceedsOnAttempt ?? 1);
  }
}

/** Drive the controller to completion, simulating the host/arm. */
function drive(controller: AutoSortController, harness: Harness, maxSteps = 1000): void {
  for (let step = 0; step < maxSteps; step += 1) {
    const state = controller.getState();
    if (state === 'done') {
      return;
    }
    if (state === 'observing') {
      controller.tick();
    } else if (state === 'picking') {
      controller.onTrajectoryComplete(harness.graspOk());
    } else if (state === 'placing') {
      const ball = harness.current;
      controller.onTrajectoryComplete(true);
      if (ball) {
        harness.vision.remove(ball.id);
      }
      harness.current = null;
    } else {
      throw new Error(`unexpected resting state: ${state}`);
    }
  }
  throw new Error('controller did not finish within step budget');
}

describe('AutoSortController', () => {
  it('scenario 1: sorts all actionable balls then stops with a clean report', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue' },
      { id: 'B3', color: 'red' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    drive(controller, harness);

    expect(controller.getState()).toBe('done');
    expect(harness.reports).toHaveLength(1);
    const report = harness.reports[0];
    expect(report.sortedCount).toBe(3);
    expect(report.skipped).toEqual([]);
    expect(report.endedBlind).toBe(false);
    expect(vision.balls).toHaveLength(0);
  });

  it('scenario 2: skips an ambiguous ball but sorts the rest', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue', confidence: 0.3 },
      { id: 'B3', color: 'red' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    drive(controller, harness);

    const report = harness.reports[0];
    expect(report.sortedCount).toBe(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].skipReason).toBe('ambiguous-color');
    expect(report.skipped[0].detection.ballId).toBe('B2');
  });

  it('scenario 3: skips an unreachable ball, loop continues', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue', reachable: false },
      { id: 'B3', color: 'red' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    drive(controller, harness);

    const report = harness.reports[0];
    expect(report.sortedCount).toBe(2);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].skipReason).toBe('unreachable');
  });

  it('scenario 4: retries a missed grasp once, then sorts it', () => {
    const vision = new FakeVision([{ id: 'B1', color: 'red', graspSucceedsOnAttempt: 2 }]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    drive(controller, harness);

    const report = harness.reports[0];
    expect(report.sortedCount).toBe(1);
    expect(report.skipped).toEqual([]);
    expect(report.sorted[0].attempts).toBe(2);
  });

  it('scenario 5: gives up after the retry cap and skips as grasp-failed', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red', graspSucceedsOnAttempt: Number.POSITIVE_INFINITY },
      { id: 'B2', color: 'blue' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness, { maxGraspRetries: 2 });

    controller.start();
    drive(controller, harness);

    const report = harness.reports[0];
    expect(report.sortedCount).toBe(1);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0].skipReason).toBe('grasp-failed');
    expect(report.skipped[0].detection.ballId).toBe('B1');
  });

  it('scenario 7: stop() mid-run ends gracefully with a partial report', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue' },
      { id: 'B3', color: 'red' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    controller.tick(); // observe + plan first ball → picking
    controller.stop();

    expect(controller.getState()).toBe('done');
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0].sortedCount).toBeLessThan(3);
    expect(harness.reports[0].endedBlind).toBe(false);
  });

  it('scenario 6: an unobservable view halts blind with zero arm motion', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue' },
    ]);
    vision.observable = false;
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    controller.tick();

    expect(controller.getState()).toBe('done');
    expect(harness.planCalls).toBe(0);
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0].endedBlind).toBe(true);
    expect(harness.reports[0].sortedCount).toBe(0);
  });

  it('US3: a skip never ends the run; the report carries every skip reason', () => {
    const vision = new FakeVision([
      { id: 'B1', color: 'red' },
      { id: 'B2', color: 'blue', confidence: 0.2 }, // ambiguous
      { id: 'B3', color: 'red', reachable: false }, // unreachable
      { id: 'B4', color: 'blue' },
    ]);
    const harness = new Harness(vision);
    const controller = new AutoSortController(harness);

    controller.start();
    drive(controller, harness);

    const report = harness.reports[0];
    expect(report.sortedCount).toBe(2);
    expect(report.totalSeen).toBe(4);
    expect(report.endedBlind).toBe(false);
    const reasons = report.skipped.map((decision) => decision.skipReason).sort();
    expect(reasons).toEqual(['ambiguous-color', 'unreachable']);
  });
});
