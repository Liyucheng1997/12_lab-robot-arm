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
import type { BallColor } from '../sorting/SortingStation';
import type { VisionDetection, VisionFrame, VisionSystem } from './VisionSystem';
import { configureStationVisionCamera } from './cameraConfig';
import { detectBlobs, usablePixelRatio } from './imageProcessing';

const CAPTURE_WIDTH = 240;
const CAPTURE_HEIGHT = 180;
/** Approximate height of a ball center resting on the staging-bin floor. */
const BALL_PLANE_Y = 0.24;
/** Below this lit-pixel ratio the view is treated as obstructed/unreadable (FR-008). */
const OBSERVABLE_RATIO_FLOOR = 0.1;
interface DetectionRegion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Only balls in the gray source bin are actionable by the sorting controller. */
const PICK_REGION = { minX: 0.85, maxX: 1.62, minZ: -0.45, maxZ: 0.45 };
/** The operator preview tracks balls across the source and both destination bins. */
const STATION_REGION = { minX: 0.78, maxX: 1.68, minZ: -1.08, maxZ: 1.08 };

/**
 * Genuine online recognition: renders the fixed front camera to an offscreen target,
 * reads the pixels back, and recovers ball color + position from the image alone.
 * It never reads ball world positions or colors (see contracts/vision-system.md VS-1).
 */
export class OnlineVisionSystem implements VisionSystem {
  readonly mode = 'online' as const;
  readonly camera = new PerspectiveCamera(50, CAPTURE_WIDTH / CAPTURE_HEIGHT, 0.05, 8);
  readonly group = new Group();
  /** Scene objects (other vision rigs, overlays) hidden while capturing the frame. */
  hideDuringCapture: Object3D[] = [];

  private readonly detectionMarkers = new Group();
  private readonly raycaster = new Raycaster();
  private readonly renderTarget: WebGLRenderTarget;
  private readonly buffer = new Uint8Array(CAPTURE_WIDTH * CAPTURE_HEIGHT * 4);

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
  ) {
    this.camera.name = 'Online front vision camera';
    configureStationVisionCamera(this.camera);

    this.detectionMarkers.name = 'Online vision detection markers';
    this.group.name = 'Online vision';
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

  detectBalls(frame: VisionFrame): VisionDetection[] {
    return this.detectInRegion(frame, PICK_REGION);
  }

  detectVisibleBalls(frame: VisionFrame): VisionDetection[] {
    return this.detectInRegion(frame, STATION_REGION);
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
        ballId: null,
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
    const t = (BALL_PLANE_Y - origin.y) / direction.y;
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
}
