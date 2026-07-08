import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from 'three';
import {
  BELT_TOP_Y,
  CARRIER_PITCH,
  CARRIER_PLATE_SIZE,
  CARRIER_TOP_Y,
  HUB_MOUNT_TOP_Y,
  MAIN_DESPAWN_X,
  MAIN_HOOD_X,
  MAIN_LINE_END_X,
  MAIN_LINE_SPEED,
  MAIN_LINE_START_X,
  MAIN_LINE_WIDTH,
  MAIN_LINE_Z,
  STATION_COUNT,
  carrierStopX,
  stackBaseY,
} from './layout';
import type { AssemblyPart } from './parts';

const CARRIER_READY_DWELL_SECONDS = 0.4;
const SETTLE_DURATION_SECONDS = 0.5;
const FASTEN_DURATION_SECONDS = 0.9;
/**
 * Pull-based carrier feed: at most one empty carrier being worked at ST1 plus
 * one staged behind it. Downstream carriers are already paced by the release
 * interlock, so this cap keeps the line head from piling up with empties.
 */
const MAX_EMPTY_CARRIERS = 2;

interface SettleAnimation {
  part: AssemblyPart;
  fromY: number;
  toY: number;
  elapsed: number;
  onSeated: () => void;
}

interface FastenAnimation {
  part: AssemblyPart;
  elapsed: number;
  onDone: () => void;
}

interface Carrier {
  group: Group;
  installed: AssemblyPart[];
  /** Next station index this carrier must visit; STATION_COUNT = heading to exit. */
  nextStation: number;
  dwell: number;
  settle: SettleAnimation | null;
  fasten: FastenAnimation | null;
}

/**
 * The main transfer line: wheel carriers ride from station to station, stop at
 * each assembly point, and only advance once the owning station releases them.
 * This release interlock — plus the minimum carrier gap — is what lets three
 * robots work simultaneously without ever fighting over a carrier.
 */
export class MainLine {
  readonly group = new Group();

  private readonly carriers: Carrier[] = [];
  private readonly beltTexture: CanvasTexture;
  private outputCount = 0;
  private lastCompletionAt: number | null = null;
  private taktSecondsTotal = 0;

  constructor() {
    this.group.name = 'Main transfer line';
    this.beltTexture = createMainBeltTexture();
    this.build();
  }

  update(dt: number): void {
    this.maybeSpawnCarrier();

    let beltMoving = false;
    const sorted = [...this.carriers].sort((a, b) => b.group.position.x - a.group.position.x);
    sorted.forEach((carrier, index) => {
      this.updateSettle(carrier, dt);
      this.updateFasten(carrier, dt);

      const targetX =
        carrier.nextStation < STATION_COUNT
          ? carrierStopX(carrier.nextStation)
          : MAIN_LINE_END_X + 0.5;
      const ahead = sorted[index - 1];
      const maxX = ahead ? ahead.group.position.x - CARRIER_PITCH : Number.POSITIVE_INFINITY;
      const next = Math.min(carrier.group.position.x + MAIN_LINE_SPEED * dt, targetX, maxX);

      if (next > carrier.group.position.x + 1e-6) {
        carrier.group.position.x = next;
        carrier.dwell = 0;
        beltMoving = true;
      } else if (Math.abs(carrier.group.position.x - targetX) < 1e-4) {
        carrier.dwell += dt;
      }
    });

    for (let index = this.carriers.length - 1; index >= 0; index -= 1) {
      const carrier = this.carriers[index];
      if (carrier.group.position.x > MAIN_DESPAWN_X) {
        this.group.remove(carrier.group);
        this.carriers.splice(index, 1);
        if (carrier.installed.length === STATION_COUNT) {
          this.recordCompletion();
        }
      }
    }

    if (beltMoving) {
      this.beltTexture.offset.x += (MAIN_LINE_SPEED * dt) / BELT_TEXTURE_WORLD_LENGTH;
    }
  }

  // -------------------------------------------------------------------------
  // Station-facing API
  // -------------------------------------------------------------------------

  /** The carrier parked and settled at station k, ready to be worked on. */
  getCarrierAtStation(station: number): boolean {
    return this.carrierAt(station) !== null;
  }

