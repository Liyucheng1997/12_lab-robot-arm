import {
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  RingGeometry,
  type Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { MARKER_PLANE_Y, type DetectionRegion } from '../assembly/layout';
import type { DetectionColor, VisionDetection, VisionFrame, VisionSystem } from './VisionSystem';
import { detectBlobs, usablePixelRatio } from './imageProcessing';

const CAPTURE_WIDTH = 320;
const CAPTURE_HEIGHT = 240;
/** Below this lit-pixel ratio the view is treated as obstructed/unreadable. */
const OBSERVABLE_RATIO_FLOOR = 0.1;

const MARKER_RING_COLORS: Record<DetectionColor, number> = {
  red: 0xff6b6b,
  blue: 0x6b9bff,
  yellow: 0xffd166,
};

export interface VisionRigConfig {
  name: string;
  fov: number;
  /** Fixed camera pose, in world coordinates. */
  position: Vector3;
  target: Vector3;
  /** World-coordinate windows the detections are filtered against. */
  pickRegion: DetectionRegion;
  cellRegion: DetectionRegion;
}

/**
 * Genuine online recognition: renders a fixed station camera to an offscreen
 * target, reads the pixels back, and recovers part-marker color + position from
 * the image alone. It never reads part world positions or types.
 */
export class OnlineVisionSystem implements VisionSystem {
  readonly camera: PerspectiveCamera;
  readonly group = new Group();
  /** Scene objects (overlays, effects) hidden while capturing the frame. */
  hideDuringCapture: Object3D[] = [];

  private readonly detectionMarkers = new Group();
  private readonly raycaster = new Raycaster();
  private readonly renderTarget: WebGLRenderTarget;
  private readonly buffer = new Uint8Array(CAPTURE_WIDTH * CAPTURE_HEIGHT * 4);

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly config: VisionRigConfig,
  ) {
    this.camera = new PerspectiveCamera(config.fov, CAPTURE_WIDTH / CAPTURE_HEIGHT, 0.05, 12);
    this.camera.name = config.name;
    this.camera.position.copy(config.position);
    this.camera.lookAt(config.target);
    this.camera.updateMatrixWorld(true);
    this.camera.updateProjectionMatrix();

    this.detectionMarkers.name = `${config.name} detection markers`;
    this.group.name = config.name;
    this.group.add(this.detectionMarkers);

    this.renderTarget = new WebGLRenderTarget(CAPTURE_WIDTH, CAPTURE_HEIGHT);
    this.renderTarget.texture.colorSpace = SRGBColorSpace;
  }

  observe(): VisionFrame {
    this.camera.updateMatrixWorld(true);
    const restore = this.hideOverlays();

    const previousTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(
      this.renderTarget,
      0,
      0,
      CAPTURE_WIDTH,
      CAPTURE_HEIGHT,
      this.buffer,
    );
    this.renderer.setRenderTarget(previousTarget);
    restore();

    const ratio = usablePixelRatio(this.buffer, CAPTURE_WIDTH, CAPTURE_HEIGHT);
    return {
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      pixels: this.buffer,
      usablePixelRatio: ratio,
      isObservable: ratio > OBSERVABLE_RATIO_FLOOR,
    };
  }

  detectPickable(frame: VisionFrame): VisionDetection[] {
    return this.detectInRegion(frame, this.config.pickRegion);
  }

  detectAll(frame: VisionFrame): VisionDetection[] {
    return this.detectInRegion(frame, this.config.cellRegion);
  }

  private detectInRegion(frame: VisionFrame, region: DetectionRegion): VisionDetection[] {
    this.detectionMarkers.clear();
    const blobs = detectBlobs(frame.pixels, frame.width, frame.height);
    const detections: VisionDetection[] = [];

    blobs.forEach((blob) => {
      // readRenderTargetPixels uses a bottom-left origin, so row index maps straight to +y up.
      const ndcX = (blob.centroidX / frame.width) * 2 - 1;
      const ndcY = (blob.centroidY / frame.height) * 2 - 1;
      const world = this.backProject(ndcX, ndcY);
      if (
        world.x < region.minX ||
        world.x > region.maxX ||
        world.z < region.minZ ||
        world.z > region.maxZ
      ) {
        return;
      }
      this.addDetectionMarker(world, blob.color);
      detections.push({
        color: blob.color,
        pixel: new Vector2(blob.centroidX, blob.centroidY),
        estimatedWorldPosition: world,
        confidence: blob.confidence,
        areaPx: blob.areaPx,
      });
    });

    return detections.sort((left, right) => right.confidence - left.confidence);
  }

  private backProject(ndcX: number, ndcY: number): Vector3 {
    this.raycaster.setFromCamera(new Vector2(ndcX, ndcY), this.camera);
    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;
    const t = (MARKER_PLANE_Y - origin.y) / direction.y;
    return origin.clone().add(direction.clone().multiplyScalar(t));
  }

  private hideOverlays(): () => void {
    const objects = [this.group, ...this.hideDuringCapture];
    const previous = objects.map((object) => object.visible);
    objects.forEach((object) => {
      object.visible = false;
    });
    return () => {
      objects.forEach((object, index) => {
        object.visible = previous[index];
      });
    };
  }

  private addDetectionMarker(position: Vector3, color: DetectionColor): void {
    const marker = new Mesh(
      new RingGeometry(0.07, 0.082, 32),
      new MeshBasicMaterial({
        color: MARKER_RING_COLORS[color],
        transparent: true,
        opacity: 0.92,
      }),
    );
    marker.position.copy(position);
    marker.position.y += 0.12;
    marker.rotation.x = -Math.PI / 2;
    this.detectionMarkers.add(marker);
  }
}
