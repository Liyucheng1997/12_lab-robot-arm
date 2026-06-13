import { PerspectiveCamera } from 'three';

export function createCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(3.6, 2.4, 3.4);
  camera.lookAt(0.8, 0.8, 0);
  return camera;
}
