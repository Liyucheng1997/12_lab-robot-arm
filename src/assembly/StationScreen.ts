import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';

export interface StationScreen {
  group: Group;
  /** The cyan display face — hide during vision capture so it never reads as blue. */
  screenMesh: Mesh;
  setLines(lines: string[]): void;
}

const postMaterial = new MeshStandardMaterial({ color: 0x50585f, metalness: 0.75, roughness: 0.35 });

/** Small pole-mounted status display, facing the operator side (+x). */
export function createStationScreen(position: Vector3, rotationY = 1.35): StationScreen {
  const group = new Group();
  group.name = 'Station status screen';

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 224;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const post = new Mesh(new CylinderGeometry(0.02, 0.024, 0.62, 16), postMaterial);
  post.position.set(position.x, 0.31, position.z);
  post.castShadow = true;
  group.add(post);

  const screen = new Mesh(
    new PlaneGeometry(0.34, 0.15),
    new MeshBasicMaterial({ map: texture, side: DoubleSide }),
  );
  screen.position.set(position.x, 0.72, position.z);
  screen.rotation.y = rotationY;
  group.add(screen);

  const back = new Mesh(new BoxGeometry(0.36, 0.17, 0.02), postMaterial);
  back.position.copy(screen.position);
  back.rotation.copy(screen.rotation);
  back.translateZ(-0.012);
  back.castShadow = true;
  group.add(back);

  const setLines = (lines: string[]): void => {
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.fillStyle = '#04131c';
    context.fillRect(0, 0, 512, 224);
    context.strokeStyle = '#0e3a4f';
    context.lineWidth = 6;
    context.strokeRect(6, 6, 500, 212);
    context.fillStyle = '#37d3ff';
    context.font = '600 44px "Segoe UI", system-ui, sans-serif';
    lines.slice(0, 3).forEach((line, index) => {
      context.fillText(line, 28, 78 + index * 62);
    });
    texture.needsUpdate = true;
  };
  setLines(['就绪']);

  return { group, screenMesh: screen, setLines };
}
