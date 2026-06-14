import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  checkGroundClearance,
  checkObstacleCollision,
  checkSelfCollision,
  checkTrajectoryGroundClearance,
  checkTrajectoryObstacleCollision,
} from '../../src/robot/collision';
import { solveIK } from '../../src/robot/kinematics';
import { GRIPPER_GRASP_OFFSET, HOME_POSE, ZERO_POSE } from '../../src/robot/limits';
import { SortingStation, type SortPlanTarget } from '../../src/sorting/SortingStation';
import type { IKResult, JointWaypoint } from '../../src/types/robot';
import { vectorFromTuple } from '../../src/utils/math';

const TOOL = vectorFromTuple(GRIPPER_GRASP_OFFSET);
const SAFE_HOME_TIME_SECONDS = 1.25;

function solveStationSafeIK(
  station: SortingStation,
  targetPosition: Vector3,
  currentAngles: number[],
  threshold: number,
): IKResult | null {
  const obstacles = station.getBinObstacles();
  const seeds = createSeeds(currentAngles, targetPosition);
  let best: IKResult | null = null;

  seeds.forEach((seed) => {
    const result = solveIK({ position: targetPosition }, seed, {
      maxIterations: 220,
      threshold,
      gain: 0.74,
      toolOffset: TOOL,
    });
    if (!checkGroundClearance(result.jointAngles, TOOL).safe) {
      return;
    }
    if (!checkSelfCollision(result.jointAngles, TOOL).safe) {
      return;
    }
    if (!checkObstacleCollision(result.jointAngles, obstacles, TOOL).safe) {
      return;
    }
    if (!best || result.error < best.error) {
      best = result;
    }
  });

  return best;
}

function findPlanFailure(station: SortingStation, target: SortPlanTarget): string | null {
  const pickTransit = solveStationSafeIK(station, target.pickTransitPosition, HOME_POSE, 0.025);
  if (!pickTransit || (!pickTransit.success && pickTransit.error > 0.08)) {
    return 'pick-transit';
  }

  const prePick = solveStationSafeIK(
    station,
    target.prePickPosition,
    pickTransit.jointAngles,
    0.02,
  );
  if (!prePick || (!prePick.success && prePick.error > 0.08)) {
    return 'pre-pick';
  }

  const pick = solveStationSafeIK(station, target.pickPosition, prePick.jointAngles, 0.014);
  if (!pick || (!pick.success && pick.error > 0.05)) {
    return 'pick';
  }

  const lift = solveStationSafeIK(station, target.liftPosition, pick.jointAngles, 0.02);
  if (!lift || (!lift.success && lift.error > 0.08)) {
    return 'lift';
  }

  const placeTransit = solveStationSafeIK(
    station,
    target.placeTransitPosition,
    lift.jointAngles,
    0.025,
  );
  if (!placeTransit || (!placeTransit.success && placeTransit.error > 0.08)) {
    return 'place-transit';
  }

  const drop = solveStationSafeIK(
    station,
    target.dropPosition,
    placeTransit.jointAngles,
    0.025,
  );
  if (!drop || (!drop.success && drop.error > 0.1)) {
    return 'drop';
  }

  const pickWaypoints = findSafeRoute(
    station,
    [
      { time: 0, jointAngles: HOME_POSE },
      { time: 1.3, jointAngles: pickTransit.jointAngles },
      { time: 2.3, jointAngles: prePick.jointAngles },
      { time: 3, jointAngles: pick.jointAngles },
    ],
  );
  const placeWaypoints = findSafeRoute(
    station,
    [
      { time: 0, jointAngles: pick.jointAngles },
      { time: 1.1, jointAngles: lift.jointAngles },
      { time: 2.7, jointAngles: placeTransit.jointAngles },
      { time: 4, jointAngles: drop.jointAngles },
    ],
  );

  const pickFailure = trajectoryFailure(station, pickWaypoints);
  if (pickFailure) {
    return `pick-${pickFailure}`;
  }
  const placeFailure = trajectoryFailure(station, placeWaypoints);
  return placeFailure ? `place-${placeFailure}` : null;
}

function findSafeRoute(station: SortingStation, waypoints: JointWaypoint[]): JointWaypoint[] {
  if (isTrajectorySafe(station, waypoints)) {
    return waypoints;
  }

  const start = waypoints[0];
  const end = waypoints.at(-1) ?? start;
  for (const candidate of createRouteCandidates(start.jointAngles, end.jointAngles)) {
    const routed = addRouteWaypoint(waypoints, candidate);
    if (isTrajectorySafe(station, routed)) {
      return routed;
    }
  }

  return waypoints;
}

