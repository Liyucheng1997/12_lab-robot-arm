import { degToRad } from '../utils/math';
import type { JointLimit, JointRuntimeConfig } from '../types/robot';

export const DEFAULT_JOINT_LIMITS: JointLimit[] = [
  { min: degToRad(-180), max: degToRad(180), velocity: degToRad(120) },
  { min: degToRad(-120), max: degToRad(120), velocity: degToRad(90) },
  { min: degToRad(-150), max: degToRad(150), velocity: degToRad(100) },
  { min: degToRad(-180), max: degToRad(180), velocity: degToRad(180) },
  { min: degToRad(-120), max: degToRad(120), velocity: degToRad(160) },
  { min: degToRad(-360), max: degToRad(360), velocity: degToRad(220) },
];

export const HOME_POSE = [
  degToRad(0),
  degToRad(-28),
  degToRad(62),
  degToRad(0),
  degToRad(34),
  degToRad(0),
];

export const ZERO_POSE = [0, 0, 0, 0, 0, 0];

export const ROBOT_BASE_OFFSET: [number, number, number] = [0, 0.18, 0];

export const TOOL_OFFSET: [number, number, number] = [0.28, 0, 0];

export const GRIPPER_GRASP_OFFSET: [number, number, number] = [0.43, 0, 0];

export const DEFAULT_JOINT_CONFIGS: JointRuntimeConfig[] = [
  {
    name: 'J1 base yaw',
    axis: [0, 1, 0],
    offsetToNext: [0, 0.72, 0],
    limit: DEFAULT_JOINT_LIMITS[0],
    linkRadius: 0.16,
    linkColor: 0x5f6b7a,
  },
  {
    name: 'J2 shoulder pitch',
    axis: [0, 0, 1],
    offsetToNext: [0.92, 0, 0],
    limit: DEFAULT_JOINT_LIMITS[1],
    linkRadius: 0.12,
    linkColor: 0xd2dde9,
  },
  {
    name: 'J3 elbow pitch',
    axis: [0, 0, 1],
    offsetToNext: [0.72, 0, 0],
    limit: DEFAULT_JOINT_LIMITS[2],
    linkRadius: 0.1,
    linkColor: 0xb9c7d7,
  },
  {
    name: 'J4 wrist roll',
    axis: [1, 0, 0],
    offsetToNext: [0.28, 0, 0],
    limit: DEFAULT_JOINT_LIMITS[3],
    linkRadius: 0.075,
    linkColor: 0x8797aa,
  },
  {
    name: 'J5 wrist pitch',
    axis: [0, 0, 1],
    offsetToNext: [0.2, 0, 0],
    limit: DEFAULT_JOINT_LIMITS[4],
    linkRadius: 0.06,
    linkColor: 0xaebdcd,
  },
  {
    name: 'J6 wrist yaw',
    axis: [0, 1, 0],
    offsetToNext: TOOL_OFFSET,
    limit: DEFAULT_JOINT_LIMITS[5],
    linkRadius: 0.045,
    linkColor: 0x95a5b7,
  },
];
