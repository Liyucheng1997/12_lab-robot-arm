import { Box3, Vector3 } from 'three';
import type { StaticObstacle } from '../robot/collision';
import type { DetectionColor } from '../vision/VisionSystem';

/**
 * Pure geometry of the three-station wheel assembly line. Every station reuses
 * the reachability-proven single-cell layout in its own LOCAL frame; a station
 * is placed in the world by translating +x by `stationOffsetX(k)`. Robots plan
 * in station-local coordinates (the kinematics assume a fixed base offset), so
 * world obstacles are translated into the local frame per station.
 *
 * Conflict handling by construction:
 * - Stations are pitched wider than a single arm's working envelope, so two
 *   robots can move simultaneously without sharing space; neighbor equipment
 *   and robot columns are still modeled as planning obstacles for safety.
 * - Carriers on the main line only advance once the owning station releases
 *   them, and a station only acts when both its part and its carrier are ready.
 *
 * All lengths in meters, +y up.
 */

export type PartType = 'disc' | 'wheel' | 'nut';

/** Process order along the line; station k installs ASSEMBLY_SEQUENCE[k]. */
export const ASSEMBLY_SEQUENCE: PartType[] = ['disc', 'wheel', 'nut'];
export const STATION_COUNT = ASSEMBLY_SEQUENCE.length;
/** Center-to-center spacing between stations along x. */
export const STATION_PITCH = 2.2;

export function stationOffsetX(station: number): number {
  return station * STATION_PITCH;
}

export interface PartSpec {
  type: PartType;
  /** Operator-facing name shown in HUD / status display. */
  label: string;
  /** Fiducial marker color the vision system identifies the part by. */
  markerColor: DetectionColor;
  /** Gripper closed opening when clamping the grip boss. */
  gripDiameter: number;
  /** Grasp point (grip boss center) height above the part origin (base center). */
  graspHeight: number;
  /** Height of the fiducial marker face above the part origin. */
  markerHeight: number;
  /** Vertical space the part occupies once seated on the stack. */
  stackHeight: number;
}

export const PART_SPECS: Record<PartType, PartSpec> = {
  disc: {
    type: 'disc',
    label: '刹车盘',
    markerColor: 'red',
    gripDiameter: 0.14,
    graspHeight: 0.049,
    markerHeight: 0.074,
    stackHeight: 0.074,
  },
  wheel: {
    type: 'wheel',
    label: '轮毂总成',
    markerColor: 'blue',
    gripDiameter: 0.13,
    graspHeight: 0.14,
    markerHeight: 0.165,
    stackHeight: 0.165,
  },
  nut: {
    type: 'nut',
    label: '锁紧螺母',
    markerColor: 'yellow',
    gripDiameter: 0.1,
    graspHeight: 0.026,
    markerHeight: 0.045,
    stackHeight: 0.045,
  },
};

export const PART_TYPE_BY_MARKER: Record<DetectionColor, PartType> = {
  red: 'disc',
  blue: 'wheel',
  yellow: 'nut',
};

// ---------------------------------------------------------------------------
// Station-local infeed conveyor — runs along z, parts stop near local z = 0.
// (Identical to the proven single-cell geometry.)
// ---------------------------------------------------------------------------

export const INFEED_CENTER_X = 1.12;
export const BELT_TOP_Y = 0.25;
export const INFEED_WIDTH = 0.46;
export const INFEED_START_Z = -2.4;
/** The infeed ends short of the main line; empty pallets sink and recirculate. */
export const INFEED_END_Z = 0.42;
/** Pallet center z when held at the stopper (the pick station). */
export const PICK_STATION_Z = -0.02;
export const CONVEYOR_SPEED = 0.42;
/** Center-to-center spacing between queued pallets. */
export const PALLET_PITCH = 0.56;

export const PALLET_SIZE = new Vector3(0.36, 0.024, 0.36);
/** Resting y of a part base on a pallet riding the belt. */
export const PALLET_TOP_Y = BELT_TOP_Y + PALLET_SIZE.y;

// ---------------------------------------------------------------------------
// Main transfer line — runs along x through every station's place point.
// ---------------------------------------------------------------------------

export const MAIN_LINE_Z = 0.9;
/** Local x of the assembly point inside each station (= world stop x offset). */
export const PLACE_LOCAL_X = 0.55;
export const MAIN_LINE_START_X = -1.6;
export const MAIN_LINE_END_X = 7.15;
export const MAIN_HOOD_X = 6.5;
export const MAIN_DESPAWN_X = 6.72;
export const MAIN_LINE_WIDTH = 0.52;
export const MAIN_LINE_SPEED = 0.55;
/** Minimum center-to-center gap between carriers on the main line. */
export const CARRIER_PITCH = 0.85;

