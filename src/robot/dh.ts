import { Matrix4 } from 'three';
import type { DHParameter, DHPreset } from '../types/robot';

/**
 * Default modified industrial 6-DOF arm dimensions in meters.
 *
 * DH meanings:
 * - a: link length, distance between adjacent joint axes along the current x axis.
 * - alpha: link twist, angular offset between adjacent joint axes around the current x axis.
 * - d: link offset, distance between adjacent x axes along the current z axis.
 * - theta: fixed joint angle offset. The runtime revolute joint angle is added to this value.
 */
export const DEFAULT_DH_PARAMETERS: DHParameter[] = [
  { a: 0, alpha: Math.PI / 2, d: 0.9, theta: 0 },
  { a: 0.92, alpha: 0, d: 0, theta: -Math.PI / 2 },
  { a: 0.72, alpha: 0, d: 0, theta: 0 },
  { a: 0, alpha: Math.PI / 2, d: 0.28, theta: 0 },
  { a: 0, alpha: -Math.PI / 2, d: 0, theta: 0 },
  { a: 0, alpha: 0, d: 0.28, theta: 0 },
];

export const DEFAULT_DH_PRESET: DHPreset = {
  name: 'Generic industrial 6-DOF arm',
  parameters: DEFAULT_DH_PARAMETERS,
};

export function createDHMatrix(parameter: DHParameter, jointAngle = 0): Matrix4 {
  const theta = parameter.theta + jointAngle;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const cosAlpha = Math.cos(parameter.alpha);
  const sinAlpha = Math.sin(parameter.alpha);

  return new Matrix4().set(
    cosTheta,
    -sinTheta * cosAlpha,
    sinTheta * sinAlpha,
    parameter.a * cosTheta,
    sinTheta,
    cosTheta * cosAlpha,
    -cosTheta * sinAlpha,
    parameter.a * sinTheta,
    0,
    sinAlpha,
    cosAlpha,
    parameter.d,
    0,
    0,
    0,
    1,
  );
}
