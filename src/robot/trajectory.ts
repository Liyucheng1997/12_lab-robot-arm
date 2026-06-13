import type { RobotArm } from './RobotArm';
import type { JointWaypoint } from '../types/robot';
import { lerpAngles } from '../utils/math';
import { HOME_POSE, ZERO_POSE } from './limits';

export type TrajectorySampleHandler = (jointAngles: number[], elapsed: number) => void;
export type TrajectoryCompleteHandler = () => void;

export class JointTrajectoryPlayer {
  private waypoints: JointWaypoint[] = [];
  private elapsed = 0;
  private playing = false;

  constructor(
    private readonly robot: RobotArm,
    private readonly onSample?: TrajectorySampleHandler,
    private readonly onComplete?: TrajectoryCompleteHandler,
  ) {}

  setWaypoints(waypoints: JointWaypoint[]): void {
    this.waypoints = [...waypoints].sort((a, b) => a.time - b.time);
    this.elapsed = 0;
  }

  play(): void {
    if (this.waypoints.length < 2) {
      return;
    }
    this.elapsed = 0;
    this.playing = true;
  }

  stop(): void {
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  update(deltaSeconds: number): void {
    if (!this.playing || this.waypoints.length < 2) {
      return;
    }

    this.elapsed += deltaSeconds;
    const last = this.waypoints[this.waypoints.length - 1];
    if (this.elapsed >= last.time) {
      this.robot.setJointAngles(last.jointAngles);
      this.onSample?.(last.jointAngles, last.time);
      this.playing = false;
      this.onComplete?.();
      return;
    }

    const nextIndex = this.waypoints.findIndex((waypoint) => waypoint.time >= this.elapsed);
    const next = this.waypoints[nextIndex];
    const previous = this.waypoints[Math.max(0, nextIndex - 1)];
    const segmentDuration = Math.max(next.time - previous.time, 0.001);
    const t = (this.elapsed - previous.time) / segmentDuration;
    const jointAngles = lerpAngles(previous.jointAngles, next.jointAngles, t);
    this.robot.setJointAngles(jointAngles);
    this.onSample?.(jointAngles, this.elapsed);
  }
}

export function createDefaultTrajectory(currentAngles: number[]): JointWaypoint[] {
  return [
    { time: 0, jointAngles: currentAngles },
    { time: 1.6, jointAngles: HOME_POSE },
    { time: 3.2, jointAngles: [0.55, -0.7, 1.25, 0.6, 0.3, -0.9] },
    { time: 4.8, jointAngles: [-0.55, -0.45, 0.95, -0.5, 0.6, 0.9] },
    { time: 6.2, jointAngles: ZERO_POSE },
  ];
}
