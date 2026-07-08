import { Color, Scene } from 'three';
import { addLights } from './lights';

export function createScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x10141a);
  addLights(scene);
  return scene;
}
