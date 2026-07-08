import './style.css';
import {
  BufferGeometry,
  Clock,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Vector3,
} from 'three';
import { createCamera } from './scene/camera';
import { createControls } from './scene/controls';
import { createScene } from './scene/createScene';
import { createRenderer } from './scene/renderer';
import { applyFactoryAtmosphere, createFactoryDecor, type AndonState } from './scene/factory';
import { createPostPipeline } from './scene/postprocessing';
import { RobotArm } from './robot/RobotArm';
import { JointTrajectoryPlayer } from './robot/trajectory';
import type { IKResult, JointWaypoint } from './types/robot';
import { computeVisualChainState, solveIK } from './robot/kinematics';
import {
  checkGroundClearance,
  checkObstacleCollision,
  checkSelfCollision,
  checkTrajectoryGroundClearance,
  checkTrajectoryObstacleCollision,
  type StaticObstacle,
} from './robot/collision';
import { GRIPPER_GRASP_OFFSET, HOME_POSE, ZERO_POSE } from './robot/limits';
import { createRobotGui, type RobotGuiApi } from './ui/gui';
import { createAxes } from './utils/axes';
import { formatVector, lerpAngles, vectorFromTuple } from './utils/math';
import { Logger } from './utils/logger';
import { InfeedConveyor } from './assembly/InfeedConveyor';
import { MainLine } from './assembly/MainLine';
import { createStationScreen, type StationScreen } from './assembly/StationScreen';
import type { AssemblyPart } from './assembly/parts';
import {
  ASSEMBLY_SEQUENCE,
  CELL_REGION,
  PART_SPECS,
  PART_TYPE_BY_MARKER,
  PICK_REGION,
  PLACE_LOCAL_X,
  STATION_COUNT,
  VISION_CAMERA_FOV,
  VISION_CAMERA_LOCAL_POSITION,
  VISION_CAMERA_LOCAL_TARGET,
  MAIN_LINE_Z,
  obstaclesForStation,
  stationOffsetX,
  type AssemblyPlanTarget,
  type DetectionRegion,
  type PartType,
} from './assembly/layout';
import {
  StationController,
  type StationReport,
  type StationState,
} from './assembly/StationController';
import { OnlineVisionSystem } from './vision/OnlineVisionSystem';
import type { DetectionColor, VisionDetection } from './vision/VisionSystem';
import { EffectsManager } from './fx/effects';

const GRIPPER_OPEN_OPENING = 0.18;
const GRASP_ATTACH_TOLERANCE = 0.05;
const PICK_DURATION_SECONDS = 3.2;
const PLACE_DURATION_SECONDS = 3.8;
const PLANNED_TRAJECTORY_SAMPLES = 96;
const SAFE_HOME_TIME_SECONDS = 1.25;
const VISION_PREVIEW_INTERVAL_SECONDS = 0.15;
const VISION_PREVIEW_WIDTH = 320;
const VISION_PREVIEW_HEIGHT = 240;
/** Max horizontal disagreement between the vision estimate and the pick station. */
const VISION_MATCH_RADIUS = 0.3;

const TRAJECTORY_COLORS = [0x39d98a, 0x37b7ff, 0xffb547];

interface PlannedTrajectory {
  part: AssemblyPart;
  /** Station-local grasp position at the pick point. */
  pickPositionLocal: Vector3;
  pickWaypoints: JointWaypoint[];
  placeWaypoints: JointWaypoint[];
}

type ExecutionPhase = 'idle' | 'to-pick' | 'to-drop';

interface StationRig {
  station: number;
  partType: PartType;
  offsetX: number;
  robot: RobotArm;
  player: JointTrajectoryPlayer;
  infeed: InfeedConveyor;
  vision: OnlineVisionSystem;
  controller: StationController;
  screen: StationScreen;
  /** Planning obstacles, already translated into this station's local frame. */
  obstacles: StaticObstacle[];
  /** Scene-level holder for the gripped part; follows the grasp point, stays level. */
  partCarrier: Group;
  planned: PlannedTrajectory | null;
  phase: ExecutionPhase;
  carried: AssemblyPart | null;
  trajectoryLine: Line;
  trajectoryPositions: Vector3[];
  state: StationState;
  status: string;
}

const DETECTION_DRAW_COLORS: Record<DetectionColor, string> = {
  red: '#ff3f4b',
  blue: '#337cff',
  yellow: '#ffd60a',
};

const logger = new Logger('AssemblyLine');
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app container');
}