function createRouteCandidates(startAngles: number[], endAngles: number[]): number[][] {
  const yaws = uniqueRounded([startAngles[0] ?? 0, endAngles[0] ?? 0, 0, HOME_POSE[0]]);
  const postures = [
    [HOME_POSE[1], HOME_POSE[2], HOME_POSE[3], HOME_POSE[4], HOME_POSE[5]],
    [ZERO_POSE[1], ZERO_POSE[2], ZERO_POSE[3], ZERO_POSE[4], ZERO_POSE[5]],
    [-0.45, 0.95, 0, 0.45, 0],
    [-0.65, 1.2, 0, 0.55, 0],
    [-0.85, 1.45, 0, 0.7, 0],
    [-1.05, 1.7, 0, 0.82, 0],
    [-1.2, 1.95, 0, 0.95, 0],
  ];
  return yaws.flatMap((yaw) => postures.map((posture) => [yaw, ...posture]));
}

function addRouteWaypoint(waypoints: JointWaypoint[], jointAngles: number[]): JointWaypoint[] {
  const start = waypoints[0];
  return [
    start,
    { time: SAFE_HOME_TIME_SECONDS, jointAngles },
    ...waypoints.slice(1).map((waypoint) => ({
      time: waypoint.time + SAFE_HOME_TIME_SECONDS,
      jointAngles: waypoint.jointAngles,
    })),
  ];
}

function isTrajectorySafe(station: SortingStation, waypoints: JointWaypoint[]): boolean {
  return trajectoryFailure(station, waypoints) === null;
}

function trajectoryFailure(station: SortingStation, waypoints: JointWaypoint[]): string | null {
  if (!checkTrajectoryGroundClearance(waypoints, TOOL).safe) {
    return 'ground';
  }
  if (!checkTrajectoryObstacleCollision(waypoints, station.getBinObstacles(), TOOL).safe) {
    return 'obstacle';
  }
  return null;
}

function createSeeds(currentAngles: number[], targetPosition: Vector3): number[][] {
  const targetYaw = Math.atan2(-targetPosition.z, targetPosition.x);
  const yawCandidates = uniqueRounded([
    currentAngles[0] ?? 0,
    targetYaw,
    targetYaw - 0.35,
    targetYaw + 0.35,
    targetYaw - 0.7,
    targetYaw + 0.7,
    HOME_POSE[0],
    ZERO_POSE[0],
  ]);
  const postureCandidates = [
    [currentAngles[1] ?? 0, currentAngles[2] ?? 0, currentAngles[3] ?? 0, currentAngles[4] ?? 0, currentAngles[5] ?? 0],
    [HOME_POSE[1], HOME_POSE[2], HOME_POSE[3], HOME_POSE[4], HOME_POSE[5]],
    [ZERO_POSE[1], ZERO_POSE[2], ZERO_POSE[3], ZERO_POSE[4], ZERO_POSE[5]],
    [-0.45, 0.95, 0, 0.45, 0],
    [-0.65, 1.2, 0, 0.55, 0],
    [-0.85, 1.45, 0, 0.65, 0],
    [-1.05, 1.7, 0, 0.82, 0],
    [-1.2, 1.95, 0, 0.95, 0],
  ];

  const seeds: number[][] = [[...currentAngles], [...HOME_POSE], [...ZERO_POSE]];
  yawCandidates.forEach((yaw) => {
    postureCandidates.forEach((posture) => {
      seeds.push([yaw, posture[0], posture[1], posture[2], posture[3], posture[4]]);
    });
  });
  return [...new Map(seeds.map((seed) => [seed.map((value) => value.toFixed(3)).join(','), seed])).values()];
}

function uniqueRounded(values: number[]): number[] {
  return [...new Map(values.map((value) => [value.toFixed(3), value])).values()];
}

describe('sorting station reachability', () => {
  it('can plan a collision-safe pick and place for every initial ball', () => {
    const station = new SortingStation();
    const unreachable = station
      .getBalls()
      .map((ball) => station.createPlanTarget(ball))
      .map((target) => ({
        id: target.ball.id,
        reason: findPlanFailure(station, target),
      }))
      .filter((failure) => failure.reason);

    expect(unreachable).toEqual([]);
  });

  it('can plan a collision-safe pick and place after the balls settle', () => {
    const station = new SortingStation();
    for (let step = 0; step < 300; step += 1) {
      station.update(1 / 60);
    }

    const unreachable = station
      .getBalls()
      .map((ball) => station.createPlanTarget(ball))
      .map((target) => ({
        id: target.ball.id,
        reason: findPlanFailure(station, target),
      }))
      .filter((failure) => failure.reason);

    expect(unreachable).toEqual([]);
  });
});
