import { PerspectiveCamera } from 'three';

export function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(7.6, 3.6, 4.8);
  camera.lookAt(2.3, 0.45, 0.4);
  return camera;
}