// --- scene & shared hardware ---------------------------------------------------

const scene = createScene();
const camera = createCamera();
const renderer = createRenderer(app);
const controls = createControls(camera, renderer);
const clock = new Clock();

applyFactoryAtmosphere(scene, renderer);
const factory = createFactoryDecor();
scene.add(factory.group);

const postPipeline = createPostPipeline(renderer, scene, camera);

const worldAxes = createAxes(0.5);
worldAxes.name = 'World coordinate frame';
worldAxes.visible = false;
scene.add(worldAxes);

const effects = new EffectsManager();
scene.add(effects.group);

const mainLine = new MainLine();
scene.add(mainLine.group);

// --- runtime state ---------------------------------------------------------------

let gui: RobotGuiApi | null = null;
let speedFactor = 1;
let orbitEnabled = false;
let orbitAngle = 0.62;
let lineRunning = false;
let previewStation = 0;
let latestDetections: VisionDetection[] = [];
let visionPreviewElapsed = VISION_PREVIEW_INTERVAL_SECONDS;
const stationReports: (StationReport | null)[] = Array.from({ length: STATION_COUNT }, () => null);
let lineReportLine: string | null = null;

// --- station rigs ----------------------------------------------------------------

function offsetRegion(region: DetectionRegion, dx: number): DetectionRegion {
  return { minX: region.minX + dx, maxX: region.maxX + dx, minZ: region.minZ, maxZ: region.maxZ };
}

const rigs: StationRig[] = ASSEMBLY_SEQUENCE.map((partType, station) => {
  const offsetX = stationOffsetX(station);

  const robot = new RobotArm();
  robot.group.position.x = offsetX;
  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  scene.add(robot.group);

  const infeed = new InfeedConveyor(station, partType);
  scene.add(infeed.group);

  const vision = new OnlineVisionSystem(renderer, scene, {
    name: `ST${station + 1} vision`,
    fov: VISION_CAMERA_FOV,
    position: VISION_CAMERA_LOCAL_POSITION.clone().add(new Vector3(offsetX, 0, 0)),
    target: VISION_CAMERA_LOCAL_TARGET.clone().add(new Vector3(offsetX, 0, 0)),
    pickRegion: offsetRegion(PICK_REGION, offsetX),
    cellRegion: offsetRegion(CELL_REGION, offsetX),
  });
  scene.add(vision.group);

  const screen = createStationScreen(
    new Vector3(offsetX + PLACE_LOCAL_X - 0.55, 0, MAIN_LINE_Z + 0.62),
  );
  scene.add(screen.group);

  const partCarrier = new Group();
  partCarrier.name = `ST${station + 1} part carrier`;
  scene.add(partCarrier);

  const trajectoryLine = new Line(
    new BufferGeometry(),
    new LineBasicMaterial({ color: TRAJECTORY_COLORS[station % TRAJECTORY_COLORS.length] }),
  );
  trajectoryLine.name = `ST${station + 1} trajectory`;
  scene.add(trajectoryLine);

  const rig: StationRig = {
    station,
    partType,
    offsetX,
    robot,
    player: null as unknown as JointTrajectoryPlayer,
    infeed,
    vision,
    controller: null as unknown as StationController,
    screen,
    obstacles: obstaclesForStation(station),
    partCarrier,
    planned: null,
    phase: 'idle',
    carried: null,
    trajectoryLine,
    trajectoryPositions: [],
    state: 'idle',
    status: '待机',
  };

  rig.player = new JointTrajectoryPlayer(
    robot,
    () => recordGraspPosition(rig),
    () => handleTrajectoryComplete(rig),
  );

  rig.controller = new StationController(station, partType, {
    vision,
    isPartReady: () => infeed.getPartAtPickStation() !== null,
    isCarrierReady: () => mainLine.getCarrierProgress(station) === station,
    planAndExecute: (detection) => planAndExecute(rig, detection),
    isArmBusy: () => rig.player.isPlaying() || rig.carried !== null,
    rejectPart: () => infeed.rejectFrontPart(),
    startFasten: () => {
      effects.spawnSparks(mainLine.getStackTopPosition(station));
      mainLine.beginFasten(station, () => {
        effects.spawnFlashRing(mainLine.getStackTopPosition(station), 0x39d98a);
        rig.controller.onFastenComplete();
      });
    },
    releaseCarrier: () => mainLine.release(station),
    onState: (state, status) => {
      rig.state = state;
      rig.status = status;
      factory.setAndonState(station, andonStateFor(state));
      updateStationScreen(rig);
    },
    onReport: (report) => {
      stationReports[station] = report;
    },
  });

  return rig;
});

