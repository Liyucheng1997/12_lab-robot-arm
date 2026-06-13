import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { Pose } from '../types/robot';
import { createAxes } from '../utils/axes';
import { clamp, vectorFromTuple } from '../utils/math';
import {
  DEFAULT_JOINT_CONFIGS,
  GRIPPER_GRASP_OFFSET,
  HOME_POSE,
  ROBOT_BASE_OFFSET,
  ZERO_POSE,
} from './limits';
import { Link } from './Link';
import { Joint } from './Joint';

export class RobotArm {
  readonly group = new Group();
  readonly joints: Joint[] = [];
  readonly links: Link[] = [];
  readonly endEffector = new Group();
  readonly endEffectorFrame = createAxes(0.24);
  private readonly leftFinger = new Group();
  private readonly rightFinger = new Group();
  private gripperOpening = 0.1;

  constructor() {
    this.group.name = 'Industrial 6-DOF Robot Arm';
    this.group.add(this.createBase());
    this.createKinematicTree();
    this.setJointAngles(HOME_POSE);
  }

  setJointAngle(index: number, angle: number): number {
    const joint = this.joints[index];
    if (!joint) {
      throw new RangeError(`Joint index ${index} is out of range`);
    }
    return joint.setAngle(angle);
  }

  setJointAngles(angles: number[]): void {
    this.joints.forEach((joint, index) => {
      const limit = DEFAULT_JOINT_CONFIGS[index].limit;
      joint.setAngle(clamp(angles[index] ?? joint.getAngle(), limit.min, limit.max));
    });
  }

  getJointAngles(): number[] {
    return this.joints.map((joint) => joint.getAngle());
  }

  reset(): void {
    this.setJointAngles(ZERO_POSE);
  }

  home(): void {
    this.setJointAngles(HOME_POSE);
  }

  setGripperOpening(opening: number): number {
    this.gripperOpening = clamp(opening, 0.025, 0.18);
    const halfOpening = this.gripperOpening * 0.5;
    this.leftFinger.position.z = halfOpening;
    this.rightFinger.position.z = -halfOpening;
    return this.gripperOpening;
  }

  getGripperOpening(): number {
    return this.gripperOpening;
  }

  setFramesVisible(visible: boolean): void {
    this.joints.forEach((joint) => joint.setFrameVisible(visible));
    this.endEffectorFrame.visible = visible;
  }

  getEndEffectorPose(): Pose {
    this.group.updateMatrixWorld(true);
    const position = new Vector3();
    const orientation = new Quaternion();
    const scale = new Vector3();
    const transform = this.endEffector.matrixWorld.clone();
    transform.decompose(position, orientation, scale);
    return { position, orientation, transform };
  }

  getGraspPose(): Pose {
    this.group.updateMatrixWorld(true);
    const transform = this.endEffector.matrixWorld
      .clone()
      .multiply(new Matrix4().makeTranslation(...GRIPPER_GRASP_OFFSET));
    const position = new Vector3();
    const orientation = new Quaternion();
    const scale = new Vector3();
    transform.decompose(position, orientation, scale);
    return { position, orientation, transform };
  }

  attachObjectToGripper(object: Object3D): void {
    this.endEffector.add(object);
    object.position.set(...GRIPPER_GRASP_OFFSET);
    object.quaternion.identity();
  }

  /**
   * Future glTF integration point. Keep the joint transform tree intact and replace link visuals only.
   */
  replaceLinkVisual(index: number, mesh: Mesh): void {
    const link = this.links[index];
    if (!link) {
      throw new RangeError(`Link index ${index} is out of range`);
    }
    link.replaceVisual(mesh);
  }

