import { Vector3 } from 'three';
import type { JointWaypoint } from '../types/robot';
import { lerpAngles } from '../utils/math';
import { computeVisualChainState } from './kinematics';

export interface GroundClearanceReport {
  safe: boolean;
  minY: number;
  requiredMinY: number;
}

export const GROUND_Y = 0;
export const ROBOT_GROUND_CLEARANCE = 0.065;
export const TRAJECTORY_COLLISION_SAMPLES = 28;

export function checkGroundClearance(
  jointAngles: number[],
  toolOffset = new Vector3(),
  requiredMinY = GROUND_Y + ROBOT_GROUND_CLEARANCE,
): GroundClearanceReport {
  const chain = computeVisualChainState(jointAngles, toolOffset);
  const points = [...chain.jointPositions, chain.endEffectorPosition];
  const minY = Math.min(...points.map((point) => point.y));
  return {
    safe: minY >= requiredMinY,
    minY,
    requiredMinY,
  };
}

export function checkTrajectoryGroundClearance(
  waypoints: JointWaypoint[],
  toolOffset = new Vector3(),
  requiredMinY = GROUND_Y + ROBOT_GROUND_CLEARANCE,
): GroundClearanceReport {
  let minY = Number.POSITIVE_INFINITY;

  for (let waypointIndex = 0; waypointIndex < waypoints.length - 1; waypointIndex += 1) {
    const start = waypoints[waypointIndex];
    const end = waypoints[waypointIndex + 1];
    for (let sample = 0; sample <= TRAJECTORY_COLLISION_SAMPLES; sample += 1) {
      const t = sample / TRAJECTORY_COLLISION_SAMPLES;
      const jointAngles = lerpAngles(start.jointAngles, end.jointAngles, t);
      const report = checkGroundClearance(jointAngles, toolOffset, requiredMinY);
      minY = Math.min(minY, report.minY);
      if (!report.safe) {
        return {
          safe: false,
          minY,
          requiredMinY,
        };
      }
    }
  }

  return {
    safe: true,
    minY,
    requiredMinY,
  };
}
