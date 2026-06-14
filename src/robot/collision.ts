import { Box3, Vector3 } from 'three';
import type { JointWaypoint } from '../types/robot';
import { lerpAngles } from '../utils/math';
import { computeVisualChainState } from './kinematics';
import { DEFAULT_JOINT_CONFIGS } from './limits';

export interface GroundClearanceReport {
  safe: boolean;
  minY: number;
  requiredMinY: number;
}

export const GROUND_Y = 0;
export const ROBOT_GROUND_CLEARANCE = 0.065;
export const TRAJECTORY_COLLISION_SAMPLES = 28;

/** Extra gap required between non-adjacent links so housings never visually interpenetrate. */
export const SELF_COLLISION_MARGIN = 0.012;
export const OBSTACLE_COLLISION_MARGIN = 0.012;
const OBSTACLE_RADIUS_SCALE = 0.55;
const GRIPPER_TRAJECTORY_RADIUS = 0.025;

export interface StaticObstacle {
  name: string;
  box: Box3;
}

export interface SelfCollisionReport {
  safe: boolean;
  /** Smallest (distance - combinedRadius) over all non-adjacent link pairs; <0 means overlap. */
  minClearance: number;
}

export interface ObstacleCollisionReport {
  safe: boolean;
  /** Smallest clearance from any arm capsule/joint sphere to any obstacle; <0 means overlap. */
  minClearance: number;
  obstacleName: string | null;
}

/** Squared minimum distance between two 3D segments [p1,q1] and [p2,q2]. */
function segmentDistanceSquared(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);

  let s: number;
  let t: number;
  const EPS = 1e-9;

  if (a <= EPS && e <= EPS) {
    return r.dot(r);
  }
  if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const closest1 = p1.clone().add(d1.multiplyScalar(s));
  const closest2 = p2.clone().add(d2.multiplyScalar(t));
  return closest1.sub(closest2).lengthSq();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distancePointToBox(point: Vector3, box: Box3): number {
  const dx = Math.max(box.min.x - point.x, 0, point.x - box.max.x);
  const dy = Math.max(box.min.y - point.y, 0, point.y - box.max.y);
  const dz = Math.max(box.min.z - point.z, 0, point.z - box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function segmentIntersectsBox(start: Vector3, end: Vector3, box: Box3): boolean {
  const direction = end.clone().sub(start);
  let tMin = 0;
  let tMax = 1;
  const EPS = 1e-9;

  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  for (const axis of axes) {
    const origin = start[axis];
    const delta = direction[axis];
    const min = box.min[axis];
    const max = box.max[axis];

    if (Math.abs(delta) < EPS) {
      if (origin < min || origin > max) {
        return false;
      }
      continue;
    }

    const inverse = 1 / delta;
    let t1 = (min - origin) * inverse;
    let t2 = (max - origin) * inverse;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return false;
    }
  }

  return true;
}

function segmentBoxClearance(
  start: Vector3,
  end: Vector3,
  box: Box3,
  radius: number,
  margin: number,
): number {
  const inflated = box.clone().expandByScalar(radius + margin);
  if (segmentIntersectsBox(start, end, inflated)) {
    return -1e-6;
  }

  const length = start.distanceTo(end);
  const samples = Math.max(2, Math.ceil(length / 0.025));
  let minClearance = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample <= samples; sample += 1) {
    const point = start.clone().lerp(end, sample / samples);
    minClearance = Math.min(minClearance, distancePointToBox(point, box) - radius - margin);
  }
  return minClearance;
}

/**
 * Reject configurations where the arm folds back on itself. Two complementary tests:
 *
 * 1. Non-adjacent joint housings (the round nodes) must not overlap — this is the case the
 *    user reported, where folding the elbow brings two spheres into the same volume.
 * 2. Non-adjacent link cylinders must not cross, using their real radii.
 *
 * Adjacent links/joints share a pivot and are intentionally close (especially the compact
 * wrist cluster), so only pairs at least two apart are tested.
 */
export function checkSelfCollision(
  jointAngles: number[],
  toolOffset = new Vector3(),
  margin = SELF_COLLISION_MARGIN,
): SelfCollisionReport {
  const chain = computeVisualChainState(jointAngles, toolOffset);
  const joints = chain.jointPositions;
  const points = [...joints, chain.endEffectorPosition];
  const segmentCount = points.length - 1;

  let minClearance = Number.POSITIVE_INFINITY;

  // 1. Round joint housings.
  for (let a = 0; a < joints.length; a += 1) {
    for (let b = a + 2; b < joints.length; b += 1) {
      const distance = joints[a].distanceTo(joints[b]);
      const combinedRadius =
        (DEFAULT_JOINT_CONFIGS[a]?.bodyRadius ?? 0) +
        (DEFAULT_JOINT_CONFIGS[b]?.bodyRadius ?? 0) +
        margin;
      minClearance = Math.min(minClearance, distance - combinedRadius);
    }
  }

  // 2. Link cylinders.
  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = i + 2; j < segmentCount; j += 1) {
      const distance = Math.sqrt(
        segmentDistanceSquared(points[i], points[i + 1], points[j], points[j + 1]),
      );
      const combinedRadius =
        (DEFAULT_JOINT_CONFIGS[i]?.linkRadius ?? 0) +
        (DEFAULT_JOINT_CONFIGS[j]?.linkRadius ?? 0) +
        margin;
      minClearance = Math.min(minClearance, distance - combinedRadius);
    }
  }

  return {
    safe: minClearance >= 0,
    minClearance: Number.isFinite(minClearance) ? minClearance : Number.POSITIVE_INFINITY,
  };
}

