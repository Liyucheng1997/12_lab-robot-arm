import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import {
  BELT_TOP_Y,
  CONVEYOR_SPEED,
  INFEED_CENTER_X,
  INFEED_END_Z,
  INFEED_START_Z,
  INFEED_WIDTH,
  PALLET_PITCH,
  PALLET_SIZE,
  PALLET_TOP_Y,
  PICK_STATION_Z,
  createAssemblyPlanTarget,
  stationOffsetX,
  type AssemblyPlanTarget,
  type PartType,
} from './layout';
import { createPart, type AssemblyPart } from './parts';

const PALLET_READY_DWELL_SECONDS = 0.45;
const SINK_SPEED = 0.45;
const SINK_DESPAWN_Y = -0.32;
/**
 * Min-max replenishment: keep at most one pallet at the pick station plus one
 * staged behind it. No new pallet is fed until one is consumed, so the belt
 * can never pile up.
 */
const TARGET_QUEUE = 2;
/** Belt speed boost while the pick station is starving and stock is en route. */
const RUSH_FACTOR = 1.6;

type PalletState = 'feeding' | 'holding' | 'sinking';

interface Pallet {
  group: Group;
  part: AssemblyPart | null;
  state: PalletState;
  dwell: number;
  /** Vertical offset while sinking into the pallet-return elevator. */
  sinkY: number;
}

/**
 * One station's line-side infeed: pallets carrying a single part type queue up
 * to the stopper at the pick station. Emptied or rejected pallets sink through
 * the belt into an (implied) return line underneath — nothing ever crosses the
 * main transfer line, which eliminates infeed/main-line conflicts entirely.
 */
export class InfeedConveyor {
  readonly group = new Group();

  private readonly pallets: Pallet[] = [];
  private readonly photoEyeLed: MeshStandardMaterial;
  private readonly beltTexture: CanvasTexture;
  private blinkElapsed = 0;

  constructor(
    private readonly station: number,
    private readonly partType: PartType,
  ) {
    this.group.name = `Station ${station} infeed`;
    this.group.position.x = stationOffsetX(station);
    this.beltTexture = createBeltTexture();
    this.photoEyeLed = this.build().photoEyeLed;
  }

  update(dt: number, wallDelta: number): void {
    this.blinkElapsed += wallDelta;
    this.updatePallets(dt);
    this.updatePhotoEye();
  }

  /** The part waiting (settled) on the front pallet at the pick station, if any. */
  getPartAtPickStation(): AssemblyPart | null {
    const front = this.frontPallet();
    if (!front || front.state !== 'holding' || front.dwell < PALLET_READY_DWELL_SECONDS) {
      return null;
    }
    return front.part;
  }

  /** Plan target for the waiting part, in STATION-LOCAL coordinates. */
  createPickTarget(): AssemblyPlanTarget | null {
    const part = this.getPartAtPickStation();
    if (!part) {
      return null;
    }
    const graspPoint = new Vector3();
    part.mesh.getWorldPosition(graspPoint);
    graspPoint.x -= stationOffsetX(this.station);
    graspPoint.y += part.spec.graspHeight;
    return createAssemblyPlanTarget(part.type, graspPoint);
  }

  /** Detach the waiting part (the robot picked it); its pallet sinks away. */
  takePartAtPickStation(): AssemblyPart | null {
    const front = this.frontPallet();
    if (!front?.part) {
      return null;
    }
    const part = front.part;
    front.part = null;
    this.beginSink(front);
    return part;
  }

  /** Send the front pallet away with its part still on it (reject path). */
  rejectFrontPart(): void {
    const front = this.frontPallet();
    if (front) {
      this.beginSink(front);
    }
  }

  private beginSink(pallet: Pallet): void {
    pallet.state = 'sinking';
    pallet.dwell = 0;
  }