// Every station camera must hide every overlay — including the OTHER stations'
// detection markers, whose saturated ring colors would segment as parts.
const sharedOverlays = [
  worldAxes,
  effects.group,
  ...rigs.map((rig) => rig.trajectoryLine),
  ...rigs.map((rig) => rig.screen.screenMesh),
];
rigs.forEach((rig) => {
  rig.vision.hideDuringCapture = [
    ...sharedOverlays,
    ...rigs.filter((other) => other !== rig).map((other) => other.vision.group),
  ];
});

function andonStateFor(state: StationState): AndonState {
  if (state === 'blind') {
    return 'fault';
  }
  if (state === 'idle' || state === 'done') {
    return 'idle';
  }
  return 'running';
}

function updateStationScreen(rig: StationRig): void {
  rig.screen.setLines([
    `ST${rig.station + 1} · ${PART_SPECS[rig.partType].label}`,
    rig.status,
    `完成 ${rig.controller.getPartsPlaced()} 件`,
  ]);
}

// --- DOM panels ------------------------------------------------------------------

const visionPanel = document.createElement('div');
visionPanel.className = 'vision-panel';
visionPanel.innerHTML = [
  '<strong class="vision-title">在线视觉 · ST1</strong>',
  '<div class="vision-preview"></div>',
  '<div class="vision-caption">HSV 分割 | 标识色 → 零件类型 + 反投影坐标</div>',
  '<div class="vision-table"></div>',
].join('');
app.appendChild(visionPanel);
const visionPreview = visionPanel.querySelector<HTMLDivElement>('.vision-preview');
const visionTable = visionPanel.querySelector<HTMLDivElement>('.vision-table');
const visionTitle = visionPanel.querySelector<HTMLElement>('.vision-title');
if (!visionPreview || !visionTable || !visionTitle) {
  throw new Error('Missing vision panel elements');
}
const visionTableElement = visionTable;
const visionTitleElement = visionTitle;

const visionDetectionCanvas = document.createElement('canvas');
visionDetectionCanvas.width = VISION_PREVIEW_WIDTH;
visionDetectionCanvas.height = VISION_PREVIEW_HEIGHT;
visionDetectionCanvas.className = 'vision-detection-canvas';
visionPreview.appendChild(visionDetectionCanvas);
const visionDetectionContext = getCanvas2DContext(visionDetectionCanvas);

const hud = document.createElement('div');
hud.className = 'hud';
app.appendChild(hud);

// --- GUI ---------------------------------------------------------------------------

gui = createRobotGui({
  robots: rigs.map((rig) => rig.robot),
  robotLabels: rigs.map((rig) => `ST${rig.station + 1} ${PART_SPECS[rig.partType].label}`),
  onProductionStart: () => {
    lineReportLine = null;
    stationReports.fill(null);
    mainLine.resetStats();
    lineRunning = true;
    rigs.forEach((rig) => rig.controller.start());
  },
  onProductionStop: () => {
    lineRunning = false;
    rigs.forEach((rig) => rig.controller.stop());
    composeLineReport();
  },
  onSpeedChanged: (multiplier) => {
    speedFactor = multiplier;
  },
  onBloomChanged: (enabled) => postPipeline.setBloomEnabled(enabled),
  onOrbitChanged: (enabled) => {
    orbitEnabled = enabled;
    controls.enabled = !enabled;
  },
  onPreviewStationChanged: (station) => {
    previewStation = station;
    visionTitleElement.textContent = `在线视觉 · ST${station + 1}`;
  },
  onDetectionMarkersChanged: (visible) => {
    rigs.forEach((rig) => {
      rig.vision.group.visible = visible;
    });
  },
  onFramesVisibleChanged: (visible) => {
    rigs.forEach((rig) => rig.robot.setFramesVisible(visible));
    worldAxes.visible = visible;
  },
  onTrajectoryVisibleChanged: (visible) => {
    rigs.forEach((rig) => {
      rig.trajectoryLine.visible = visible;
    });
  },
  onReset: () => {
    rigs.forEach((rig) => {
      rig.player.stop();
      rig.robot.reset();
      rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
      rig.planned = null;
      rig.phase = 'idle';
      resetTrajectoryLine(rig);
    });
    refreshGui();
  },
  onHome: () => {
    rigs.forEach((rig) => {
      rig.player.stop();
      rig.robot.home();
      rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
      rig.planned = null;
      rig.phase = 'idle';
      resetTrajectoryLine(rig);
    });
    refreshGui();
  },
});

