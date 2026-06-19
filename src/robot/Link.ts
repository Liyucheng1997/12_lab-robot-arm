import {
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { jointSealMaterial, robotPaintMaterial, robotPaintShadowMaterial } from './materials';

export class Link {
  readonly group = new Group();

  constructor(
    readonly name: string,
    readonly offset: Vector3,
    radius: number,
  ) {
    this.group.name = name;
    this.group.add(this.createLinkVisual(offset, radius));
  }

  /**
   * Replace this placeholder geometry with a glTF visual mesh while keeping the same kinematic frame.
   */
  replaceVisual(mesh: Object3D): void {
    this.group.clear();
    mesh.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.group.add(mesh);
  }

  private createLinkVisual(offset: Vector3, radius: number): Group {
    const length = offset.length();
    const visual = new Group();

    if (length <= 0.001) {
      return visual;
    }

    const shellRadius = radius * 0.88;
    const straightLength = Math.max(0.02, length - shellRadius * 1.7);
    const shell = new Mesh(
      new CapsuleGeometry(shellRadius, straightLength, 8, 32),
      robotPaintMaterial,
    );
    orientAlongOffset(shell, offset, offset.clone().multiplyScalar(0.5));
    shell.castShadow = true;
    shell.receiveShadow = true;
    visual.add(shell);

    // A shallow inset panel breaks up the otherwise perfectly smooth casing.
    if (length > 0.35) {
      const panelLength = Math.max(0.06, straightLength * 0.56);
      const panel = new Mesh(
        new CapsuleGeometry(shellRadius * 0.91, panelLength, 6, 24),
        robotPaintShadowMaterial,
      );
      orientAlongOffset(panel, offset, offset.clone().multiplyScalar(0.5));
      panel.scale.set(1, 1, 0.985);
      panel.castShadow = true;
      panel.receiveShadow = true;
      visual.add(panel);
    }

    const collarDepth = Math.min(0.038, length * 0.12);
    const collar = new Mesh(
      new CylinderGeometry(shellRadius * 1.03, shellRadius * 1.03, collarDepth, 40),
      jointSealMaterial,
    );
    orientAlongOffset(collar, offset, offset.clone().multiplyScalar(0.91));
    collar.castShadow = true;
    visual.add(collar);
    return visual;
  }
}

function orientAlongOffset(object: Object3D, offset: Vector3, position: Vector3): void {
  object.position.copy(position);
  object.quaternion.copy(
    new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), offset.clone().normalize()),
  );
}