  private updatePallets(dt: number): void {
    this.maybeSpawnPallet();

    // Demand-paced belt: rush replenishment while the pick station is empty,
    // run at nominal speed otherwise (queued pallets are parked anyway).
    const starving = this.getPartAtPickStation() === null;
    const beltSpeed = CONVEYOR_SPEED * (starving ? RUSH_FACTOR : 1);

    let beltMoving = false;
    const sorted = [...this.pallets].sort((a, b) => b.group.position.z - a.group.position.z);
    sorted.forEach((pallet, index) => {
      if (pallet.state === 'sinking') {
        pallet.sinkY -= SINK_SPEED * dt;
        pallet.group.position.y = pallet.sinkY;
        return;
      }

      const blocker = sorted
        .slice(0, index)
        .find(
          (candidate) =>
            candidate.state !== 'sinking' || candidate.sinkY > -0.12,
        );
      const stopZ = blocker
        ? Math.min(PICK_STATION_Z, blocker.group.position.z - PALLET_PITCH)
        : PICK_STATION_Z;
      const next = pallet.group.position.z + beltSpeed * dt;

      if (next >= stopZ) {
        pallet.group.position.z = stopZ;
        if (pallet.state !== 'holding') {
          pallet.state = 'holding';
          pallet.dwell = 0;
        } else {
          pallet.dwell += dt;
        }
      } else {
        pallet.group.position.z = next;
        pallet.state = 'feeding';
        pallet.dwell = 0;
        beltMoving = true;
      }
    });

    for (let index = this.pallets.length - 1; index >= 0; index -= 1) {
      const pallet = this.pallets[index];
      if (pallet.state === 'sinking' && pallet.sinkY < SINK_DESPAWN_Y) {
        this.group.remove(pallet.group);
        this.pallets.splice(index, 1);
      }
    }

    if (beltMoving) {
      this.beltTexture.offset.y -= (beltSpeed * dt) / BELT_TEXTURE_WORLD_LENGTH;
    }
  }

  private maybeSpawnPallet(): void {
    // Pull-based replenishment: stop feeding once the target buffer is stocked.
    const active = this.pallets.filter((pallet) => pallet.state !== 'sinking');
    if (active.length >= TARGET_QUEUE) {
      return;
    }
    const tail = active.reduce(
      (min, pallet) => Math.min(min, pallet.group.position.z),
      Number.POSITIVE_INFINITY,
    );
    if (tail < INFEED_START_Z + PALLET_PITCH) {
      return;
    }

    const part = createPart(this.partType);
    const palletGroup = new Group();
    palletGroup.name = 'Part pallet';
    palletGroup.position.set(INFEED_CENTER_X, 0, INFEED_START_Z + 0.05);

    const plate = new Mesh(
      new BoxGeometry(PALLET_SIZE.x, PALLET_SIZE.y, PALLET_SIZE.z),
      palletMaterial,
    );
    plate.position.y = BELT_TOP_Y + PALLET_SIZE.y * 0.5;
    plate.castShadow = true;
    plate.receiveShadow = true;
    palletGroup.add(plate);

    part.mesh.position.set(0, PALLET_TOP_Y, 0);
    palletGroup.add(part.mesh);

    this.group.add(palletGroup);
    this.pallets.push({ group: palletGroup, part, state: 'feeding', dwell: 0, sinkY: 0 });
  }

  private frontPallet(): Pallet | null {
    let front: Pallet | null = null;
    this.pallets.forEach((pallet) => {
      if (pallet.state === 'sinking') {
        return;
      }
      if (!front || pallet.group.position.z > front.group.position.z) {
        front = pallet;
      }
    });
    return front;
  }

  private updatePhotoEye(): void {
    const ready = this.getPartAtPickStation() !== null;
    if (ready) {
      this.photoEyeLed.emissive.setHex(0x19d15e);
      this.photoEyeLed.emissiveIntensity = 2.2;
      return;
    }
    const blink = Math.sin(this.blinkElapsed * 7) > 0;
    this.photoEyeLed.emissive.setHex(0xff7a10);
    this.photoEyeLed.emissiveIntensity = blink ? 2.0 : 0.15;
  }

  // -------------------------------------------------------------------------
  // Visual construction (station-local coordinates inside this.group)
  // -------------------------------------------------------------------------