rigs.forEach((rig) => {
  rig.robot.setFramesVisible(false);
  recordGraspPosition(rig);
  updateStationScreen(rig);
});
animate();

window.addEventListener('resize', onResize);

// --- frame loop --------------------------------------------------------------------

function animate(): void {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  stepSimulation(delta);
  updateOrbitCamera(delta);
  controls.update();
  updateDetectionPreview(delta);
  updateHud();
  updateVisionPanel();
  postPipeline.render();
}

function stepSimulation(delta: number): void {
  const dt = delta * speedFactor;
  mainLine.update(dt);
  rigs.forEach((rig) => {
    rig.infeed.update(dt, delta);
    rig.player.update(dt);
    rig.partCarrier.position.copy(rig.robot.getGraspPose().position);
    rig.controller.tick();
  });
  effects.update(delta);
  factory.update(delta);
}

// Browsers pause requestAnimationFrame in hidden tabs and heavily throttle
// main-thread timers there; a dedicated-worker timer is exempt, so the
// production line keeps running while the user is away.
const HIDDEN_HEARTBEAT_SECONDS = 0.25;
const heartbeatWorker = new Worker(
  URL.createObjectURL(
    new Blob([`setInterval(() => postMessage(0), ${HIDDEN_HEARTBEAT_SECONDS * 1000});`], {
      type: 'text/javascript',
    }),
  ),
);
heartbeatWorker.onmessage = () => {
  if (document.hidden) {
    clock.getDelta();
    stepSimulation(HIDDEN_HEARTBEAT_SECONDS);
    updateDetectionPreview(HIDDEN_HEARTBEAT_SECONDS);
    updateHud();
    updateVisionPanel();
  }
};

function updateOrbitCamera(delta: number): void {
  if (!orbitEnabled) {
    return;
  }
  orbitAngle += delta * 0.12;
  const radius = 7.2;
  camera.position.set(
    2.4 + Math.cos(orbitAngle) * radius,
    3.4,
    0.6 + Math.sin(orbitAngle) * radius,
  );
  camera.lookAt(2.4, 0.45, 0.5);
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  postPipeline.setSize(window.innerWidth, window.innerHeight);
}

// --- pick & place planning (station-local, multi-seed collision-safe IK) -------------

function planAndExecute(rig: StationRig, detection: VisionDetection): 'started' | 'unreachable' {
  const part = rig.infeed.getPartAtPickStation();
  const target = rig.infeed.createPickTarget();
  if (!part || !target) {
    return 'unreachable';
  }

  // Recognition (part type + presence) is online; sanity-check that the vision
  // estimate agrees with the physical pick station before committing the arm.
  const horizontalError = Math.hypot(
    detection.estimatedWorldPosition.x - rig.offsetX - target.pickPosition.x,
    detection.estimatedWorldPosition.z - target.pickPosition.z,
  );
  if (horizontalError > VISION_MATCH_RADIUS) {
    logger.warn(`ST${rig.station + 1}: vision estimate off by ${horizontalError.toFixed(3)}m`);
    return 'unreachable';
  }

  rig.player.stop();
  rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  planStationTrajectory(rig, target, part);
  if (!rig.planned) {
    return 'unreachable';
  }
  executePlannedTrajectory(rig);
  return 'started';
}

