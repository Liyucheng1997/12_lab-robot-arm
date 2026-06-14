import {
  BoxGeometry,
  CameraHelper,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  RingGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { BallColor, SortableBall } from '../sorting/SortingStation';
import type { VisionDetection, VisionFrame, VisionSystem } from './VisionSystem';

export type { VisionDetection } from './VisionSystem';

export class OfflineVisionSystem implements VisionSystem {
  readonly mode = 'offline' as const;
  readonly camera = new PerspectiveCamera(42, 4 / 3, 0.05, 8);
  readonly group = new Group();
  readonly imageSize = new Vector2(320, 240);

  private readonly raycaster = new Raycaster();
  private readonly detectionMarkers = new Group();

  constructor(private readonly getBalls: () => readonly SortableBall[]) {
    this.camera.name = 'Fixed overhead vision camera';
    this.camera.position.set(1.2, 3.05, 0);
    this.camera.lookAt(1.2, 0.18, 0);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    const helper = new CameraHelper(this.camera);
    helper.name = 'Vision camera frustum';
    this.detectionMarkers.name = 'Vision detection markers';
    this.group.add(this.createCameraRig(), helper, this.detectionMarkers);
  }

  /** Offline path does not read pixels; it synthesizes an always-observable frame. */
  observe(): VisionFrame {
    return {
      width: this.imageSize.x,
      height: this.imageSize.y,
      pixels: new Uint8Array(0),
      usablePixelRatio: 1,
      isObservable: true,
    };
  }

  detectBalls(): VisionDetection[] {
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();
    this.detectionMarkers.clear();

    return this.getBalls()
      .map((ball) => this.detectBall(ball))
      .filter((detection): detection is VisionDetection => detection !== null)
      .sort((left, right) => right.confidence - left.confidence);
  }

  private detectBall(ball: SortableBall): VisionDetection | null {
    const worldPosition = new Vector3();
    ball.mesh.getWorldPosition(worldPosition);
    const ndc = worldPosition.clone().project(this.camera);

    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z < -1 || ndc.z > 1) {
      return null;
    }

    const pixel = new Vector2(
      ((ndc.x + 1) * 0.5) * this.imageSize.x,
      ((1 - ndc.y) * 0.5) * this.imageSize.y,
    );
    const estimatedWorldPosition = this.estimateWorldFromPixel(pixel, worldPosition.y);
    const confidence = this.computeConfidence(ndc, ball.color);
    this.addDetectionMarker(estimatedWorldPosition, ball.color);

    return {
      ballId: ball.id,
      color: ball.color,
      pixel,
      estimatedWorldPosition,
      confidence,
      areaPx: 1,
    };
  }

  private estimateWorldFromPixel(pixel: Vector2, planeY: number): Vector3 {
    const ndc = new Vector2(
      (pixel.x / this.imageSize.x) * 2 - 1,
      -((pixel.y / this.imageSize.y) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);

    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;
    const t = (planeY - origin.y) / direction.y;
    return origin.clone().add(direction.clone().multiplyScalar(t));
  }

  private computeConfidence(ndc: Vector3, color: BallColor): number {
    const distanceFromCenter = Math.sqrt(ndc.x * ndc.x + ndc.y * ndc.y);
    const colorPrior = color === 'red' || color === 'blue' ? 0.98 : 0.75;
    return Math.max(0.55, colorPrior - distanceFromCenter * 0.18);
  }

  private addDetectionMarker(position: Vector3, color: BallColor): void {
    const marker = new Mesh(
      new RingGeometry(0.07, 0.082, 32),
      new MeshBasicMaterial({
        color: color === 'red' ? 0xff6b6b : 0x6b9bff,
        transparent: true,
        opacity: 0.92,
      }),
    );
    marker.position.copy(position);
    marker.position.y += 0.1;
    marker.rotation.x = -Math.PI / 2;
    this.detectionMarkers.add(marker);
  }

  private createCameraRig(): Group {
    const rig = new Group();
    rig.name = 'Visible overhead vision camera rig';

    const supportMaterial = new MeshStandardMaterial({
      color: 0x2f3a42,
      metalness: 0.55,
      roughness: 0.32,
    });
    const bodyMaterial = new MeshStandardMaterial({
      color: 0x506371,
      metalness: 0.45,
      roughness: 0.25,
    });
    const lensMaterial = new MeshStandardMaterial({
      color: 0x37d7ff,
      emissive: 0x0b4a5a,
      emissiveIntensity: 0.65,
      metalness: 0.15,
      roughness: 0.18,
    });

    const mastHeight = 2.82;
    const mast = new Mesh(new CylinderGeometry(0.026, 0.026, mastHeight, 18), supportMaterial);
    mast.name = 'Vision camera mast';
    mast.position.set(0.55, mastHeight / 2, -0.62);
    mast.castShadow = true;
    rig.add(mast);

    const boomLength = this.camera.position.x - mast.position.x;
    const boom = new Mesh(new BoxGeometry(boomLength, 0.045, 0.055), supportMaterial);
    boom.name = 'Vision camera boom';
    boom.position.set(mast.position.x + boomLength / 2, 2.78, -0.62);
    boom.castShadow = true;
    rig.add(boom);

    const drop = new Mesh(new CylinderGeometry(0.018, 0.018, 0.62, 16), supportMaterial);
    drop.name = 'Vision camera drop bracket';
    drop.position.set(this.camera.position.x, 2.48, -0.62);
    drop.castShadow = true;
    rig.add(drop);

    const cameraBody = new Mesh(new BoxGeometry(0.36, 0.18, 0.28), bodyMaterial);
    cameraBody.name = 'Fixed overhead vision camera body';
    cameraBody.position.set(this.camera.position.x, 2.17, -0.62);
    cameraBody.castShadow = true;
    rig.add(cameraBody);

    const sensorFace = new Mesh(new BoxGeometry(0.22, 0.018, 0.16), lensMaterial);
    sensorFace.name = 'Fixed overhead vision camera sensor face';
    sensorFace.position.set(this.camera.position.x, 2.068, -0.62);
    sensorFace.castShadow = true;
    rig.add(sensorFace);

    const lens = new Mesh(new CylinderGeometry(0.072, 0.09, 0.105, 28), lensMaterial);
    lens.name = 'Fixed overhead vision camera lens';
    lens.position.set(this.camera.position.x, 2.0, -0.62);
    lens.castShadow = true;
    rig.add(lens);

    return rig;
  }
}