/** World x where a carrier stops to be worked on at station k. */
export function carrierStopX(station: number): number {
  return PLACE_LOCAL_X + stationOffsetX(station);
}

/** Carrier riser keeps the hub mount at the same proven heights as v3. */
export const CARRIER_TOP_Y = 0.335;
export const HUB_MOUNT_TOP_Y = CARRIER_TOP_Y + 0.06;
export const CARRIER_PLATE_SIZE = new Vector3(0.34, CARRIER_TOP_Y - BELT_TOP_Y, 0.34);

/** Base y of each part once seated on the assembly stack. */
export function stackBaseY(type: PartType): number {
  let y = HUB_MOUNT_TOP_Y;
  for (const step of ASSEMBLY_SEQUENCE) {
    if (step === type) {
      return y;
    }
    y += PART_SPECS[step].stackHeight;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Pick / place pose targets — expressed in STATION-LOCAL coordinates.
// ---------------------------------------------------------------------------

export const PICK_TRANSIT_Y = 1.02;
export const PLACE_TRANSIT_Y = 1.12;
export const PRE_PICK_CLEARANCE = 0.22;
export const LIFT_CLEARANCE = 0.32;
/** The part is released this far above its seat and settles down in animation. */
export const SETTLE_DROP = 0.05;

export interface AssemblyPlanTarget {
  type: PartType;
  /** Grasp-point position on the pallet at the pick station (station-local). */
  pickPosition: Vector3;
  pickTransitPosition: Vector3;
  prePickPosition: Vector3;
  liftPosition: Vector3;
  placeTransitPosition: Vector3;
  /** Grasp-point position where the part is released above its seat (station-local). */
  dropPosition: Vector3;
}

/** Grasp-point local position of a part waiting on the pick-station pallet. */
export function pickStationGraspPosition(type: PartType): Vector3 {
  return new Vector3(
    INFEED_CENTER_X,
    PALLET_TOP_Y + PART_SPECS[type].graspHeight,
    PICK_STATION_Z,
  );
}

/** Grasp-point local position of a part seated on the carrier stack. */
export function seatedGraspPosition(type: PartType): Vector3 {
  return new Vector3(
    PLACE_LOCAL_X,
    stackBaseY(type) + PART_SPECS[type].graspHeight,
    MAIN_LINE_Z,
  );
}

export function createAssemblyPlanTarget(
  type: PartType,
  pickPosition = pickStationGraspPosition(type),
): AssemblyPlanTarget {
  const dropPosition = seatedGraspPosition(type).add(new Vector3(0, SETTLE_DROP, 0));
  return {
    type,
    pickPosition,
    pickTransitPosition: new Vector3(pickPosition.x, PICK_TRANSIT_Y, pickPosition.z),
    prePickPosition: pickPosition.clone().add(new Vector3(0, PRE_PICK_CLEARANCE, 0)),
    liftPosition: pickPosition.clone().add(new Vector3(0, LIFT_CLEARANCE, 0)),
    placeTransitPosition: new Vector3(PLACE_LOCAL_X, PLACE_TRANSIT_Y, MAIN_LINE_Z),
    dropPosition,
  };
}

// ---------------------------------------------------------------------------
// Static collision obstacles.
// ---------------------------------------------------------------------------

function box(name: string, center: Vector3, size: Vector3): StaticObstacle {
  return { name, box: new Box3().setFromCenterAndSize(center, size) };
}

/** Station-local infeed obstacles (deck, guide rails, stopper). */
function createInfeedObstacles(station: number): StaticObstacle[] {
  const dx = stationOffsetX(station);
  const beltLength = INFEED_END_Z - INFEED_START_Z;
  const beltCenterZ = (INFEED_START_Z + INFEED_END_Z) / 2;
  const railHeight = 0.06;

  return [
    box(
      `st${station} infeed deck`,
      new Vector3(dx + INFEED_CENTER_X, BELT_TOP_Y - 0.03, beltCenterZ),
      new Vector3(INFEED_WIDTH + 0.08, 0.06, beltLength),
    ),
    box(
      `st${station} infeed left rail`,
      new Vector3(dx + INFEED_CENTER_X - INFEED_WIDTH * 0.5 - 0.035, BELT_TOP_Y, beltCenterZ),
      new Vector3(0.04, railHeight, beltLength),
    ),
    box(
      `st${station} infeed right rail`,
      new Vector3(dx + INFEED_CENTER_X + INFEED_WIDTH * 0.5 + 0.035, BELT_TOP_Y, beltCenterZ),
      new Vector3(0.04, railHeight, beltLength),
    ),
    box(
      `st${station} infeed stopper`,
      new Vector3(dx + INFEED_CENTER_X, BELT_TOP_Y + 0.02, PICK_STATION_Z + PALLET_SIZE.z * 0.5 + 0.035),
      new Vector3(INFEED_WIDTH, 0.05, 0.02),
    ),
    box(
      `st${station} hub mount`,
      new Vector3(dx + PLACE_LOCAL_X, (CARRIER_TOP_Y + HUB_MOUNT_TOP_Y) / 2, MAIN_LINE_Z),
      new Vector3(0.17, HUB_MOUNT_TOP_Y - CARRIER_TOP_Y, 0.17),
    ),
    box(
      `st${station} andon pole`,
      new Vector3(dx + 0.0, 0.7, 1.75),
      new Vector3(0.1, 1.4, 0.1),
    ),
  ];
}

/** The neighbor robots' pedestal columns — excluded from a robot's own set. */
function createRobotColumnObstacle(station: number): StaticObstacle {
  return box(
    `robot column ${station}`,
    new Vector3(stationOffsetX(station) - 0.28, 0.55, -0.21),
    new Vector3(0.7, 1.1, 0.7),
  );
}

/** Shared main-line obstacles (deck, guides, outfeed hood). */
function createMainLineObstacles(): StaticObstacle[] {
  const length = MAIN_LINE_END_X - MAIN_LINE_START_X;
  const centerX = (MAIN_LINE_START_X + MAIN_LINE_END_X) / 2;
  return [
    box(
      'main line deck',
      new Vector3(centerX, BELT_TOP_Y - 0.03, MAIN_LINE_Z),
      new Vector3(length, 0.06, MAIN_LINE_WIDTH + 0.08),
    ),
    box(
      'main line near guide',
      new Vector3(centerX, BELT_TOP_Y, MAIN_LINE_Z - MAIN_LINE_WIDTH * 0.5 - 0.035),
      new Vector3(length, 0.06, 0.04),
    ),
    box(
      'main line far guide',
      new Vector3(centerX, BELT_TOP_Y, MAIN_LINE_Z + MAIN_LINE_WIDTH * 0.5 + 0.035),
      new Vector3(length, 0.06, 0.04),
    ),
    box(
      'main line outfeed hood',
      new Vector3(MAIN_HOOD_X, BELT_TOP_Y + 0.2, MAIN_LINE_Z),
      new Vector3(0.3, 0.4, MAIN_LINE_WIDTH + 0.16),
    ),
  ];
}

/** Every static obstacle on the line, in world coordinates. */
export function createWorldObstacles(): StaticObstacle[] {
  const obstacles: StaticObstacle[] = [...createMainLineObstacles()];
  for (let station = 0; station < STATION_COUNT; station += 1) {
    obstacles.push(...createInfeedObstacles(station));
    obstacles.push(createRobotColumnObstacle(station));
  }
  return obstacles;
}

/**
 * The obstacle set robot `station` plans against, translated into its LOCAL
 * frame (the kinematics assume the base at a fixed offset). The robot's own
 * pedestal column is excluded — it would intersect the arm's shoulder capsule.
 */
export function obstaclesForStation(station: number): StaticObstacle[] {
  const dx = stationOffsetX(station);
  return createWorldObstacles()
    .filter((obstacle) => obstacle.name !== `robot column ${station}`)
    .map((obstacle) => ({
      name: obstacle.name,
      box: obstacle.box.clone().translate(new Vector3(-dx, 0, 0)),
    }));
}

// ---------------------------------------------------------------------------
// Vision geometry (station-local; translate by stationOffsetX for world).
// ---------------------------------------------------------------------------

/** Height of the back-projection plane — mid-range of the three marker heights. */
export const MARKER_PLANE_Y = 0.36;

export interface DetectionRegion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Only markers inside this window (pick station) are actionable. */
export const PICK_REGION: DetectionRegion = { minX: 0.88, maxX: 1.42, minZ: -0.38, maxZ: 0.34 };
/** The operator preview tracks markers across the infeed and the carrier stop. */
export const CELL_REGION: DetectionRegion = { minX: 0.35, maxX: 1.75, minZ: -1.7, maxZ: 1.3 };

/** Fixed station camera, in station-local coordinates. */
export const VISION_CAMERA_LOCAL_POSITION = new Vector3(3.3, 2.35, -0.15);
export const VISION_CAMERA_LOCAL_TARGET = new Vector3(1.08, 0.3, 0.24);
export const VISION_CAMERA_FOV = 50;