function planStationTrajectory(
  rig: StationRig,
  target: AssemblyPlanTarget,
  part: AssemblyPart,
): void {
  const toolOffset = vectorFromTuple(GRIPPER_GRASP_OFFSET);
  const startAngles = rig.robot.getJointAngles();
  const obstacles = rig.obstacles;

  const stages: { position: Vector3; threshold: number; errorCap: number }[] = [
    { position: target.pickTransitPosition, threshold: 0.025, errorCap: 0.08 },
    { position: target.prePickPosition, threshold: 0.02, errorCap: 0.08 },
    { position: target.pickPosition, threshold: 0.014, errorCap: GRASP_ATTACH_TOLERANCE },
    { position: target.liftPosition, threshold: 0.02, errorCap: 0.08 },
    { position: target.placeTransitPosition, threshold: 0.025, errorCap: 0.08 },
    { position: target.dropPosition, threshold: 0.025, errorCap: 0.1 },
  ];
  const stageNames = ['过渡点', '预抓取点', '抓取点', '提升点', '装配过渡点', '装配落点'];

  const solutions: IKResult[] = [];
  let seedAngles = startAngles;
  for (let stage = 0; stage < stages.length; stage += 1) {
    const { position, threshold, errorCap } = stages[stage];
    const result = solveCellSafeIK(position, seedAngles, toolOffset, threshold, obstacles);
    if (!result || (!result.success && result.error > errorCap)) {
      failPlanning(rig, `${stageNames[stage]}不可达（碰撞约束）`);
      return;
    }
    solutions.push(result);
    seedAngles = result.jointAngles;
  }

  const [pickTransit, prePick, pick, lift, placeTransit, drop] = solutions;
  const planned: PlannedTrajectory = {
    part,
    pickPositionLocal: target.pickPosition.clone(),
    pickWaypoints: [
      { time: 0, jointAngles: startAngles },
      { time: PICK_DURATION_SECONDS * 0.42, jointAngles: pickTransit.jointAngles },
      { time: PICK_DURATION_SECONDS * 0.76, jointAngles: prePick.jointAngles },
      { time: PICK_DURATION_SECONDS, jointAngles: pick.jointAngles },
    ],
    placeWaypoints: [
      { time: 0, jointAngles: pick.jointAngles },
      { time: PLACE_DURATION_SECONDS * 0.28, jointAngles: lift.jointAngles },
      { time: PLACE_DURATION_SECONDS * 0.68, jointAngles: placeTransit.jointAngles },
      { time: PLACE_DURATION_SECONDS, jointAngles: drop.jointAngles },
    ],
  };
  planned.pickWaypoints = findSafeWaypointRoute(planned.pickWaypoints, toolOffset, obstacles);
  planned.placeWaypoints = findSafeWaypointRoute(planned.placeWaypoints, toolOffset, obstacles);

  const pickClearance = checkTrajectoryGroundClearance(planned.pickWaypoints, toolOffset);
  const placeClearance = checkTrajectoryGroundClearance(planned.placeWaypoints, toolOffset);
  if (!pickClearance.safe || !placeClearance.safe) {
    failPlanning(rig, `轨迹触地风险 minY=${Math.min(pickClearance.minY, placeClearance.minY).toFixed(3)}m`);
    return;
  }
  const pickObstacle = checkTrajectoryObstacleCollision(planned.pickWaypoints, obstacles, toolOffset);
  const placeObstacle = checkTrajectoryObstacleCollision(planned.placeWaypoints, obstacles, toolOffset);
  if (!pickObstacle.safe || !placeObstacle.safe) {
    const collision = !pickObstacle.safe ? pickObstacle : placeObstacle;
    failPlanning(rig, `设备碰撞 ${collision.obstacleName ?? 'obstacle'}`);
    return;
  }

  rig.planned = planned;
  previewTrajectory(rig, planned);
  logger.info(`ST${rig.station + 1}: planned ${part.id}`);
}

function failPlanning(rig: StationRig, reason: string): void {
  rig.planned = null;
  resetTrajectoryLine(rig);
  logger.warn(`ST${rig.station + 1}: 规划失败 ${reason}`);
}

function solveCellSafeIK(
  targetPosition: Vector3,
  currentAngles: number[],
  toolOffset: Vector3,
  threshold: number,
  obstacles: StaticObstacle[],
): IKResult | null {
  const seeds = createIkSeeds(currentAngles, targetPosition);
  let bestSafeResult: IKResult | null = null;

  seeds.forEach((seed) => {
    const result = solveIK({ position: targetPosition }, seed, {
      maxIterations: 220,
      threshold,
      gain: 0.74,
      toolOffset,
    });
    if (!checkGroundClearance(result.jointAngles, toolOffset).safe) {
      return;
    }
    if (!checkSelfCollision(result.jointAngles, toolOffset).safe) {
      return;
    }
    if (!checkObstacleCollision(result.jointAngles, obstacles, toolOffset).safe) {
      return;
    }
    if (!bestSafeResult || result.error < bestSafeResult.error) {
      bestSafeResult = result;
    }
  });

  return bestSafeResult;
}

