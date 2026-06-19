import { CylinderGeometry, Group, Material, Mesh, Quaternion, Vector3 } from 'three';
import type { JointLimit } from '../types/robot';
import { createAxes } from '../utils/axes';
import { clamp } from '../utils/math';
import { jointSealMaterial, robotPaintMaterial, robotPaintShadowMaterial } from './materials';

export class Joint {
  readonly group = new Group();
  readonly axis: Vector3;
  readonly frame = createAxes(0.18);
  private angle = 0;

  constructor(
    readonly index: number,
    readonly name: string,
    axis: Vector3,
    readonly limit: JointLimit,
    private readonly bodyRadius = 0.105,
  ) {
    this.axis = axis.clone().normalize();
    this.group.name = name;
    this.group.add(this.createJointBody());
    this.group.add(this.frame);
  }

  setAngle(angle: number): number {
    this.angle = clamp(angle, this.limit.min, this.limit.max);
    this.group.quaternion.copy(new Quaternion().setFromAxisAngle(this.axis, this.angle));
    return this.angle;
  }

  getAngle(): number {
    return this.angle;
  }

  setFrameVisible(visible: boolean): void {
    this.frame.visible = visible;
  }

  private createJointBody(): Group {
    const assembly = new Group();
    assembly.name = `${this.name} housing`;

    const coreDepth = this.bodyRadius * 1.34;
    const core = this.createAxialPart(
      new CylinderGeometry(this.bodyRadius, this.bodyRadius, coreDepth, 48),
      robotPaintMaterial,
    );
    assembly.add(core);

    const capDepth = this.bodyRadius * 0.19;
    const capOffset = coreDepth * 0.5 + capDepth * 0.32;
    for (const side of [-1, 1]) {
      const seal = this.createAxialPart(
        new CylinderGeometry(this.bodyRadius * 1.035, this.bodyRadius * 1.035, capDepth, 48),
        jointSealMaterial,
      );
      seal.position.copy(this.axis).multiplyScalar(side * capOffset);
      assembly.add(seal);

      const cap = this.createAxialPart(
        new CylinderGeometry(this.bodyRadius * 0.82, this.bodyRadius * 0.9, capDepth * 0.82, 48),
        robotPaintShadowMaterial,
      );
      cap.position.copy(this.axis).multiplyScalar(side * (capOffset + capDepth * 0.72));
      assembly.add(cap);
    }
    return assembly;
  }

  private createAxialPart(geometry: CylinderGeometry, material: Material): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), this.axis));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
