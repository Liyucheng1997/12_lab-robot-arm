import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import {
  StationController,
  type StationDeps,
  type StationReport,
  type StationState,
} from '../../src/assembly/StationController';
import type { PartType } from '../../src/assembly/layout';
import type { DetectionColor, VisionDetection, VisionFrame } from '../../src/vision/VisionSystem';

function makeDetection(color: DetectionColor, confidence = 0.9): VisionDetection {
  return {
    color,
    pixel: new Vector2(120, 90),
    estimatedWorldPosition: new Vector3(1.12, 0.36, -0.02),
    confidence,
    areaPx: 120,
  };
}

interface Harness {
  controller: StationController;
  states: StationState[];
  reports: StationReport[];
  rejects: number;
  fastens: number;
  releases: number;
  planResults: ('started' | 'unreachable')[];
  setDetections(detections: VisionDetection[]): void;
  setObservable(observable: boolean): void;
  setPartReady(ready: boolean): void;
  setCarrierReady(ready: boolean): void;
}

function createHarness(station: number, partType: PartType): Harness {
  let detections: VisionDetection[] = [];
  let observable = true;
  let partReady = false;
  let carrierReady = false;

  const harness = {
    states: [] as StationState[],
    reports: [] as StationReport[],
    rejects: 0,
    fastens: 0,
    releases: 0,
    planResults: ['started'] as ('started' | 'unreachable')[],
  } as Harness;

  const deps: StationDeps = {
    vision: {
      observe(): VisionFrame {
        return {
          width: 320,
          height: 240,
          pixels: new Uint8Array(0),
          usablePixelRatio: observable ? 0.9 : 0.01,
          isObservable: observable,
        };
      },
      detectPickable: () => detections,
      detectAll: () => detections,
    },
    isPartReady: () => partReady,
    isCarrierReady: () => carrierReady,
    planAndExecute: () => harness.planResults[0] ?? 'started',
    isArmBusy: () => false,
    rejectPart: () => {
      harness.rejects += 1;
    },
    startFasten: () => {
      harness.fastens += 1;
    },
    releaseCarrier: () => {
      harness.releases += 1;
    },
    onState: (state) => {
      harness.states.push(state);
    },
    onReport: (report) => {
      harness.reports.push(report);
    },
  };

  harness.controller = new StationController(station, partType, deps);
  harness.setDetections = (next) => {
    detections = next;
  };
  harness.setObservable = (next) => {
    observable = next;
  };
  harness.setPartReady = (next) => {
    partReady = next;
  };
  harness.setCarrierReady = (next) => {
    carrierReady = next;
  };
  return harness;
}

/** Advance waiting → observing → (plan/pick) with the two ticks the loop needs. */
function tickThrough(harness: Harness): void {
  harness.controller.tick();
  harness.controller.tick();
}

describe('StationController', () => {
  it('runs a full pick-place cycle and releases the carrier', () => {
    const harness = createHarness(0, 'disc');
    harness.controller.start();
    expect(harness.controller.getState()).toBe('waiting');

    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('red')]);
    tickThrough(harness);
    expect(harness.controller.getState()).toBe('picking');

    harness.controller.onTrajectoryComplete(true);
    expect(harness.controller.getState()).toBe('placing');
    harness.controller.onPlaceSettled();
    expect(harness.releases).toBe(1);
    expect(harness.controller.getState()).toBe('waiting');
    expect(harness.controller.getPartsPlaced()).toBe(1);
  });

  it('interlock: does not act while the carrier is missing, even with a part ready', () => {
    const harness = createHarness(1, 'wheel');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(false);
    harness.setDetections([makeDetection('blue')]);
    tickThrough(harness);

    expect(harness.controller.getState()).toBe('waiting');
    expect(harness.rejects).toBe(0);

    harness.setCarrierReady(true);
    tickThrough(harness);
    expect(harness.controller.getState()).toBe('picking');
  });

  it('nut station torques after placing, then releases the finished carrier', () => {
    const harness = createHarness(2, 'nut');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('yellow')]);
    tickThrough(harness);
    harness.controller.onTrajectoryComplete(true);
    harness.controller.onPlaceSettled();

    expect(harness.controller.getState()).toBe('fastening');
    expect(harness.fastens).toBe(1);
    expect(harness.releases).toBe(0);
    harness.controller.onFastenComplete();
    expect(harness.releases).toBe(1);
    expect(harness.controller.getState()).toBe('waiting');
  });

  it('rejects a wrong part (blue when disc expected)', () => {
    const harness = createHarness(0, 'disc');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('blue')]);
    tickThrough(harness);

    expect(harness.rejects).toBe(1);
    expect(harness.controller.getState()).toBe('waiting');
  });

  it('rejects an ambiguous detection below the confidence threshold', () => {
    const harness = createHarness(0, 'disc');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('red', 0.2)]);
    tickThrough(harness);

    expect(harness.rejects).toBe(1);
    expect(harness.controller.getState()).toBe('waiting');
  });

  it('halts safely and reports when the camera view is lost', () => {
    const harness = createHarness(1, 'wheel');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setObservable(false);
    tickThrough(harness);

    expect(harness.controller.getState()).toBe('blind');
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0].endedBlind).toBe(true);
  });

  it('retries a failed grasp, then rejects the part after the retry cap', () => {
    const harness = createHarness(0, 'disc');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('red')]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      tickThrough(harness);
      expect(harness.controller.getState()).toBe('picking');
      harness.controller.onTrajectoryComplete(false);
      expect(harness.controller.getState()).toBe('observing');
    }

    tickThrough(harness);
    harness.controller.onTrajectoryComplete(false);
    expect(harness.rejects).toBe(1);
    expect(harness.controller.getState()).toBe('waiting');
  });

  it('emits a station report when stopped mid-run', () => {
    const harness = createHarness(0, 'disc');
    harness.controller.start();
    harness.setPartReady(true);
    harness.setCarrierReady(true);
    harness.setDetections([makeDetection('red')]);
    tickThrough(harness);
    harness.controller.onTrajectoryComplete(true);
    harness.controller.onPlaceSettled();

    harness.controller.stop();
    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0].partsPlaced).toBe(1);
    expect(harness.reports[0].endedBlind).toBe(false);
  });
});