function createIkSeeds(currentAngles: number[], targetPosition?: Vector3): number[][] {
  const targetYaw = targetPosition
    ? Math.atan2(-targetPosition.z, targetPosition.x)
    : (currentAngles[0] ?? 0);
  const yawCandidates = uniqueRounded([
    currentAngles[0] ?? 0,
    targetYaw,
    targetYaw - 0.35,
    targetYaw + 0.35,
    targetYaw - 0.7,
    targetYaw + 0.7,
    HOME_POSE[0],
    ZERO_POSE[0],
  ]);
  const postureCandidates = [
    [currentAngles[1] ?? 0, currentAngles[2] ?? 0, currentAngles[3] ?? 0, currentAngles[4] ?? 0, currentAngles[5] ?? 0],
    [HOME_POSE[1], HOME_POSE[2], HOME_POSE[3], HOME_POSE[4], HOME_POSE[5]],
    [ZERO_POSE[1], ZERO_POSE[2], ZERO_POSE[3], ZERO_POSE[4], ZERO_POSE[5]],
    [-0.45, 0.95, 0, 0.45, 0],
    [-0.65, 1.2, 0, 0.55, 0],
    [-0.85, 1.45, 0, 0.65, 0],
    [-1.05, 1.7, 0, 0.82, 0],
    [-1.2, 1.95, 0, 0.95, 0],
  ];

  const seeds: number[][] = [[...currentAngles], [...HOME_POSE], [...ZERO_POSE]];
  yawCandidates.forEach((yaw) => {
    postureCandidates.forEach((posture) => {
      seeds.push([yaw, posture[0], posture[1], posture[2], posture[3], posture[4]]);
    });
  });

  return dedupeSeeds(seeds);
}

function uniqueRounded(values: number[]): number[] {
  return [...new Map(values.map((value) => [value.toFixed(3), value])).values()];
}

function dedupeSeeds(seeds: number[][]): number[][] {
  return [...new Map(seeds.map((seed) => [seed.map((value) => value.toFixed(3)).join(','), seed])).values()];
}

function findSafeWaypointRoute(
  waypoints: JointWaypoint[],
  toolOffset: Vector3,
  obstacles: StaticObstacle[],
): JointWaypoint[] {
  const directClearance = checkTrajectoryGroundClearance(waypoints, toolOffset);
  const directObstacle = checkTrajectoryObstacleCollision(waypoints, obstacles, toolOffset);
  if (directClearance.safe && directObstacle.safe) {
    return waypoints;
  }

  const start = waypoints[0];
  const detours: number[][] = [
    HOME_POSE,
    [start.jointAngles[0] ?? 0, -0.9, 1.45, 0, 0.7, 0],
  ];
  for (const detour of detours) {
    const routed: JointWaypoint[] = [
      { time: 0, jointAngles: start.jointAngles },
      { time: SAFE_HOME_TIME_SECONDS, jointAngles: detour },
      ...waypoints.slice(1).map((waypoint) => ({
        time: waypoint.time + SAFE_HOME_TIME_SECONDS,
        jointAngles: waypoint.jointAngles,
      })),
    ];
    if (
      checkTrajectoryGroundClearance(routed, toolOffset).safe &&
      checkTrajectoryObstacleCollision(routed, obstacles, toolOffset).safe
    ) {
      return routed;
    }
  }

  logger.warn('No collision-safe route found; using direct waypoints');
  return waypoints;
}

// --- execution ------------------------------------------------------------------------

function executePlannedTrajectory(rig: StationRig): void {
  if (!rig.planned) {
    return;
  }
  rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  rig.phase = 'to-pick';
  resetTrajectoryLine(rig);
  rig.player.setWaypoints(rig.planned.pickWaypoints);
  rig.player.play();
  refreshGui();
}

