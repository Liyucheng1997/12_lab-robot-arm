import {
  CanvasTexture,
  CylinderGeometry,
  BoxGeometry,
  Fog,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PMREMGenerator,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { STATION_COUNT, stationOffsetX } from '../assembly/layout';

export type AndonState = 'idle' | 'running' | 'fault';

export interface FactoryDecor {
  group: Group;
  /** Andon tower per station. */
  setAndonState(station: number, state: AndonState): void;
  update(delta: number): void;
}

/** The factory hall spans roughly x ∈ [-2, 7.2]; decor is centered on it. */
const HALL_CENTER_X = 2.2;
const FLOOR_SIZE = 20;

/** Image-based lighting + depth fog for convincing metals and scene depth. */
export function applyFactoryAtmosphere(scene: Scene, renderer: WebGLRenderer): void {
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.38;
  scene.fog = new Fog(0x10141a, 12, 38);
  pmrem.dispose();
}

/** Epoxy floor, safety fencing, andon towers, ceiling luminaires, cable trays. */
export function createFactoryDecor(): FactoryDecor {
  const group = new Group();
  group.name = 'Factory decor';

  group.add(createFloor());
  group.add(createFencing());
  group.add(createCeilingLights());
  group.add(createCableTrays());
  group.add(createCellSign());

  const andons = Array.from({ length: STATION_COUNT }, (_, station) =>
    createAndonTower(stationOffsetX(station), 1.75),
  );
  andons.forEach((andon) => group.add(andon.group));

  return {
    group,
    setAndonState(station: number, state: AndonState): void {
      andons[station]?.setState(state);
    },
    update(delta: number): void {
      andons.forEach((andon) => andon.update(delta));
    },
  };
}

// ---------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------

function createFloor(): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 1536;
  canvas.height = 1536;
  const context = canvas.getContext('2d');
  if (context) {
    drawFloorTexture(context);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;

  const floor = new Mesh(
    new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
    new MeshStandardMaterial({ map: texture, roughness: 0.55, metalness: 0.16 }),
  );
  floor.name = 'Factory floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.x = HALL_CENTER_X;
  floor.receiveShadow = true;
  return floor;
}

/** Canvas mapped onto FLOOR_SIZE² m centered at HALL_CENTER_X: epoxy, seams, hazard border. */
function drawFloorTexture(context: CanvasRenderingContext2D): void {
  const size = 1536;
  const PX_PER_M = size / FLOOR_SIZE;
  context.fillStyle = '#22262a';
  context.fillRect(0, 0, size, size);

  // Speckled epoxy noise.
  for (let i = 0; i < 9000; i += 1) {
    const shade = 30 + Math.floor(Math.random() * 26);
    context.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
    context.fillRect(Math.random() * size, Math.random() * size, 1.6, 1.6);
  }

  // Tile seams every 1.5 m.
  context.strokeStyle = 'rgba(12,14,16,0.55)';
  context.lineWidth = 2;
  for (let m = 0; m <= FLOOR_SIZE; m += 1.5) {
    const p = m * PX_PER_M;
    context.beginPath();
    context.moveTo(p, 0);
    context.lineTo(p, size);
    context.stroke();
    context.beginPath();
    context.moveTo(0, p);
    context.lineTo(size, p);
    context.stroke();
  }

  // World (x,z) → canvas, with the floor centered at (HALL_CENTER_X, 0).
  const worldToCanvas = (x: number, z: number): [number, number] => [
    size / 2 + (x - HALL_CENTER_X) * PX_PER_M,
    size / 2 + z * PX_PER_M,
  ];

  // Hazard border around the whole line cell.
  const [x0, z0] = worldToCanvas(-1.9, -3.0);
  const [x1, z1] = worldToCanvas(6.9, 3.0);
  context.save();
  context.strokeStyle = '#8a6d10';
  context.lineWidth = 9;
  context.setLineDash([34, 22]);
  context.strokeRect(x0, z0, x1 - x0, z1 - z0);
  context.restore();

  // Walkway lane along the operator side.
  const [wx0] = worldToCanvas(7.8, 0);
  const [wx1] = worldToCanvas(8.6, 0);
  context.fillStyle = 'rgba(46,60,52,0.7)';
  context.fillRect(wx0, 0, wx1 - wx0, size);
  context.strokeStyle = 'rgba(150,158,164,0.35)';
  context.lineWidth = 5;
  context.setLineDash([48, 30]);
  for (const x of [wx0 + 4, wx1 - 4]) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, size);
    context.stroke();
  }
  context.setLineDash([]);
}

