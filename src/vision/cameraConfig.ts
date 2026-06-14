import { Vector3 } from 'three';

export const VISION_CAMERA_FOV = 50;
export const VISION_CAMERA_POSITION = new Vector3(3.25, 2.05, 0.38);
export const VISION_CAMERA_TARGET = new Vector3(1.2, 0.2, 0);

export function configureStationVisionCamera(camera: {
  fov: number;
  position: Vector3;
  lookAt(target: Vector3): void;
  updateMatrixWorld(force?: boolean): void;
  updateProjectionMatrix(): void;
}): void {
  camera.fov = VISION_CAMERA_FOV;
  camera.position.copy(VISION_CAMERA_POSITION);
  camera.lookAt(VISION_CAMERA_TARGET);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}
