import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import {
  checkGroundClearance,
  checkObstacleCollision,
  checkSelfCollision,
  checkTrajectoryGroundClearance,
  checkTrajectoryObstacleCollision,
  type StaticObstacle,
} from '../../src/robot/collision';
import { solveIK } from '../../src/robot/kinematics';
import { GRIPPER_GRASP_OFFSET, HOME_POSE, ZERO_POSE } from '../../src/robot/limits';
import {
  ASSEMBLY_SEQUENCE,
  STATION_COUNT,
  createAssemblyPlanTarget,
  obstaclesForStation,
  type AssemblyPlanTarget,
} from '../../src/assembly/layout';
import type { IKResult, JointWaypoint } from '../../src/types/robot';
import { vectorFromTuple } from '../../src/utils/math';

const TOOL = vectorFromTuple(GRIPPER_GRASP_OFFSET);
const SAFE_HOME_TIME_SECONDS = 1.25;
/** Set per test case: the local-frame obstacle set of the station under test. */
let OBSTACLES: StaticObstacle[] = [];

function solveCellSafeIK(
  targetPosition: Vector3,
  currentAngles: number[],
  threshold: number,
): IKResult | null {
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
    if (!checkObstacleCollision(result.jointAngles, OBSTACLES, TOOL).safe) {
      return;
    }
    if (!best || result.error < best.error) {
      best = result;
    }
  });

  return best;
}

function findPlanFailure(target: AssemblyPlanTarget): string | null {
  const pickTransit = solveCellSafeIK(target.pickTransitPosition, HOME_POSE, 0.025);
  if (!pickTransit || (!pickTransit.success && pickTransit.error > 0.08)) {
    return 'pick-transit';
  }

  const prePick = solveCellSafeIK(target.prePickPosition, pickTransit.jointAngles, 0.02);
  if (!prePick || (!prePick.success && prePick.error > 0.08)) {
    return 'pre-pick';
  }

  const pick = solveCellSafeIK(target.pickPosition, prePick.jointAngles, 0.014);
  if (!pick || (!pick.success && pick.error > 0.05)) {
    return 'pick';
  }

  const lift = solveCellSafeIK(target.liftPosition, pick.jointAngles, 0.02);
  if (!lift || (!lift.success && lift.error > 0.08)) {
    return 'lift';
  }

  const placeTransit = solveCellSafeIK(target.placeTransitPosition, lift.jointAngles, 0.025);
  if (!placeTransit || (!placeTransit.success && placeTransit.error > 0.08)) {
    return 'place-transit';
  }

  const drop = solveCellSafeIK(target.dropPosition, placeTransit.jointAngles, 0.025);
  if (!drop || (!drop.success && drop.error > 0.1)) {
    return 'drop';
  }

  const pickWaypoints = findSafeRoute([
    { time: 0, jointAngles: HOME_POSE },
    { time: 1.3, jointAngles: pickTransit.jointAngles },
    { time: 2.3, jointAngles: prePick.jointAngles },
    { time: 3, jointAngles: pick.jointAngles },
  ]);
  const placeWaypoints = findSafeRoute([
    { time: 0, jointAngles: pick.jointAngles },
    { time: 1.1, jointAngles: lift.jointAngles },
    { time: 2.7, jointAngles: placeTransit.jointAngles },
    { time: 4, jointAngles: drop.jointAngles },
  ]);

  const pickFailure = trajectoryFailure(pickWaypoints);
  if (pickFailure) {
    return `pick-${pickFailure}`;
  }
  const placeFailure = trajectoryFailure(placeWaypoints);
  return placeFailure ? `place-${placeFailure}` : null;
}

function findSafeRoute(waypoints: JointWaypoint[]): JointWaypoint[] {
  if (trajectoryFailure(waypoints) === null) {
    return waypoints;
  }

  const start = waypoints[0];
  const end = waypoints.at(-1) ?? start;
  for (const candidate of createRouteCandidates(start.jointAngles, end.jointAngles)) {
    const routed = addRouteWaypoint(waypoints, candidate);
    if (trajectoryFailure(routed) === null) {
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

function trajectoryFailure(waypoints: JointWaypoint[]): string | null {
  const ground = checkTrajectoryGroundClearance(waypoints, TOOL);
  if (!ground.safe) {
    return `ground(minY=${ground.minY.toFixed(3)})`;
  }
  const obstacle = checkTrajectoryObstacleCollision(waypoints, OBSTACLES, TOOL);
  if (!obstacle.safe) {
    return `obstacle:${obstacle.obstacleName}(clearance=${obstacle.minClearance.toFixed(3)})`;
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

describe('assembly line reachability', () => {
  // Each station reuses the same LOCAL pick/place geometry, but its obstacle
  // set differs (neighbor stations, robot columns, the main line), so every
  // station is verified against its own translated obstacle field.
  for (let station = 0; station < STATION_COUNT; station += 1) {
    const type = ASSEMBLY_SEQUENCE[station];
    it(`station ${station + 1} can pick ${type} and place it collision-free`, () => {
      OBSTACLES = obstaclesForStation(station);
      const reason = findPlanFailure(createAssemblyPlanTarget(type));
      expect(reason).toBeNull();
    });
  }

  it('keeps the drop points above every obstacle in their footprint', () => {
    for (let station = 0; station < STATION_COUNT; station += 1) {
      const target = createAssemblyPlanTarget(ASSEMBLY_SEQUENCE[station]);
      obstaclesForStation(station).forEach((obstacle: StaticObstacle) => {
        const { box } = obstacle;
        const inFootprint =
          target.dropPosition.x >= box.min.x - 0.02 &&
          target.dropPosition.x <= box.max.x + 0.02 &&
          target.dropPosition.z >= box.min.z - 0.02 &&
          target.dropPosition.z <= box.max.z + 0.02;
        if (inFootprint) {
          expect(target.dropPosition.y).toBeGreaterThan(box.max.y);
        }
      });
    }
  });
});