export function checkObstacleCollision(
  jointAngles: number[],
  obstacles: readonly StaticObstacle[],
  toolOffset = new Vector3(),
  margin = OBSTACLE_COLLISION_MARGIN,
): ObstacleCollisionReport {
  if (obstacles.length === 0) {
    return { safe: true, minClearance: Number.POSITIVE_INFINITY, obstacleName: null };
  }

  const chain = computeVisualChainState(jointAngles, toolOffset);
  const joints = chain.jointPositions;
  const points = [...joints, chain.endEffectorPosition];
  const segmentCount = points.length - 1;
  let minClearance = Number.POSITIVE_INFINITY;
  let obstacleName: string | null = null;

  for (const obstacle of obstacles) {
    for (let jointIndex = 0; jointIndex < joints.length; jointIndex += 1) {
      const radius = (DEFAULT_JOINT_CONFIGS[jointIndex]?.bodyRadius ?? 0) * OBSTACLE_RADIUS_SCALE;
      const clearance = distancePointToBox(joints[jointIndex], obstacle.box) - radius - margin;
      if (clearance < minClearance) {
        minClearance = clearance;
        obstacleName = obstacle.name;
      }
    }

    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const radius = (DEFAULT_JOINT_CONFIGS[segmentIndex]?.linkRadius ?? 0) * OBSTACLE_RADIUS_SCALE;
      const clearance = segmentBoxClearance(
        points[segmentIndex],
        points[segmentIndex + 1],
        obstacle.box,
        radius,
        margin,
      );
      if (clearance < minClearance) {
        minClearance = clearance;
        obstacleName = obstacle.name;
      }
    }
  }

  return {
    safe: minClearance >= 0,
    minClearance,
    obstacleName,
  };
}

export function checkTrajectoryObstacleCollision(
  waypoints: JointWaypoint[],
  obstacles: readonly StaticObstacle[],
  toolOffset = new Vector3(),
  margin = OBSTACLE_COLLISION_MARGIN,
): ObstacleCollisionReport {
  let minClearance = Number.POSITIVE_INFINITY;
  let obstacleName: string | null = null;

  if (obstacles.length === 0) {
    return { safe: true, minClearance, obstacleName };
  }

  for (let waypointIndex = 0; waypointIndex < waypoints.length - 1; waypointIndex += 1) {
    const start = waypoints[waypointIndex];
    const end = waypoints[waypointIndex + 1];
    for (let sample = 0; sample <= TRAJECTORY_COLLISION_SAMPLES; sample += 1) {
      const t = sample / TRAJECTORY_COLLISION_SAMPLES;
      const jointAngles = lerpAngles(start.jointAngles, end.jointAngles, t);
      const gripperPosition = computeVisualChainState(jointAngles, toolOffset).endEffectorPosition;

      for (const obstacle of obstacles) {
        const clearance =
          distancePointToBox(gripperPosition, obstacle.box) - GRIPPER_TRAJECTORY_RADIUS - margin;
        if (clearance < minClearance) {
          minClearance = clearance;
          obstacleName = obstacle.name;
        }
      }
      if (minClearance < 0) {
        return { safe: false, minClearance, obstacleName };
      }
    }
  }

  return { safe: true, minClearance, obstacleName };
}

export function checkTrajectorySelfCollision(
  waypoints: JointWaypoint[],
  toolOffset = new Vector3(),
  margin = SELF_COLLISION_MARGIN,
): SelfCollisionReport {
  let minClearance = Number.POSITIVE_INFINITY;

  for (let waypointIndex = 0; waypointIndex < waypoints.length - 1; waypointIndex += 1) {
    const start = waypoints[waypointIndex];
    const end = waypoints[waypointIndex + 1];
    for (let sample = 0; sample <= TRAJECTORY_COLLISION_SAMPLES; sample += 1) {
      const t = sample / TRAJECTORY_COLLISION_SAMPLES;
      const jointAngles = lerpAngles(start.jointAngles, end.jointAngles, t);
      const report = checkSelfCollision(jointAngles, toolOffset, margin);
      minClearance = Math.min(minClearance, report.minClearance);
      if (!report.safe) {
        return { safe: false, minClearance };
      }
    }
  }

  return { safe: true, minClearance };
}

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
