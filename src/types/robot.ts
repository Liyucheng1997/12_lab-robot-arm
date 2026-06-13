import type { Matrix4, Quaternion, Vector3 } from 'three';

export type JointType = 'revolute' | 'fixed';

export interface JointLimit {
  min: number;
  max: number;
  velocity?: number;
  effort?: number;
}

export interface JointDescription {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  axis: [number, number, number];
  origin?: {
    xyz: [number, number, number];
    rpy: [number, number, number];
  };
  limit?: JointLimit;
}

export interface LinkDescription {
  name: string;
  visualMeshUrl?: string;
  collisionMeshUrl?: string;
  inertial?: {
    mass: number;
    centerOfMass: [number, number, number];
  };
}

export interface RobotDescription {
  name: string;
  links: LinkDescription[];
  joints: JointDescription[];
}

export interface JointRuntimeConfig {
  name: string;
  axis: [number, number, number];
  offsetToNext: [number, number, number];
  limit: JointLimit;
  linkRadius: number;
  linkColor: number;
}

export interface DHPreset {
  name: string;
  parameters: DHParameter[];
}

export interface DHParameter {
  /**
   * a: link length, distance from z_i to z_{i+1} along x_i.
   */
  a: number;
  /**
   * alpha: link twist, rotation from z_i to z_{i+1} around x_i.
   */
  alpha: number;
  /**
   * d: link offset, distance from x_{i-1} to x_i along z_i.
   */
  d: number;
  /**
   * theta: static joint angle offset. Runtime joint angle is added for revolute joints.
   */
  theta: number;
}

export interface Pose {
  position: Vector3;
  orientation: Quaternion;
  transform: Matrix4;
}

export interface IKOptions {
  maxIterations: number;
  threshold: number;
  gain: number;
  toolOffset?: Vector3;
}

export interface IKResult {
  success: boolean;
  jointAngles: number[];
  error: number;
  iterations: number;
}

export interface JointWaypoint {
  jointAngles: number[];
  time: number;
}