function handleTrajectoryComplete(rig: StationRig): void {
  if (!rig.planned) {
    rig.phase = 'idle';
    return;
  }

  if (rig.phase === 'to-pick') {
    const graspWorld = rig.robot.getGraspPose().position;
    const pickWorld = rig.planned.pickPositionLocal.clone().add(new Vector3(rig.offsetX, 0, 0));
    const graspError = graspWorld.distanceTo(pickWorld);
    if (graspError > GRASP_ATTACH_TOLERANCE) {
      rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
      rig.phase = 'idle';
      rig.planned = null;
      rig.controller.onTrajectoryComplete(false);
      return;
    }

    const part = rig.infeed.takePartAtPickStation();
    if (!part) {
      rig.phase = 'idle';
      rig.planned = null;
      rig.controller.onTrajectoryComplete(false);
      return;
    }
    rig.robot.setGripperOpening(part.spec.gripDiameter);
    rig.partCarrier.add(part.mesh);
    part.mesh.position.set(0, -part.spec.graspHeight, 0);
    part.mesh.quaternion.identity();
    rig.carried = part;
    rig.phase = 'to-drop';
    rig.player.setWaypoints(rig.planned.placeWaypoints);
    rig.player.play();
    rig.controller.onTrajectoryComplete(true);
    return;
  }

  if (rig.phase === 'to-drop') {
    const part = rig.carried ?? rig.planned.part;
    rig.robot.setGripperOpening(GRIPPER_OPEN_OPENING);
    rig.carried = null;
    const placed = mainLine.beginPlace(rig.station, part, () => {
      effects.spawnFlashRing(mainLine.getStackTopPosition(rig.station), 0x37d3ff);
      rig.controller.onPlaceSettled();
    });
    if (!placed) {
      // Interlock guarantees a parked carrier; if it is somehow gone, drop the
      // part back onto the carrier stop so the cycle can recover.
      logger.warn(`ST${rig.station + 1}: no carrier at release — part re-queued`);
      rig.controller.onPlaceSettled();
    }
    rig.planned = null;
    rig.phase = 'idle';
  }
}

// --- trajectory visualization -----------------------------------------------------------

function previewTrajectory(rig: StationRig, plan: PlannedTrajectory): void {
  rig.trajectoryPositions.length = 0;
  appendTrajectoryPreview(rig, plan.pickWaypoints);
  appendTrajectoryPreview(rig, plan.placeWaypoints);
  updateTrajectoryGeometry(rig);
}

function appendTrajectoryPreview(rig: StationRig, waypoints: JointWaypoint[]): void {
  const duration = waypoints[waypoints.length - 1].time;
  for (let sample = 0; sample <= PLANNED_TRAJECTORY_SAMPLES; sample += 1) {
    const elapsed = (sample / PLANNED_TRAJECTORY_SAMPLES) * duration;
    const jointAngles = sampleJointTrajectory(waypoints, elapsed);
    const graspState = computeVisualChainState(jointAngles, vectorFromTuple(GRIPPER_GRASP_OFFSET));
    rig.trajectoryPositions.push(
      graspState.endEffectorPosition.clone().add(new Vector3(rig.offsetX, 0, 0)),
    );
  }
}

function sampleJointTrajectory(waypoints: JointWaypoint[], elapsed: number): number[] {
  const last = waypoints[waypoints.length - 1];
  if (elapsed >= last.time) {
    return [...last.jointAngles];
  }

  const nextIndex = waypoints.findIndex((waypoint) => waypoint.time >= elapsed);
  const next = waypoints[nextIndex];
  const previous = waypoints[Math.max(0, nextIndex - 1)];
  const segmentDuration = Math.max(next.time - previous.time, 0.001);
  const t = (elapsed - previous.time) / segmentDuration;
  return lerpAngles(previous.jointAngles, next.jointAngles, t);
}

function recordGraspPosition(rig: StationRig): void {
  const pose = rig.robot.getGraspPose();
  const last = rig.trajectoryPositions[rig.trajectoryPositions.length - 1];
  if (!last || last.distanceToSquared(pose.position) > 0.00008) {
    rig.trajectoryPositions.push(pose.position.clone());
    updateTrajectoryGeometry(rig);
  }
}

function resetTrajectoryLine(rig: StationRig): void {
  rig.trajectoryPositions.length = 0;
  recordGraspPosition(rig);
}

function updateTrajectoryGeometry(rig: StationRig): void {
  const positionArray = new Float32Array(rig.trajectoryPositions.length * 3);
  rig.trajectoryPositions.forEach((point, index) => {
    positionArray[index * 3] = point.x;
    positionArray[index * 3 + 1] = point.y;
    positionArray[index * 3 + 2] = point.z;
  });

  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute('position', new Float32BufferAttribute(positionArray, 3));
  rig.trajectoryLine.geometry.dispose();
  rig.trajectoryLine.geometry = nextGeometry;
}

function refreshGui(): void {
  gui?.refreshJointAngles();
}

// --- HUD & vision panel -------------------------------------------------------------------