// ---------------------------------------------------------------------------
// Safety fencing (three sides; the operator side +x stays open)
// ---------------------------------------------------------------------------

const fencePostMaterial = new MeshStandardMaterial({ color: 0xd8b117, metalness: 0.35, roughness: 0.5 });
const fencePanelMaterial = new MeshStandardMaterial({
  color: 0x9fb6c4,
  metalness: 0.25,
  roughness: 0.32,
  transparent: true,
  opacity: 0.16,
});
const fenceFrameMaterial = new MeshStandardMaterial({ color: 0x30363c, metalness: 0.6, roughness: 0.45 });

function createFencing(): Group {
  const fence = new Group();
  fence.name = 'Safety fencing';

  // Back run (behind the robots) along z at x = -2.0.
  addFenceRun(fence, -2.0, -3.1, -2.0, 3.1);
  // Long side runs along the line.
  addFenceRun(fence, -2.0, -3.1, 7.0, -3.1);
  addFenceRun(fence, -2.0, 3.1, 7.0, 3.1);
  return fence;
}

function addFenceRun(parent: Group, x0: number, z0: number, x1: number, z1: number): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.hypot(dx, dz);
  const segments = Math.max(1, Math.round(length / 1.5));
  const angle = Math.atan2(dx, dz);

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const post = new Mesh(new CylinderGeometry(0.035, 0.04, 1.15, 12), fencePostMaterial);
    post.position.set(x0 + dx * t, 0.575, z0 + dz * t);
    post.castShadow = true;
    parent.add(post);
  }

  const segmentLength = length / segments;
  for (let i = 0; i < segments; i += 1) {
    const t = (i + 0.5) / segments;
    const panel = new Mesh(new BoxGeometry(0.02, 0.85, segmentLength - 0.12), fencePanelMaterial);
    panel.position.set(x0 + dx * t, 0.62, z0 + dz * t);
    panel.rotation.y = angle;
    parent.add(panel);

    const kick = new Mesh(new BoxGeometry(0.03, 0.12, segmentLength - 0.1), fencePostMaterial);
    kick.position.set(x0 + dx * t, 0.115, z0 + dz * t);
    kick.rotation.y = angle;
    parent.add(kick);

    const topRail = new Mesh(new BoxGeometry(0.035, 0.035, segmentLength - 0.05), fenceFrameMaterial);
    topRail.position.set(x0 + dx * t, 1.08, z0 + dz * t);
    topRail.rotation.y = angle;
    parent.add(topRail);
  }
}

// ---------------------------------------------------------------------------
// Ceiling luminaires (decorative emissive fixtures)
// ---------------------------------------------------------------------------

function createCeilingLights(): Group {
  const lights = new Group();
  lights.name = 'Ceiling luminaires';
  const housing = new MeshStandardMaterial({ color: 0x272c30, metalness: 0.5, roughness: 0.6 });
  const lit = new MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xf2f7ff,
    emissiveIntensity: 2.6,
  });

  for (const z of [-1.8, 1.8]) {
    for (let column = 0; column < 4; column += 1) {
      const x = -1.0 + column * 2.2;
      const body = new Mesh(new BoxGeometry(1.5, 0.08, 0.24), housing);
      body.position.set(x, 3.9, z);
      lights.add(body);
      const tube = new Mesh(new BoxGeometry(1.36, 0.02, 0.14), lit);
      tube.position.set(x, 3.85, z);
      lights.add(tube);
      const stem = new Mesh(new CylinderGeometry(0.015, 0.015, 0.5, 8), housing);
      stem.position.set(x, 4.19, z);
      lights.add(stem);
    }
  }
  return lights;
}

// ---------------------------------------------------------------------------
// Cable trays from each robot pedestal toward its infeed
// ---------------------------------------------------------------------------

