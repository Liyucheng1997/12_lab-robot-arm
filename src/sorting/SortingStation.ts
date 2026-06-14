import * as CANNON from 'cannon-es';
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

export type BallColor = 'red' | 'blue';
export type BinColor = 'white' | 'red' | 'blue';

interface BinConfig {
  color: BinColor;
  center: Vector3;
  visualColor: number;
}

export interface SortableBall {
  id: string;
  color: BallColor;
  mesh: Mesh;
  body: CANNON.Body;
  targetBin: BinColor;
}

export interface SortPlanTarget {
  ball: SortableBall;
  pickPosition: Vector3;
  prePickPosition: Vector3;
  liftPosition: Vector3;
  dropPosition: Vector3;
}

const BALL_RADIUS = 0.055;
const BIN_SIZE = new Vector3(0.62, 0.18, 0.62);
const WALL_THICKNESS = 0.035;
const BIN_FLOOR_Y = 0.16;
const PRE_PICK_CLEARANCE = 0.22;
const LIFT_CLEARANCE = 0.42;
const DROP_CLEARANCE = 0.58;

export class SortingStation {
  readonly group = new Group();
  readonly world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.81, 0),
  });

  private readonly balls: SortableBall[] = [];
  private readonly bins = new Map<BinColor, BinConfig>();
  private readonly selectionMarker: Mesh;
  private selectedBall: SortableBall | null = null;

  constructor() {
    this.group.name = 'Manual sorting station';
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.defaultContactMaterial.friction = 0.42;
    this.world.defaultContactMaterial.restitution = 0.12;

    this.selectionMarker = this.createSelectionMarker();
    this.selectionMarker.visible = false;
    this.group.add(this.selectionMarker);

    this.createGroundBody();
    this.createBins();
    this.createInitialBalls();
  }

  update(deltaSeconds: number): void {
    this.world.step(1 / 60, deltaSeconds, 3);

    this.balls.forEach((ball) => {
      if (ball.mesh.parent !== this.group) {
        return;
      }
      ball.mesh.position.copy(ball.body.position as unknown as Vector3);
      ball.mesh.quaternion.copy(ball.body.quaternion as unknown as Mesh['quaternion']);
    });

    if (this.selectedBall && this.selectedBall.mesh.parent === this.group) {
      this.selectionMarker.visible = true;
      this.selectionMarker.position.copy(this.selectedBall.mesh.position);
      this.selectionMarker.position.y += BALL_RADIUS + 0.012;
    }
  }

  getSelectableMeshes(): Mesh[] {
    return this.balls.map((ball) => ball.mesh);
  }

  getBalls(): readonly SortableBall[] {
    return this.balls;
  }

  getBallById(id: string): SortableBall | null {
    return this.balls.find((ball) => ball.id === id) ?? null;
  }

  getBallIds(): string[] {
    return this.balls.map((ball) => ball.id);
  }

  getSelectedBallId(): string {
    return this.selectedBall?.id ?? 'none';
  }

  selectBallById(id: string): SortableBall | null {
    const ball = this.balls.find((candidate) => candidate.id === id) ?? null;
    this.setSelectedBall(ball);
    return ball;
  }

  selectBallFromObject(object: Object3D): SortableBall | null {
    const ballId = object.userData.ballId as string | undefined;
    const ball = this.balls.find((candidate) => candidate.id === ballId) ?? null;
    this.setSelectedBall(ball);
    return ball;
  }

  setSelectedBall(ball: SortableBall | null): void {
    this.selectedBall = ball;
    this.selectionMarker.visible = Boolean(ball);
    this.balls.forEach((candidate) => {
      const material = candidate.mesh.material;
      if (material instanceof MeshStandardMaterial) {
        material.emissive = new Color(candidate === ball ? 0x222222 : 0x000000);
      }
    });
  }

  getSelectedBall(): SortableBall | null {
    return this.selectedBall;
  }

  createPlanTarget(ball: SortableBall): SortPlanTarget {
    const pickPosition = this.getBallWorldPosition(ball);
    return this.createPlanTargetFromPosition(ball, pickPosition);
  }

  createPlanTargetFromPosition(ball: SortableBall, pickPosition: Vector3): SortPlanTarget {
    const targetBin = this.bins.get(ball.targetBin);
    if (!targetBin) {
      throw new Error(`Missing target bin ${ball.targetBin}`);
    }

    return {
      ball,
      pickPosition,
      prePickPosition: pickPosition.clone().add(new Vector3(0, PRE_PICK_CLEARANCE, 0)),
      liftPosition: pickPosition.clone().add(new Vector3(0, LIFT_CLEARANCE, 0)),
      dropPosition: targetBin.center.clone().add(new Vector3(0, DROP_CLEARANCE, 0)),
    };
  }

  attachBallToGripper(ball: SortableBall, parent: Object3D, localPosition: Vector3): void {
    ball.body.type = CANNON.Body.KINEMATIC;
    ball.body.velocity.setZero();
    ball.body.angularVelocity.setZero();
    ball.body.collisionResponse = false;
    parent.add(ball.mesh);
    ball.mesh.position.copy(localPosition);
    ball.mesh.quaternion.identity();
    this.selectionMarker.visible = false;
  }

  releaseBallFromGripper(ball: SortableBall, worldPosition: Vector3): void {
    this.group.add(ball.mesh);
    ball.mesh.position.copy(worldPosition);
    ball.body.position.copy(new CANNON.Vec3(worldPosition.x, worldPosition.y, worldPosition.z));
    ball.body.quaternion.set(0, 0, 0, 1);
    ball.body.velocity.set(0, -0.05, 0);
    ball.body.angularVelocity.set(0, 0, 0);
    ball.body.type = CANNON.Body.DYNAMIC;
    ball.body.collisionResponse = true;
    ball.body.wakeUp();
    this.setSelectedBall(null);
  }

  getStatusLabel(): string {
    if (!this.selectedBall) {
      return 'none';
    }
    return `${this.selectedBall.id} -> ${this.selectedBall.targetBin}`;
  }

  private getBallWorldPosition(ball: SortableBall): Vector3 {
    const position = new Vector3();
    ball.mesh.getWorldPosition(position);
    return position;
  }

  private createBins(): void {
    const configs: BinConfig[] = [
      { color: 'red', center: new Vector3(1.18, BIN_FLOOR_Y, -0.72), visualColor: 0xc83232 },
      { color: 'white', center: new Vector3(1.22, BIN_FLOOR_Y, 0), visualColor: 0xe8edf2 },
      { color: 'blue', center: new Vector3(1.18, BIN_FLOOR_Y, 0.72), visualColor: 0x2f6fff },
    ];

    configs.forEach((config) => {
      this.bins.set(config.color, config);
      this.group.add(this.createBinVisual(config));
      this.addBinPhysics(config);
    });
  }

  private createBinVisual(config: BinConfig): Group {
    const bin = new Group();
    bin.name = `${config.color} sorting bin`;
    const material = new MeshStandardMaterial({
      color: config.visualColor,
      metalness: 0.18,
      roughness: 0.48,
      transparent: true,
      opacity: 0.78,
    });

    const floor = this.createBoxMesh(BIN_SIZE.x, WALL_THICKNESS, BIN_SIZE.z, material);
    floor.position.copy(config.center);
    floor.position.y = config.center.y;
    bin.add(floor);

    const leftWall = this.createBoxMesh(BIN_SIZE.x, BIN_SIZE.y, WALL_THICKNESS, material);
    leftWall.position.set(
      config.center.x,
      config.center.y + BIN_SIZE.y * 0.5,
      config.center.z - BIN_SIZE.z * 0.5,
    );
    bin.add(leftWall);

    const rightWall = this.createBoxMesh(BIN_SIZE.x, BIN_SIZE.y, WALL_THICKNESS, material);
    rightWall.position.set(
      config.center.x,
      config.center.y + BIN_SIZE.y * 0.5,
      config.center.z + BIN_SIZE.z * 0.5,
    );
    bin.add(rightWall);

    const frontWall = this.createBoxMesh(WALL_THICKNESS, BIN_SIZE.y, BIN_SIZE.z, material);
    frontWall.position.set(
      config.center.x + BIN_SIZE.x * 0.5,
      config.center.y + BIN_SIZE.y * 0.5,
      config.center.z,
    );
    bin.add(frontWall);

    const rearWall = this.createBoxMesh(WALL_THICKNESS, BIN_SIZE.y, BIN_SIZE.z, material);
    rearWall.position.set(
      config.center.x - BIN_SIZE.x * 0.5,
      config.center.y + BIN_SIZE.y * 0.5,
      config.center.z,
    );
    bin.add(rearWall);
    return bin;
  }

  private addBinPhysics(config: BinConfig): void {
    this.addStaticBox(
      new Vector3(config.center.x, config.center.y, config.center.z),
      new Vector3(BIN_SIZE.x, WALL_THICKNESS, BIN_SIZE.z),
    );
    this.addStaticBox(
      new Vector3(config.center.x, config.center.y + BIN_SIZE.y * 0.5, config.center.z - BIN_SIZE.z * 0.5),
      new Vector3(BIN_SIZE.x, BIN_SIZE.y, WALL_THICKNESS),
    );
    this.addStaticBox(
      new Vector3(config.center.x, config.center.y + BIN_SIZE.y * 0.5, config.center.z + BIN_SIZE.z * 0.5),
      new Vector3(BIN_SIZE.x, BIN_SIZE.y, WALL_THICKNESS),
    );
    this.addStaticBox(
      new Vector3(config.center.x + BIN_SIZE.x * 0.5, config.center.y + BIN_SIZE.y * 0.5, config.center.z),
      new Vector3(WALL_THICKNESS, BIN_SIZE.y, BIN_SIZE.z),
    );
    this.addStaticBox(
      new Vector3(config.center.x - BIN_SIZE.x * 0.5, config.center.y + BIN_SIZE.y * 0.5, config.center.z),
      new Vector3(WALL_THICKNESS, BIN_SIZE.y, BIN_SIZE.z),
    );
  }

  private createInitialBalls(): void {
    const source = this.bins.get('white');
    if (!source) {
      return;
    }

    const colors: BallColor[] = ['red', 'red', 'red', 'red', 'red', 'blue', 'blue', 'blue', 'blue', 'blue'];
    colors.forEach((color, index) => {
      const column = Math.floor(index / 5);
      const row = index % 5;
      const position = source.center
        .clone()
        .add(new Vector3(-0.06 + column * 0.12, 0.34 + column * 0.11, -0.24 + row * 0.12));
      this.createBall(`B${index + 1}`, color, position);
    });
  }

  private createBall(id: string, color: BallColor, position: Vector3): void {
    const material = new MeshStandardMaterial({
      color: color === 'red' ? 0xff3b30 : 0x2f6fff,
      metalness: 0.08,
      roughness: 0.42,
    });
    const mesh = new Mesh(new SphereGeometry(BALL_RADIUS, 32, 20), material);
    mesh.name = `${color} sortable ball ${id}`;
    mesh.userData.ballId = id;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(position);
    this.group.add(mesh);

    const body = new CANNON.Body({
      mass: 0.06,
      shape: new CANNON.Sphere(BALL_RADIUS),
      position: new CANNON.Vec3(position.x, position.y, position.z),
      linearDamping: 0.12,
      angularDamping: 0.2,
    });
    this.world.addBody(body);
    this.balls.push({
      id,
      color,
      mesh,
      body,
      targetBin: color,
    });
  }

  private createGroundBody(): void {
    const ground = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Plane(),
    });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(ground);
  }

  private createBoxMesh(
    width: number,
    height: number,
    depth: number,
    material: MeshStandardMaterial,
  ): Mesh {
    const mesh = new Mesh(new BoxGeometry(width, height, depth), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private addStaticBox(position: Vector3, size: Vector3): void {
    const body = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(size.x * 0.5, size.y * 0.5, size.z * 0.5)),
      position: new CANNON.Vec3(position.x, position.y, position.z),
    });
    this.world.addBody(body);
  }

  private createSelectionMarker(): Mesh {
    const marker = new Mesh(
      new RingGeometry(BALL_RADIUS * 1.35, BALL_RADIUS * 1.65, 40),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    marker.name = 'Selected ball marker';
    marker.rotation.x = -Math.PI / 2;
    return marker;
  }
}
