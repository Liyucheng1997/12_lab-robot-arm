import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  TorusGeometry,
} from 'three';
import { PART_SPECS, type PartSpec, type PartType } from './layout';

/**
 * Procedural meshes for the three wheel-corner parts. Every part is built with
 * its origin at the base center, +y up, and carries a saturated fiducial marker
 * on top of its grip boss so the online vision system can identify it.
 */

export interface AssemblyPart {
  id: string;
  type: PartType;
  spec: PartSpec;
  mesh: Group;
}

// --- shared materials ------------------------------------------------------

const castIronMaterial = new MeshStandardMaterial({
  color: 0x4a4d52,
  metalness: 0.86,
  roughness: 0.42,
});

const machinedSteelMaterial = new MeshStandardMaterial({
  color: 0x9aa2a8,
  metalness: 0.95,
  roughness: 0.24,
});

const alloyMaterial = new MeshPhysicalMaterial({
  color: 0xccd3d8,
  metalness: 0.92,
  roughness: 0.18,
  clearcoat: 0.6,
  clearcoatRoughness: 0.18,
});

const alloyDarkMaterial = new MeshStandardMaterial({
  color: 0x51565c,
  metalness: 0.85,
  roughness: 0.34,
});

const tireMaterial = new MeshStandardMaterial({
  color: 0x141618,
  metalness: 0.0,
  roughness: 0.92,
});

const brassMaterial = new MeshStandardMaterial({
  color: 0xc9a23f,
  metalness: 0.94,
  roughness: 0.28,
});

const darkDetailMaterial = new MeshStandardMaterial({
  color: 0x17191b,
  metalness: 0.4,
  roughness: 0.6,
});

/** Fiducial markers are unlit so their hue stays saturated for HSV segmentation. */
const markerMaterials = {
  red: new MeshBasicMaterial({ color: 0xff2418 }),
  blue: new MeshBasicMaterial({ color: 0x1f5dff }),
  yellow: new MeshBasicMaterial({ color: 0xffd60a }),
};

// --- part builders ----------------------------------------------------------

let partSequence = 0;

export function createPart(type: PartType): AssemblyPart {
  partSequence += 1;
  const spec = PART_SPECS[type];
  const mesh = buildMesh(type, spec);
  mesh.name = `${type} part`;
  mesh.traverse((child) => {
    if (child instanceof Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return { id: `${type.toUpperCase()}-${partSequence}`, type, spec, mesh };
}

function buildMesh(type: PartType, spec: PartSpec): Group {
  switch (type) {
    case 'disc':
      return buildBrakeDisc(spec);
    case 'wheel':
      return buildWheel(spec);
    case 'nut':
      return buildHubNut(spec);
  }
}

/** Ventilated brake disc: cast rotor, machined center hat, drilled cooling holes. */
function buildBrakeDisc(spec: PartSpec): Group {
  const group = new Group();

  const rotor = new Mesh(new CylinderGeometry(0.15, 0.15, 0.024, 56), castIronMaterial);
  rotor.position.y = 0.012;
  group.add(rotor);

  const frictionRing = new Mesh(new TorusGeometry(0.118, 0.0035, 8, 56), darkDetailMaterial);
  frictionRing.rotation.x = Math.PI / 2;
  frictionRing.position.y = 0.0245;
  group.add(frictionRing);

  for (let hole = 0; hole < 12; hole += 1) {
    const angle = (hole / 12) * Math.PI * 2;
    const drill = new Mesh(new CylinderGeometry(0.0075, 0.0075, 0.027, 12), darkDetailMaterial);
    drill.position.set(Math.cos(angle) * 0.108, 0.012, Math.sin(angle) * 0.108);
    group.add(drill);
  }

  const hat = new Mesh(new CylinderGeometry(0.07, 0.072, 0.05, 40), machinedSteelMaterial);
  hat.position.y = 0.024 + 0.025;
  group.add(hat);

  for (let stud = 0; stud < 5; stud += 1) {
    const angle = (stud / 5) * Math.PI * 2;
    const bore = new Mesh(new CylinderGeometry(0.0065, 0.0065, 0.004, 10), darkDetailMaterial);
    bore.position.set(Math.cos(angle) * 0.045, 0.0742, Math.sin(angle) * 0.045);
    group.add(bore);
  }

  group.add(createMarker(spec, 0.05));
  return group;
}

/** Wheel assembly: tire, alloy barrel, five spokes, center grip boss. */
function buildWheel(spec: PartSpec): Group {
  const group = new Group();

  const tire = new Mesh(new TorusGeometry(0.145, 0.052, 22, 56), tireMaterial);
  tire.rotation.x = Math.PI / 2;
  tire.position.y = 0.06;
  group.add(tire);

  const barrel = new Mesh(new CylinderGeometry(0.1, 0.105, 0.11, 48, 1, true), alloyDarkMaterial);
  barrel.position.y = 0.06;
  group.add(barrel);

  const face = new Mesh(new CylinderGeometry(0.104, 0.104, 0.012, 48), alloyMaterial);
  face.position.y = 0.109;
  group.add(face);

  const lip = new Mesh(new TorusGeometry(0.103, 0.007, 10, 48), alloyMaterial);
  lip.rotation.x = Math.PI / 2;
  lip.position.y = 0.115;
  group.add(lip);

  for (let spoke = 0; spoke < 5; spoke += 1) {
    const angle = (spoke / 5) * Math.PI * 2;
    const blade = new Mesh(new BoxGeometry(0.085, 0.02, 0.034), alloyMaterial);
    blade.position.set(Math.cos(angle) * 0.058, 0.122, Math.sin(angle) * 0.058);
    blade.rotation.y = -angle;
    group.add(blade);

    const lug = new Mesh(new CylinderGeometry(0.009, 0.009, 0.007, 6), machinedSteelMaterial);
    const lugAngle = angle + Math.PI / 5;
    lug.position.set(Math.cos(lugAngle) * 0.045, 0.135, Math.sin(lugAngle) * 0.045);
    group.add(lug);
  }

  const boss = new Mesh(new CylinderGeometry(0.065, 0.068, 0.045, 36), alloyMaterial);
  boss.position.y = 0.115 + 0.0225;
  group.add(boss);

  group.add(createMarker(spec, 0.048));
  return group;
}

/** Center-lock hub nut: flanged brass hex. */
function buildHubNut(spec: PartSpec): Group {
  const group = new Group();

  const flange = new Mesh(new CylinderGeometry(0.06, 0.062, 0.01, 32), brassMaterial);
  flange.position.y = 0.005;
  group.add(flange);

  const hex = new Mesh(new CylinderGeometry(0.05, 0.05, 0.035, 6), brassMaterial);
  hex.position.y = 0.01 + 0.0175;
  group.add(hex);

  group.add(createMarker(spec, 0.045));
  return group;
}

/** Solid unlit color cap on top of the grip boss — the vision fiducial. */
function createMarker(spec: PartSpec, radius: number): Mesh {
  const marker = new Mesh(
    new CylinderGeometry(radius, radius, 0.003, 32),
    markerMaterials[spec.markerColor],
  );
  marker.name = `${spec.type} fiducial marker`;
  marker.position.y = spec.markerHeight - 0.0015;
  return marker;
}
