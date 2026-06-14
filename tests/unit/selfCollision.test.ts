import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import {
  checkObstacleCollision,
  checkSelfCollision,
  checkTrajectoryObstacleCollision,
} from '../../src/robot/collision';
import { HOME_POSE, ROBOT_BASE_OFFSET, ZERO_POSE } from '../../src/robot/limits';
import { degToRad } from '../../src/utils/math';

const TOOL = new Vector3(0.43, 0, 0);

describe('checkSelfCollision', () => {
  it('accepts the home and zero poses', () => {
    expect(checkSelfCollision(HOME_POSE, TOOL).safe).toBe(true);
    expect(checkSelfCollision(ZERO_POSE, TOOL).safe).toBe(true);
  });

  it('accepts a normal reach-into-bin posture', () => {
    const reach = [0, degToRad(-45), degToRad(70), 0, degToRad(40), 0];
    expect(checkSelfCollision(reach, TOOL).safe).toBe(true);
  });

  it('rejects an over-folded shoulder that brings the joint housings together', () => {
    // Shoulder slammed down so the forearm/wrist swings back into the base column.
    const folded = [0, degToRad(-90), degToRad(0), 0, degToRad(30), 0];
    const report = checkSelfCollision(folded, TOOL);
    expect(report.safe).toBe(false);
    expect(report.minClearance).toBeLessThan(0);
  });

  it('keeps adjacent wrist housings (J5,J6) from overlapping by construction', () => {
    // The original bug: J5->J6 link (0.20) was shorter than two 0.105 housings (0.21).
    // With tapered radii the straight-wrist pose is collision-free.
    expect(checkSelfCollision([0, 0, 0, 0, 0, 0], TOOL).safe).toBe(true);
  });
});

describe('checkObstacleCollision', () => {
  it('rejects an arm link passing through a static box obstacle', () => {
    const obstacle = {
      name: 'test bin wall',
      box: new Box3().setFromCenterAndSize(
        new Vector3(ROBOT_BASE_OFFSET[0], 0.6, ROBOT_BASE_OFFSET[2]),
        new Vector3(0.28, 0.28, 0.28),
      ),
    };

    const report = checkObstacleCollision(ZERO_POSE, [obstacle], TOOL);

    expect(report.safe).toBe(false);
    expect(report.obstacleName).toBe('test bin wall');
    expect(report.minClearance).toBeLessThan(0);
  });

  it('accepts obstacle-free poses and trajectories', () => {
    const obstacle = {
      name: 'far box',
      box: new Box3().setFromCenterAndSize(new Vector3(5, 5, 5), new Vector3(0.2, 0.2, 0.2)),
    };
    const waypoints = [
      { time: 0, jointAngles: HOME_POSE },
      { time: 1, jointAngles: ZERO_POSE },
    ];

    expect(checkObstacleCollision(HOME_POSE, [obstacle], TOOL).safe).toBe(true);
    expect(checkTrajectoryObstacleCollision(waypoints, [obstacle], TOOL).safe).toBe(true);
  });
});