  /** Number of parts already installed on the carrier at station k (-1 if none). */
  getCarrierProgress(station: number): number {
    const carrier = this.carrierAt(station);
    return carrier ? carrier.installed.length : -1;
  }

  /** Drop the part onto the carrier at station k; settles in a short animation. */
  beginPlace(station: number, part: AssemblyPart, onSeated: () => void): boolean {
    const carrier = this.carrierAt(station);
    if (!carrier) {
      return false;
    }
    const world = new Vector3();
    part.mesh.getWorldPosition(world);
    carrier.group.add(part.mesh);
    part.mesh.quaternion.identity();
    part.mesh.position.set(0, world.y, 0);
    carrier.settle = {
      part,
      fromY: world.y,
      toY: stackBaseY(part.type),
      elapsed: 0,
      onSeated,
    };
    return true;
  }

  /** Spin the seated nut on the carrier at station k to torque it down. */
  beginFasten(station: number, onDone: () => void): void {
    const carrier = this.carrierAt(station);
    const nut = carrier?.installed.find((part) => part.type === 'nut') ?? null;
    if (!carrier || !nut) {
      onDone();
      return;
    }
    carrier.fasten = { part: nut, elapsed: 0, onDone };
  }

  /** Release the carrier from station k so it advances to the next stop. */
  release(station: number): void {
    const carrier = this.carrierAt(station, true);
    if (carrier && carrier.nextStation === station) {
      carrier.nextStation = station + 1;
      carrier.dwell = 0;
    }
  }

  /** World position above the carrier stack at station k, for effects. */
  getStackTopPosition(station: number): Vector3 {
    const carrier = this.carrierAt(station, true);
    const top = carrier
      ? HUB_MOUNT_TOP_Y + carrier.installed.reduce((sum, part) => sum + part.spec.stackHeight, 0)
      : HUB_MOUNT_TOP_Y;
    return new Vector3(carrierStopX(station), top + 0.05, MAIN_LINE_Z);
  }

  getOutputCount(): number {
    return this.outputCount;
  }

  /** Mean seconds between finished assemblies; null before the second one. */
  getAvgTaktSeconds(): number | null {
    return this.outputCount > 1 ? this.taktSecondsTotal / (this.outputCount - 1) : null;
  }

  getWipCount(): number {
    return this.carriers.length;
  }

  resetStats(): void {
    this.outputCount = 0;
    this.lastCompletionAt = null;
    this.taktSecondsTotal = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private carrierAt(station: number, ignoreReadiness = false): Carrier | null {
    const stopX = carrierStopX(station);
    for (const carrier of this.carriers) {
      if (carrier.nextStation !== station) {
        continue;
      }
      if (Math.abs(carrier.group.position.x - stopX) > 1e-3) {
        continue;
      }
      if (
        !ignoreReadiness &&
        (carrier.dwell < CARRIER_READY_DWELL_SECONDS || carrier.settle || carrier.fasten)
      ) {
        return null;
      }
      return carrier;
    }
    return null;
  }

  private recordCompletion(): void {
    this.outputCount += 1;
    const now = Date.now();
    if (this.lastCompletionAt !== null) {
      this.taktSecondsTotal += (now - this.lastCompletionAt) / 1000;
    }
    this.lastCompletionAt = now;
  }

  private maybeSpawnCarrier(): void {
    const empties = this.carriers.filter((carrier) => carrier.nextStation === 0).length;
    if (empties >= MAX_EMPTY_CARRIERS) {
      return;
    }
    const tail = this.carriers.reduce(
      (min, carrier) => Math.min(min, carrier.group.position.x),
      Number.POSITIVE_INFINITY,
    );
    if (tail < MAIN_LINE_START_X + CARRIER_PITCH) {
      return;
    }
    this.carriers.push(this.createCarrier());
  }

  private createCarrier(): Carrier {
    const group = new Group();
    group.name = 'Wheel carrier';
    group.position.set(MAIN_LINE_START_X + 0.1, 0, MAIN_LINE_Z);

    const plate = new Mesh(
      new BoxGeometry(CARRIER_PLATE_SIZE.x, CARRIER_PLATE_SIZE.y, CARRIER_PLATE_SIZE.z),
      carrierMaterial,
    );
    plate.position.y = (BELT_TOP_Y + CARRIER_TOP_Y) * 0.5;
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);

    const hubMount = new Mesh(
      new CylinderGeometry(0.08, 0.095, HUB_MOUNT_TOP_Y - CARRIER_TOP_Y, 36),
      machinedMaterial,
    );
    hubMount.position.y = (HUB_MOUNT_TOP_Y + CARRIER_TOP_Y) * 0.5;
    hubMount.castShadow = true;
    group.add(hubMount);

    const stub = new Mesh(new CylinderGeometry(0.022, 0.022, 0.05, 20), machinedMaterial);
    stub.position.y = HUB_MOUNT_TOP_Y + 0.02;
    group.add(stub);

    for (let clamp = 0; clamp < 4; clamp += 1) {
      const angle = (clamp / 4) * Math.PI * 2 + Math.PI / 4;
      const claw = new Mesh(new BoxGeometry(0.05, 0.035, 0.028), clampMaterial);
      claw.position.set(Math.cos(angle) * 0.135, CARRIER_TOP_Y + 0.016, Math.sin(angle) * 0.135);
      claw.rotation.y = -angle;
      claw.castShadow = true;
      group.add(claw);
    }

    this.group.add(group);
    return { group, installed: [], nextStation: 0, dwell: 0, settle: null, fasten: null };
  }

