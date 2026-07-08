import { AmbientLight, DirectionalLight, HemisphereLight, Scene } from 'three';

export function addLights(scene: Scene): void {
  scene.add(new AmbientLight(0xffffff, 0.2));
  scene.add(new HemisphereLight(0xe8f2ff, 0x25282a, 0.5));

  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(6.5, 7.5, 3.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 24;
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -8;
  scene.add(key);

  const fill = new DirectionalLight(0xc9ddff, 0.85);
  fill.position.set(-3.2, 2.8, 3.4);
  scene.add(fill);

  const rim = new DirectionalLight(0xffffff, 1.0);
  rim.position.set(-1.8, 3.8, -3.6);
  scene.add(rim);
}
