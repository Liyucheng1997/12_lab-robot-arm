import {
  Color,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from 'three';
import { addLights } from './lights';

export function createScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0x111417);

  const grid = new GridHelper(8, 40, 0x5c6773, 0x2c333a);
  grid.position.y = 0.002;
  scene.add(grid);

  const floor = new Mesh(
    new PlaneGeometry(8, 8),
    new MeshStandardMaterial({ color: 0x1d2329, roughness: 0.78, metalness: 0.05 }),
  );
  floor.name = 'Ground plane';
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  addLights(scene);
  return scene;
}