  private updateSettle(carrier: Carrier, dt: number): void {
    if (!carrier.settle) {
      return;
    }
    carrier.settle.elapsed += dt;
    const t = Math.min(carrier.settle.elapsed / SETTLE_DURATION_SECONDS, 1);
    const eased = 1 - (1 - t) * (1 - t);
    carrier.settle.part.mesh.position.y =
      carrier.settle.fromY + (carrier.settle.toY - carrier.settle.fromY) * eased;
    if (t >= 1) {
      const finished = carrier.settle;
      carrier.settle = null;
      carrier.installed.push(finished.part);
      finished.onSeated();
    }
  }

  private updateFasten(carrier: Carrier, dt: number): void {
    if (!carrier.fasten) {
      return;
    }
    carrier.fasten.elapsed += dt;
    const t = Math.min(carrier.fasten.elapsed / FASTEN_DURATION_SECONDS, 1);
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    carrier.fasten.part.mesh.rotation.y = eased * Math.PI * 4;
    if (t >= 1) {
      const finished = carrier.fasten;
      carrier.fasten = null;
      finished.onDone();
    }
  }

  // -------------------------------------------------------------------------
  // Visual construction
  // -------------------------------------------------------------------------

  private build(): void {
    const length = MAIN_LINE_END_X - MAIN_LINE_START_X;
    const centerX = (MAIN_LINE_START_X + MAIN_LINE_END_X) / 2;

    const belt = new Mesh(
      new PlaneGeometry(length, MAIN_LINE_WIDTH),
      new MeshStandardMaterial({ map: this.beltTexture, roughness: 0.85, metalness: 0.05 }),
    );
    belt.rotation.x = -Math.PI / 2;
    belt.position.set(centerX, BELT_TOP_Y, MAIN_LINE_Z);
    belt.receiveShadow = true;
    this.group.add(belt);

    const deck = new Mesh(new BoxGeometry(length, 0.05, MAIN_LINE_WIDTH + 0.08), frameMaterial);
    deck.position.set(centerX, BELT_TOP_Y - 0.028, MAIN_LINE_Z);
    this.group.add(deck);

    for (const side of [-1, 1]) {
      const guide = new Mesh(new BoxGeometry(length, 0.06, 0.04), railMaterial);
      guide.position.set(centerX, BELT_TOP_Y, MAIN_LINE_Z + side * (MAIN_LINE_WIDTH * 0.5 + 0.035));
      this.group.add(guide);

      const stripe = new Mesh(new BoxGeometry(length - 0.1, 0.012, 0.012), ledStripMaterial);
      stripe.position.set(
        centerX,
        BELT_TOP_Y + 0.024,
        MAIN_LINE_Z + side * (MAIN_LINE_WIDTH * 0.5 + 0.058),
      );
      this.group.add(stripe);
    }

    const legCount = 10;
    for (let leg = 0; leg < legCount; leg += 1) {
      const x = MAIN_LINE_START_X + 0.25 + (leg / (legCount - 1)) * (length - 0.5);
      for (const side of [-1, 1]) {
        const column = new Mesh(new BoxGeometry(0.05, BELT_TOP_Y - 0.06, 0.05), frameMaterial);
        column.position.set(
          x,
          (BELT_TOP_Y - 0.06) * 0.5,
          MAIN_LINE_Z + side * (MAIN_LINE_WIDTH * 0.5 - 0.02),
        );
        this.group.add(column);
      }
    }

    // Station stop markers (small yellow pucks beside each stop).
    for (let station = 0; station < STATION_COUNT; station += 1) {
      const marker = new Mesh(new BoxGeometry(0.06, 0.02, 0.12), stopMarkerMaterial);
      marker.position.set(
        carrierStopX(station),
        BELT_TOP_Y + 0.01,
        MAIN_LINE_Z + MAIN_LINE_WIDTH * 0.5 + 0.11,
      );
      this.group.add(marker);
    }

    const hood = new Mesh(
      new BoxGeometry(0.3, 0.4, MAIN_LINE_WIDTH + 0.16),
      hoodMaterial,
    );
    hood.position.set(MAIN_HOOD_X, BELT_TOP_Y + 0.2, MAIN_LINE_Z);
    this.group.add(hood);

    const hoodSign = new Mesh(new PlaneGeometry(0.34, 0.13), createHoodSignMaterial());
    hoodSign.position.set(MAIN_HOOD_X - 0.151, BELT_TOP_Y + 0.22, MAIN_LINE_Z);
    hoodSign.rotation.y = -Math.PI / 2;
    this.group.add(hoodSign);

    this.group.traverse((child) => {
      if (child instanceof Mesh && child.geometry.type !== 'PlaneGeometry') {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }
}

// --- shared materials ---------------------------------------------------------

const frameMaterial = new MeshStandardMaterial({ color: 0x2c3238, metalness: 0.6, roughness: 0.5 });
const railMaterial = new MeshStandardMaterial({ color: 0x50585f, metalness: 0.75, roughness: 0.35 });
const carrierMaterial = new MeshStandardMaterial({ color: 0x596470, metalness: 0.7, roughness: 0.32 });
const machinedMaterial = new MeshStandardMaterial({ color: 0xaab2b8, metalness: 0.95, roughness: 0.2 });
const clampMaterial = new MeshStandardMaterial({ color: 0x33302e, metalness: 0.45, roughness: 0.5 });
const hoodMaterial = new MeshStandardMaterial({ color: 0x333a41, metalness: 0.55, roughness: 0.4 });
const stopMarkerMaterial = new MeshStandardMaterial({ color: 0x8a6d10, metalness: 0.3, roughness: 0.6 });
const ledStripMaterial = new MeshStandardMaterial({
  color: 0x0a0d0f,
  emissive: 0xcfe4f0,
  emissiveIntensity: 1.0,
});

const BELT_TEXTURE_WORLD_LENGTH = 0.47;

function createMainBeltTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#191c1f';
    context.fillRect(0, 0, 128, 128);
    context.strokeStyle = '#272d33';
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(96, 6);
    context.lineTo(64, 64);
    context.lineTo(96, 122);
    context.stroke();
    context.strokeStyle = '#31383f';
    context.lineWidth = 4;
    for (const y of [4, 124]) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(128, y);
      context.stroke();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set((MAIN_LINE_END_X - MAIN_LINE_START_X) / BELT_TEXTURE_WORLD_LENGTH, 1);
  return texture;
}

function createHoodSignMaterial(): MeshBasicMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#101417';
    context.fillRect(0, 0, 256, 96);
    context.fillStyle = '#ff8c1a';
    context.font = '700 40px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('成品下线', 128, 62);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return new MeshBasicMaterial({ map: texture });
}
