import { AmbientLight, DirectionalLight, HemisphereLight, Scene } from 'three';

export function addLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 0.3));
  scene.add(new HemisphereLight(0xe8f2ff, 0x25282a, 0.78));

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

  const fill = new DirectionalLight(0xc9ddff, 1.15);
  fill.position.set(-3.2, 2.8, 3.4);
  scene.add(fill);

  const rim = new DirectionalLight(0xffffff, 1.35);
  rim.position.set(-1.8, 3.8, -3.6);
  scene.add(rim);
}
