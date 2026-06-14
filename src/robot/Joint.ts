import { Group, Mesh, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3 } from 'three';
import type { JointLimit } from '../types/robot';
import { createAxes } from '../utils/axes';
import { clamp } from '../utils/math';

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

  private createJointBody(): Mesh {
    const geometry = new SphereGeometry(this.bodyRadius, 32, 18);
    const material = new MeshStandardMaterial({
      color: 0x25313d,
      metalness: 0.55,
      roughness: 0.35,
    });
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
