import { Matrix4, Quaternion, Vector3 } from 'three';

export const TAU = Math.PI * 2;

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

export function lerpAngles(startAngles: number[], endAngles: number[], t: number): number[] {
  return startAngles.map((angle, index) => lerp(angle, endAngles[index] ?? angle, t));
}

export function vectorFromTuple(tuple: [number, number, number]): Vector3 {
  return new Vector3(tuple[0], tuple[1], tuple[2]);
}

export function matrixToPose(transform: Matrix4) {
  const position = new Vector3();
  const orientation = new Quaternion();
  const scale = new Vector3();
  transform.decompose(position, orientation, scale);
  return { position, orientation, transform: transform.clone() };
}

export function formatVector(vector: Vector3, precision = 3): string {
  return `${vector.x.toFixed(precision)}, ${vector.y.toFixed(precision)}, ${vector.z.toFixed(
    precision,
  )}`;
}
