import type { VisionDetection, VisionSystem } from '../vision/VisionSystem';
import { PART_SPECS, PART_TYPE_BY_MARKER, type PartType } from './layout';

export type StationState =
  | 'idle'
  | 'waiting'
  | 'observing'
  | 'planning'
  | 'picking'
  | 'placing'
  | 'fastening'
  | 'blind'
  | 'done';

export type RejectReason = 'wrong-part' | 'ambiguous' | 'unreachable' | 'grasp-failed';

export interface RejectRecord {
  detection: VisionDetection | null;
  reason: RejectReason;
}

/** Per-station tally surfaced when the line stops. */
export interface StationReport {
  station: number;
  partType: PartType;
  partsPlaced: number;
  rejects: RejectRecord[];
  endedBlind: boolean;
}

/**
 * Host wiring one station drives. The two `is*Ready` gates form the line
 * interlock: the robot only commits to a cycle when its part is settled at the
 * pick station AND its carrier is parked with the previous steps completed.
 */
export interface StationDeps {
  vision: VisionSystem;
  /** True when a settled part is waiting at this station's pick point. */
  isPartReady(): boolean;
  /** True when a carrier with exactly the previous steps done is parked here. */
  isCarrierReady(): boolean;
  /** Plan + start executing a pick for this detection. */
  planAndExecute(detection: VisionDetection): 'started' | 'unreachable';
  /** True while this station's arm is moving or holding a part. */
  isArmBusy(): boolean;
  /** Let the wrong/unpickable part leave on the infeed return. */
  rejectPart(): void;
  /** Torque the nut down; host calls onFastenComplete() when finished. */
  startFasten(): void;
  /** Hand the carrier back to the line so it advances to the next station. */
  releaseCarrier(): void;
  onState(state: StationState, status: string): void;
  onReport(report: StationReport): void;
}

export interface StationOptions {
  /** Detections below this confidence are treated as ambiguous and rejected. */
  ambiguousThreshold: number;
  /** Consecutive grasp failures tolerated before the part is rejected. */
  maxGraspRetries: number;
}

const DEFAULT_OPTIONS: StationOptions = {
  ambiguousThreshold: 0.5,
  maxGraspRetries: 2,
};

/**
 * One assembly station's control loop: wait for part + carrier, identify the
 * part from camera pixels, verify it is this station's part type, pick it,
 * seat it on the carrier, optionally torque it (nut station), then release the
 * carrier downstream. No WebGL/DOM dependencies — testable headless.
 */
export class StationController {
  private readonly options: StationOptions;
  private state: StationState = 'idle';
  private running = false;
  private graspRetries = 0;
  private partsPlaced = 0;
  private readonly rejects: RejectRecord[] = [];

  constructor(
    readonly station: number,
    readonly partType: PartType,
    private readonly deps: StationDeps,
    options: Partial<StationOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getState(): StationState {
    return this.state;
  }

  getPartsPlaced(): number {
    return this.partsPlaced;
  }

  getRejectCount(): number {
    return this.rejects.length;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.graspRetries = 0;
    this.partsPlaced = 0;
    this.rejects.length = 0;
    this.setState('waiting', '等待来料与托架');
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.finishRun(false);
  }

  tick(): void {
    if (!this.running || this.deps.isArmBusy()) {
      return;
    }
    if (this.state === 'waiting' && this.deps.isPartReady() && this.deps.isCarrierReady()) {
      this.setState('observing', '视觉识别中');
      return;
    }
    if (this.state === 'observing') {
      this.runObservationCycle();
    }
  }

  onTrajectoryComplete(graspOk: boolean): void {
    if (!this.running || this.state !== 'picking') {
      return;
    }
    if (!graspOk) {
      this.graspRetries += 1;
      if (this.graspRetries > this.options.maxGraspRetries) {
        this.recordReject(null, 'grasp-failed');
        this.deps.rejectPart();
        this.graspRetries = 0;
        this.setState('waiting', '抓取失败超限，零件退回');
        return;
      }
      this.setState('observing', `抓取失败，重试 ${this.graspRetries}/${this.options.maxGraspRetries}`);
      return;
    }
    this.graspRetries = 0;
    this.setState('placing', `装配 ${PART_SPECS[this.partType].label}`);
  }

  /** Called by the host when the placed part has settled onto its seat. */
  onPlaceSettled(): void {
    if (!this.running || this.state !== 'placing') {
      return;
    }
    this.partsPlaced += 1;

    if (this.partType === 'nut') {
      this.setState('fastening', '拧紧锁紧螺母');
      this.deps.startFasten();
      return;
    }

    this.deps.releaseCarrier();
    this.setState('waiting', '托架放行，等待下一循环');
  }

  onFastenComplete(): void {
    if (!this.running || this.state !== 'fastening') {
      return;
    }
    this.deps.releaseCarrier();
    this.setState('waiting', '成品放行，等待下一循环');
  }

  private runObservationCycle(): void {
    const frame = this.deps.vision.observe();
    if (!frame.isObservable) {
      this.setState('blind', '相机视野被遮挡，安全停机');
      this.finishRun(true);
      return;
    }

    const detections = this.deps.vision.detectPickable(frame);
    const match = detections.find(
      (detection) =>
        PART_TYPE_BY_MARKER[detection.color] === this.partType &&
        detection.confidence >= this.options.ambiguousThreshold,
    );

    if (match) {
      this.setState('planning', `规划抓取 ${PART_SPECS[this.partType].label}`);
      const result = this.deps.planAndExecute(match);
      if (result === 'unreachable') {
        this.recordReject(match, 'unreachable');
        this.deps.rejectPart();
        this.setState('waiting', '目标不可达，零件退回');
        return;
      }
      this.setState('picking', `抓取 ${PART_SPECS[this.partType].label}`);
      return;
    }

    if (!this.deps.isPartReady()) {
      this.setState('waiting', '等待来料');
      return;
    }

    const wrong = detections[0] ?? null;
    const reason: RejectReason =
      wrong && PART_TYPE_BY_MARKER[wrong.color] !== this.partType ? 'wrong-part' : 'ambiguous';
    this.recordReject(wrong, reason);
    this.deps.rejectPart();
    this.setState(
      'waiting',
      reason === 'wrong-part'
        ? `错料（期望 ${PART_SPECS[this.partType].label}），已退回`
        : '识别置信度不足，零件退回',
    );
  }

  private recordReject(detection: VisionDetection | null, reason: RejectReason): void {
    this.rejects.push({ detection, reason });
  }

  private finishRun(endedBlind: boolean): void {
    this.running = false;
    this.deps.onReport({
      station: this.station,
      partType: this.partType,
      partsPlaced: this.partsPlaced,
      rejects: [...this.rejects],
      endedBlind,
    });
    this.setState(endedBlind ? 'blind' : 'done', endedBlind ? '安全停机（视野丢失）' : '已停止');
  }

  private setState(state: StationState, status: string): void {
    this.state = state;
    this.deps.onState(state, status);
  }
}