function createCableTrays(): Group {
  const trays = new Group();
  trays.name = 'Cable trays';
  const trayMaterial = new MeshStandardMaterial({ color: 0x383f45, metalness: 0.6, roughness: 0.5 });
  const cableMaterial = new MeshStandardMaterial({ color: 0x101315, metalness: 0.1, roughness: 0.85 });

  for (let station = 0; station < STATION_COUNT; station += 1) {
    const dx = stationOffsetX(station);
    const run = new Mesh(new BoxGeometry(0.9, 0.035, 0.16), trayMaterial);
    run.position.set(dx + 0.28, 0.018, -0.7);
    run.rotation.y = -0.35;
    run.castShadow = true;
    trays.add(run);

    for (let i = 0; i < 3; i += 1) {
      const cable = new Mesh(new CylinderGeometry(0.014, 0.014, 0.88, 8), cableMaterial);
      cable.rotation.z = Math.PI / 2;
      cable.rotation.y = -0.35;
      cable.position.set(dx + 0.28, 0.05, -0.74 + i * 0.04);
      trays.add(cable);
    }
  }
  return trays;
}

// ---------------------------------------------------------------------------
// Line sign
// ---------------------------------------------------------------------------

function createCellSign(): Group {
  const sign = new Group();
  sign.name = 'Line sign';

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#0b1a24';
    context.fillRect(0, 0, 640, 128);
    context.strokeStyle = '#1f5d7a';
    context.lineWidth = 6;
    context.strokeRect(4, 4, 632, 120);
    context.fillStyle = '#41d7ff';
    context.font = '700 52px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('轮毂装配线 LINE-01 · 三机协同', 320, 82);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const board = new Mesh(new PlaneGeometry(2.6, 0.52), new MeshBasicMaterial({ map: texture }));
  board.position.set(-1.96, 2.1, 0);
  board.rotation.y = Math.PI / 2;
  sign.add(board);
  return sign;
}

// ---------------------------------------------------------------------------
// Andon tower
// ---------------------------------------------------------------------------

interface AndonTower {
  group: Group;
  setState(state: AndonState): void;
  update(delta: number): void;
}

function createAndonTower(baseX: number, baseZ: number): AndonTower {
  const group = new Group();
  group.name = 'Andon tower';

  const pole = new Mesh(
    new CylinderGeometry(0.022, 0.028, 1.05, 14),
    new MeshStandardMaterial({ color: 0x2c3237, metalness: 0.65, roughness: 0.4 }),
  );
  pole.position.set(baseX, 0.525, baseZ);
  pole.castShadow = true;
  group.add(pole);

  const lampSpecs: { color: number; y: number }[] = [
    { color: 0xff2f24, y: 1.32 },
    { color: 0xffa21a, y: 1.2 },
    { color: 0x1ed760, y: 1.08 },
  ];
  const lamps = lampSpecs.map((spec) => {
    const material = new MeshStandardMaterial({
      color: 0x15181a,
      emissive: spec.color,
      emissiveIntensity: 0.08,
      roughness: 0.35,
    });
    const lamp = new Mesh(new CylinderGeometry(0.05, 0.05, 0.11, 20), material);
    lamp.position.set(baseX, spec.y, baseZ);
    group.add(lamp);
    return { material, color: spec.color };
  });
  const cap = new Mesh(
    new CylinderGeometry(0.052, 0.052, 0.02, 20),
    new MeshStandardMaterial({ color: 0x1a1e21, metalness: 0.6, roughness: 0.4 }),
  );
  cap.position.set(baseX, 1.39, baseZ);
  group.add(cap);

  let state: AndonState = 'idle';
  let elapsed = 0;
  const [red, amber, green] = lamps;

  const apply = (): void => {
    const pulse = 0.6 + 0.4 * Math.sin(elapsed * 5);
    red.material.emissiveIntensity = state === 'fault' ? 1.4 + pulse : 0.06;
    amber.material.emissiveIntensity = state === 'idle' ? 1.5 : 0.06;
    green.material.emissiveIntensity = state === 'running' ? 1.6 + pulse * 0.5 : 0.06;
  };

  apply();
  return {
    group,
    setState(next: AndonState): void {
      state = next;
      apply();
    },
    update(delta: number): void {
      elapsed += delta;
      if (state !== 'idle') {
        apply();
      }
    },
  };
}
