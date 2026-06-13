import { AmbientLight, DirectionalLight, HemisphereLight, Scene } from 'three';

export function addLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 0.22));
  scene.add(new HemisphereLight(0xddeeff, 0x202830, 0.55));

  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(3.6, 5.2, 2.8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 12;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  scene.add(key);
}
