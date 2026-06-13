import { Matrix4, Quaternion, Vector3 } from 'three';
import type { IKOptions, IKResult, Pose } from '../types/robot';
import { clamp, matrixToPose, vectorFromTuple } from '../utils/math';
import { createDHMatrix, DEFAULT_DH_PARAMETERS } from './dh';
import { DEFAULT_JOINT_CONFIGS, ROBOT_BASE_OFFSET } from './limits';

export function forwardKinematics(jointAngles: number[]): Pose {
  const chain = computeVisualChainState(jointAngles);
  return {
    position: chain.endEffectorPosition,
    orientation: chain.endEffectorOrientation,
    transform: chain.transform,
  };
}

export function forwardKinematicsDH(jointAngles: number[]): Pose {
  const transform = DEFAULT_DH_PARAMETERS.reduce((matrix, parameter, index) => {
    return matrix.multiply(createDHMatrix(parameter, jointAngles[index] ?? 0));
  }, new Matrix4());

  return matrixToPose(transform);
}

interface ChainState {
  jointPositions: Vector3[];
  jointAxesWorld: Vector3[];
  endEffectorPosition: Vector3;
  endEffectorOrientation: Quaternion;
  transform: Matrix4;
}

export function computeVisualChainState(jointAngles: number[], toolOffset = new Vector3()): ChainState {
  const matrix = new Matrix4().makeTranslation(...ROBOT_BASE_OFFSET);
  const jointPositions: Vector3[] = [];
  const jointAxesWorld: Vector3[] = [];

  DEFAULT_JOINT_CONFIGS.forEach((joint, index) => {
    const jointPosition = new Vector3().setFromMatrixPosition(matrix);
    const parentOrientation = new Quaternion().setFromRotationMatrix(matrix);
    const axisWorld = vectorFromTuple(joint.axis).applyQuaternion(parentOrientation).normalize();
    jointPositions.push(jointPosition);
    jointAxesWorld.push(axisWorld);

    const rotation = new Matrix4().makeRotationAxis(vectorFromTuple(joint.axis), jointAngles[index] ?? 0);
    const translation = new Matrix4().makeTranslation(...joint.offsetToNext);
    matrix.multiply(rotation).multiply(translation);
  });

  const toolTransform = matrix.clone().multiply(
    new Matrix4().makeTranslation(toolOffset.x, toolOffset.y, toolOffset.z),
  );
  const endEffectorPosition = new Vector3().setFromMatrixPosition(toolTransform);
  const endEffectorOrientation = new Quaternion().setFromRotationMatrix(matrix);

  return {
    jointPositions,
    jointAxesWorld,
    endEffectorPosition,
    endEffectorOrientation,
    transform: toolTransform.clone(),
  };
}

export function solveIK(
  targetPose: Pick<Pose, 'position'>,
  currentJointAngles: number[],
  options: Partial<IKOptions> = {},
): IKResult {
  const config: IKOptions = {
    maxIterations: options.maxIterations ?? 80,
    threshold: options.threshold ?? 0.015,
    gain: options.gain ?? 0.72,
    toolOffset: options.toolOffset,
  };

  const jointAngles = [...currentJointAngles];
  let error = Number.POSITIVE_INFINITY;

  // TODO: Replace CCD with damped least-squares Jacobian IK for orientation-constrained tasks.
  for (let iteration = 0; iteration < config.maxIterations; iteration += 1) {
    let chain = computeVisualChainState(jointAngles, config.toolOffset);
    error = chain.endEffectorPosition.distanceTo(targetPose.position);
    if (error <= config.threshold) {
      return { success: true, jointAngles, error, iterations: iteration };
    }

    for (let jointIndex = jointAngles.length - 1; jointIndex >= 0; jointIndex -= 1) {
      chain = computeVisualChainState(jointAngles, config.toolOffset);
      const jointPosition = chain.jointPositions[jointIndex];
      const axis = chain.jointAxesWorld[jointIndex];
      const toEnd = chain.endEffectorPosition.clone().sub(jointPosition);
      const toTarget = targetPose.position.clone().sub(jointPosition);

      const projectedEnd = toEnd.sub(axis.clone().multiplyScalar(toEnd.dot(axis)));
      const projectedTarget = toTarget.sub(axis.clone().multiplyScalar(toTarget.dot(axis)));
      if (projectedEnd.lengthSq() < 1e-8 || projectedTarget.lengthSq() < 1e-8) {
        continue;
      }

      projectedEnd.normalize();
      projectedTarget.normalize();
      const signedDelta = Math.atan2(
        axis.dot(projectedEnd.clone().cross(projectedTarget)),
        clamp(projectedEnd.dot(projectedTarget), -1, 1),
      );
      const limit = DEFAULT_JOINT_CONFIGS[jointIndex].limit;
      jointAngles[jointIndex] = clamp(
        jointAngles[jointIndex] + signedDelta * config.gain,
        limit.min,
        limit.max,
      );
    }
  }

  const finalState = computeVisualChainState(jointAngles, config.toolOffset);
  error = finalState.endEffectorPosition.distanceTo(targetPose.position);
  return {
    success: error <= config.threshold,
    jointAngles,
    error,
    iterations: config.maxIterations,
  };
}