function updateHud(): void {
  const takt = mainLine.getAvgTaktSeconds();
  const stationLines = rigs.map(
    (rig) =>
      `ST${rig.station + 1} ${PART_SPECS[rig.partType].label}: ${translateState(rig.state)} — ${rig.status}`,
  );
  hud.innerHTML = [
    '<strong>轮毂装配线 LINE-01 · 三机协同</strong>',
    `产线: ${lineRunning ? '运行中' : '停止'} | 产量: ${mainLine.getOutputCount()} 台 | 在制: ${mainLine.getWipCount()} 托架`,
    `节拍: ${takt !== null ? `${takt.toFixed(1)}s/台` : '—'}`,
    lineReportLine ?? '班报: —',
    ...stationLines,
  ].join('<br />');
}

function translateState(state: StationState): string {
  const names: Record<StationState, string> = {
    idle: '待机',
    waiting: '待料',
    observing: '视觉识别',
    planning: '轨迹规划',
    picking: '抓取',
    placing: '装配',
    fastening: '拧紧',
    blind: '视觉故障',
    done: '已停止',
  };
  return names[state];
}

function composeLineReport(): void {
  const takt = mainLine.getAvgTaktSeconds();
  const rejects = rigs.reduce((sum, rig) => sum + rig.controller.getRejectCount(), 0);
  const placed = rigs.reduce((sum, rig) => sum + rig.controller.getPartsPlaced(), 0);
  lineReportLine = `班报: 下线 ${mainLine.getOutputCount()} 台 / 装配 ${placed} 件, 节拍 ${
    takt !== null ? `${takt.toFixed(1)}s` : '—'
  }, 退料 ${rejects}`;
}

function updateVisionPanel(): void {
  const rows = latestDetections
    .slice(0, 8)
    .map((detection, index) => {
      const partLabel = PART_SPECS[PART_TYPE_BY_MARKER[detection.color]].label;
      return `<div class="vision-row">
          <span>D${index + 1}</span>
          <span>${partLabel}</span>
          <span>${detection.pixel.x.toFixed(0)},${detection.pixel.y.toFixed(0)}</span>
          <span>${formatVector(detection.estimatedWorldPosition, 2)}</span>
        </div>`;
    })
    .join('');
  visionTableElement.innerHTML = [
    '<div class="vision-head"><span>ID</span><span>零件</span><span>像素</span><span>世界坐标</span></div>',
    rows || '<div class="vision-empty">当前画面中未识别到零件标识</div>',
  ].join('');
}

function updateDetectionPreview(deltaSeconds: number): void {
  visionPreviewElapsed += deltaSeconds;
  if (visionPreviewElapsed < VISION_PREVIEW_INTERVAL_SECONDS) {
    return;
  }
  visionPreviewElapsed = 0;

  const vision = rigs[previewStation]?.vision ?? rigs[0].vision;
  const frame = vision.observe();
  latestDetections = frame.isObservable ? vision.detectAll(frame) : [];

  const context = visionDetectionContext;
  const width = visionDetectionCanvas.width;
  const height = visionDetectionCanvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#05090c';
  context.fillRect(0, 0, width, height);

  context.strokeStyle = 'rgba(111, 143, 157, 0.12)';
  context.lineWidth = 1;
  for (let x = 0; x <= width; x += 40) {
    context.beginPath();
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += 40) {
    context.beginPath();
    context.moveTo(0, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
  }

  latestDetections.forEach((detection) => {
    const x = (detection.pixel.x / frame.width) * width;
    const y = (1 - detection.pixel.y / frame.height) * height;
    const pixelScale = (width / frame.width + height / frame.height) / 2;
    const radius = Math.max(6, Math.min(18, Math.sqrt(detection.areaPx / Math.PI) * pixelScale));
    const color = DETECTION_DRAW_COLORS[detection.color];

    context.fillStyle = color;
    context.globalAlpha = 0.82;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    context.globalAlpha = 1;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 4.5, 0, Math.PI * 2);
    context.moveTo(x - 8, y);
    context.lineTo(x + 8, y);
    context.moveTo(x, y - 8);
    context.lineTo(x, y + 8);
    context.stroke();
    context.fillStyle = '#ffffff';
    context.fillRect(x - 1, y - 1, 2, 2);
  });

  context.fillStyle = frame.isObservable ? '#65e6a5' : '#ff7272';
  context.font = '600 11px system-ui, sans-serif';
  context.fillText(
    frame.isObservable
      ? `ST${previewStation + 1} LIVE | ${latestDetections.length} 个零件标识`
      : '相机视野被遮挡',
    10,
    17,
  );
}

function getCanvas2DContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create vision detection canvas');
  }
  return context;
}