  private build(): { photoEyeLed: MeshStandardMaterial } {
    const length = INFEED_END_Z - INFEED_START_Z;
    const centerZ = (INFEED_START_Z + INFEED_END_Z) / 2;

    const belt = new Mesh(
      new PlaneGeometry(INFEED_WIDTH, length),
      new MeshStandardMaterial({ map: this.beltTexture, roughness: 0.85, metalness: 0.05 }),
    );
    belt.rotation.x = -Math.PI / 2;
    belt.position.set(INFEED_CENTER_X, BELT_TOP_Y, centerZ);
    belt.receiveShadow = true;
    this.group.add(belt);

    const deck = new Mesh(new BoxGeometry(INFEED_WIDTH + 0.08, 0.05, length), frameMaterial);
    deck.position.set(INFEED_CENTER_X, BELT_TOP_Y - 0.028, centerZ);
    this.group.add(deck);

    for (const side of [-1, 1]) {
      const rail = new Mesh(new BoxGeometry(0.04, 0.06, length), railMaterial);
      rail.position.set(
        INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 + 0.035),
        BELT_TOP_Y,
        centerZ,
      );
      this.group.add(rail);

      const stripe = new Mesh(new BoxGeometry(0.012, 0.012, length - 0.1), ledStripMaterial);
      stripe.position.set(
        INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 + 0.058),
        BELT_TOP_Y + 0.024,
        centerZ,
      );
      this.group.add(stripe);
    }

    for (const endZ of [INFEED_START_Z + 0.03, INFEED_END_Z - 0.03]) {
      const roller = new Mesh(
        new CylinderGeometry(0.045, 0.045, INFEED_WIDTH + 0.04, 24),
        rollerMaterial,
      );
      roller.rotation.z = Math.PI / 2;
      roller.rotation.y = Math.PI / 2;
      roller.position.set(INFEED_CENTER_X, BELT_TOP_Y - 0.045, endZ);
      this.group.add(roller);
    }

    const legCount = 5;
    for (let leg = 0; leg < legCount; leg += 1) {
      const z = INFEED_START_Z + 0.18 + (leg / (legCount - 1)) * (length - 0.36);
      for (const side of [-1, 1]) {
        const column = new Mesh(new BoxGeometry(0.05, BELT_TOP_Y - 0.06, 0.05), frameMaterial);
        column.position.set(
          INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 - 0.02),
          (BELT_TOP_Y - 0.06) * 0.5,
          z,
        );
        this.group.add(column);
      }
      const foot = new Mesh(new BoxGeometry(INFEED_WIDTH + 0.04, 0.02, 0.07), frameMaterial);
      foot.position.set(INFEED_CENTER_X, 0.01, z);
      this.group.add(foot);
    }

    // Pallet-return elevator shroud around the pick station (the sink).
    for (const side of [-1, 1]) {
      const shroud = new Mesh(new BoxGeometry(0.03, 0.16, PALLET_SIZE.z + 0.1), frameMaterial);
      shroud.position.set(
        INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 + 0.095),
        0.08,
        PICK_STATION_Z,
      );
      this.group.add(shroud);
    }

    const stopper = new Mesh(new BoxGeometry(INFEED_WIDTH - 0.04, 0.045, 0.018), stopperMaterial);
    stopper.position.set(
      INFEED_CENTER_X,
      BELT_TOP_Y + 0.025,
      PICK_STATION_Z + PALLET_SIZE.z * 0.5 + 0.035,
    );
    this.group.add(stopper);

    const photoEyeLed = new MeshStandardMaterial({
      color: 0x101314,
      emissive: 0xff7a10,
      emissiveIntensity: 1.6,
    });
    for (const side of [-1, 1]) {
      const post = new Mesh(new BoxGeometry(0.03, 0.16, 0.03), railMaterial);
      post.position.set(
        INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 + 0.085),
        BELT_TOP_Y + 0.06,
        PICK_STATION_Z,
      );
      this.group.add(post);

      const eye = new Mesh(new CylinderGeometry(0.012, 0.012, 0.02, 12), photoEyeLed);
      eye.rotation.z = Math.PI / 2;
      eye.position.set(
        INFEED_CENTER_X + side * (INFEED_WIDTH * 0.5 + 0.07),
        BELT_TOP_Y + 0.12,
        PICK_STATION_Z,
      );
      this.group.add(eye);
    }

    this.group.traverse((child) => {
      if (child instanceof Mesh && child.geometry.type !== 'PlaneGeometry') {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { photoEyeLed };
  }
}

// --- shared materials ---------------------------------------------------------

const frameMaterial = new MeshStandardMaterial({ color: 0x2c3238, metalness: 0.6, roughness: 0.5 });
const railMaterial = new MeshStandardMaterial({ color: 0x50585f, metalness: 0.75, roughness: 0.35 });
const rollerMaterial = new MeshStandardMaterial({ color: 0x878e94, metalness: 0.9, roughness: 0.25 });
// Warm-neutral so the cool key/fill lights cannot push it over the HSV saturation floor.
const palletMaterial = new MeshStandardMaterial({ color: 0x4c4a46, metalness: 0.35, roughness: 0.55 });
const stopperMaterial = new MeshStandardMaterial({ color: 0x5a6168, metalness: 0.55, roughness: 0.4 });
// Low-saturation cool white: stays 'background' for the HSV segmenter.
const ledStripMaterial = new MeshStandardMaterial({
  color: 0x0a0d0f,
  emissive: 0xcfe4f0,
  emissiveIntensity: 1.0,
});

/** World length one repeat of the belt texture covers (for scroll speed). */
const BELT_TEXTURE_WORLD_LENGTH = 0.47;

function createBeltTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#15181b';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = '#242a2f';
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(6, 96);
    context.lineTo(64, 64);
    context.lineTo(122, 96);
    context.stroke();
    context.strokeStyle = '#2e353c';
    context.lineWidth = 4;
    for (const x of [4, 124]) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, 128);
      context.stroke();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1, (INFEED_END_Z - INFEED_START_Z) / BELT_TEXTURE_WORLD_LENGTH);
  return texture;
}
