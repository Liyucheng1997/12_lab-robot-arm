import type { PerspectiveCamera, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export function createControls(camera: PerspectiveCamera, renderer: WebGLRenderer): OrbitControls {
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0.8, 0.7, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.8;
  controls.maxDistance = 8;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.update();
  return controls;
}