  private createKinematicTree(): void {
    let parent: Group = this.group;

    DEFAULT_JOINT_CONFIGS.forEach((config, index) => {
      const joint = new Joint(index, config.name, vectorFromTuple(config.axis), config.limit);
      if (index === 0) {
        joint.group.position.set(...ROBOT_BASE_OFFSET);
      } else {
        joint.group.position.set(...DEFAULT_JOINT_CONFIGS[index - 1].offsetToNext);
      }

      const link = new Link(
        `Link ${index + 1}`,
        vectorFromTuple(config.offsetToNext),
        config.linkRadius,
        config.linkColor,
      );
      joint.group.add(link.group);

      parent.add(joint.group);
      parent = joint.group;
      this.joints.push(joint);
      this.links.push(link);
    });

    this.endEffector.name = 'End effector';
    this.endEffector.position.set(...DEFAULT_JOINT_CONFIGS[DEFAULT_JOINT_CONFIGS.length - 1].offsetToNext);
    this.endEffector.add(this.createParallelGripper());
    this.endEffector.add(this.endEffectorFrame);
    parent.add(this.endEffector);
  }

  private createBase(): Mesh {
    const base = new Mesh(
      new BoxGeometry(0.62, 0.18, 0.62),
      new MeshStandardMaterial({ color: 0x2f3a44, metalness: 0.45, roughness: 0.4 }),
    );
    base.name = 'Robot pedestal';
    base.position.y = 0.08;
    base.castShadow = true;
    base.receiveShadow = true;
    return base;
  }

  private createParallelGripper(): Group {
    const gripper = new Group();
    gripper.name = 'Parallel jaw gripper';

    const bodyMaterial = new MeshStandardMaterial({
      color: 0x384653,
      metalness: 0.48,
      roughness: 0.34,
    });
    const jawMaterial = new MeshStandardMaterial({
      color: 0xf0b429,
      metalness: 0.32,
      roughness: 0.38,
    });
    const padMaterial = new MeshStandardMaterial({
      color: 0x151719,
      metalness: 0.08,
      roughness: 0.72,
    });

    const flange = this.createGripperBox('Tool flange', [0.08, 0.16, 0.16], bodyMaterial);
    flange.position.x = 0.04;
    gripper.add(flange);

    const actuator = this.createGripperBox('Gripper actuator', [0.12, 0.18, 0.22], bodyMaterial);
    actuator.position.x = 0.14;
    gripper.add(actuator);

    const rail = this.createGripperBox('Jaw guide rail', [0.2, 0.045, 0.24], bodyMaterial);
    rail.position.x = 0.22;
    rail.position.y = 0.01;
    gripper.add(rail);

    this.leftFinger.name = 'Left gripper finger';
    this.leftFinger.add(this.createFingerMesh(jawMaterial, padMaterial, 1));

    this.rightFinger.name = 'Right gripper finger';
    this.rightFinger.add(this.createFingerMesh(jawMaterial, padMaterial, -1));

    gripper.add(this.leftFinger, this.rightFinger);
    this.setGripperOpening(this.gripperOpening);
    return gripper;
  }

  private createFingerMesh(
    jawMaterial: MeshStandardMaterial,
    padMaterial: MeshStandardMaterial,
    side: 1 | -1,
  ): Group {
    const finger = new Group();

    const knuckle = this.createGripperBox('Finger knuckle', [0.08, 0.09, 0.045], jawMaterial);
    knuckle.position.set(0.22, 0, 0);
    finger.add(knuckle);

    const jaw = this.createGripperBox('Finger jaw', [0.28, 0.055, 0.04], jawMaterial);
    jaw.position.set(0.36, 0, 0);
    finger.add(jaw);

    const pad = this.createGripperBox('Finger contact pad', [0.18, 0.058, 0.012], padMaterial);
    pad.position.set(0.43, 0, -side * 0.026);
    finger.add(pad);
    return finger;
  }

  private createGripperBox(
    name: string,
    size: [number, number, number],
    material: MeshStandardMaterial,
  ): Mesh {
    const mesh = new Mesh(
      new BoxGeometry(size[0], size[1], size[2]),
      material,
    );
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
