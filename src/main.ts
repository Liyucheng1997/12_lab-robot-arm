import './style.css';
import {
  BufferGeometry,
  Clock,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createCamera } from './scene/camera';
import { createControls } from './scene/controls';
import { createScene } from './scene/createScene';
import { createRenderer } from './scene/renderer';
import { RobotArm } from './robot/RobotArm';
import { createDefaultTrajectory, JointTrajectoryPlayer } from './robot/trajectory';
import type { JointWaypoint } from './types/robot';
import type { IKResult } from './types/robot';
import { computeVisualChainState, forwardKinematics, forwardKinematicsDH, solveIK } from './robot/kinematics';
import { checkGroundClearance, checkTrajectoryGroundClearance } from './robot/collision';
import { GRIPPER_GRASP_OFFSET, HOME_POSE, ZERO_POSE } from './robot/limits';
import { createRobotGui, type RobotGuiApi } from './ui/gui';
import { createAxes } from './utils/axes';
import { formatVector, lerpAngles, vectorFromTuple } from './utils/math';
import { Logger } from './utils/logger';
import { SortingStation, type SortPlanTarget, type SortableBall } from './sorting/SortingStation';
import { OfflineVisionSystem } from './vision/OfflineVisionSystem';
import { OnlineVisionSystem } from './vision/OnlineVisionSystem';
import type { VisionDetection, VisionMode } from './vision/VisionSystem';
import {
  AutoSortController,
  type AutoSortDeps,
  type ControllerState,
  type SortReport,
} from './sorting/AutoSortController';

const GRIPPER_OPEN_OPENING = 0.18;
const GRIPPER_CLOSED_OPENING = 0.145;
const GRASP_ATTACH_TOLERANCE = 0.05;
const PICK_DURATION_SECONDS = 3.2;
const PLACE_DURATION_SECONDS = 3.8;
const PLANNED_TRAJECTORY_SAMPLES = 96;
const SAFE_HOME_TIME_SECONDS = 1.25;

interface PlannedSortTrajectory {
  ball: SortableBall;
  pickPosition: Vector3;
  pickWaypoints: JointWaypoint[];
  placeWaypoints: JointWaypoint[];
}

type ExecutionPhase = 'idle' | 'to-pick' | 'to-drop';

const logger = new Logger('RobotSimulator');
const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app container');
}

const scene = createScene();
const camera = createCamera();
const renderer = createRenderer(app);
const controls = createControls(camera, renderer);
const clock = new Clock();
const raycaster = new Raycaster();
const pointer = new Vector2();

const worldAxes = createAxes(0.5);
worldAxes.name = 'World coordinate frame';
scene.add(worldAxes);

const robot = new RobotArm();
robot.setGripperOpening(GRIPPER_OPEN_OPENING);
scene.add(robot.group);

const station = new SortingStation();
scene.add(station.group);

const trajectoryPositions: Vector3[] = [];
let trajectoryGeometry = new BufferGeometry();
const trajectoryLine = new Line(
  trajectoryGeometry,
  new LineBasicMaterial({ color: 0x39d98a, linewidth: 2 }),
);
trajectoryLine.name = 'Planned gripper trajectory';
scene.add(trajectoryLine);

let gui: RobotGuiApi | null = null;
let plannedSortTrajectory: PlannedSortTrajectory | null = null;
let executionPhase: ExecutionPhase = 'idle';
let carriedBall: SortableBall | null = null;
let operationStatus = 'select a ball';
let latestDetections: VisionDetection[] = [];
let selectedVisionDetection: VisionDetection | null = null;

const vision = new OfflineVisionSystem(() => station.getBalls());
scene.add(vision.group);

const onlineVision = new OnlineVisionSystem(renderer, scene);
onlineVision.hideDuringCapture = [vision.group, trajectoryLine, worldAxes];
scene.add(onlineVision.group);

let visionMode: VisionMode = 'online';
let autoState: ControllerState = 'idle';
let autoStatus = 'idle';
let latestReport: SortReport | null = null;

const autoDeps: AutoSortDeps = {
  vision: onlineVision,
  planAndExecute: (detection) => autoPlanAndExecute(detection),
  isArmBusy: () => player.isPlaying() || carriedBall !== null,
  onReport: (report) => {
    latestReport = report;
  },
  onState: (state, status) => {
    autoState = state;
    autoStatus = status;
    operationStatus = `auto: ${state} — ${status}`;
    refreshGui();
  },
};
const autoController = new AutoSortController(autoDeps);

const visionPanel = document.createElement('div');
visionPanel.className = 'vision-panel';
visionPanel.innerHTML = [
  '<strong>Overhead Vision Camera</strong>',
  '<div class="vision-preview"></div>',
  '<div class="vision-caption">Top-down camera stream with detected ball poses</div>',
  '<div class="vision-table"></div>',
].join('');
app.appendChild(visionPanel);
const visionPreview = visionPanel.querySelector<HTMLDivElement>('.vision-preview');
const visionTable = visionPanel.querySelector<HTMLDivElement>('.vision-table');
if (!visionPreview || !visionTable) {
  throw new Error('Missing vision panel elements');
}
const visionTableElement = visionTable;

const visionPreviewRenderer = new WebGLRenderer({ antialias: true, alpha: false });
visionPreviewRenderer.setSize(320, 240);
visionPreviewRenderer.setPixelRatio(1);
visionPreview.appendChild(visionPreviewRenderer.domElement);

const hud = document.createElement('div');
hud.className = 'hud';
app.appendChild(hud);

const player = new JointTrajectoryPlayer(
  robot,
  () => {
    recordGraspPosition();
  },
  () => {
    handleTrajectoryComplete();
  },
);

gui = createRobotGui({
  robot,
  onReset: () => {
    player.stop();
    robot.reset();
    robot.setGripperOpening(GRIPPER_OPEN_OPENING);
    plannedSortTrajectory = null;
    executionPhase = 'idle';
    operationStatus = 'reset';
    refreshGui();
    resetTrajectoryLine();
    logForwardKinematics();
  },
  onHome: () => {
    player.stop();
    robot.home();
    robot.setGripperOpening(GRIPPER_OPEN_OPENING);
    plannedSortTrajectory = null;
    executionPhase = 'idle';
    operationStatus = 'home pose';
    refreshGui();
    recordGraspPosition();
    logForwardKinematics();
  },
  onSolveIK: () => {
    solveSelectedBallIKDebug();
  },
  onPlanPickTrajectory: () => {
    planSelectedBallSortTrajectory();
  },
  onPickTarget: () => {
    executePlannedSortTrajectory();
  },
  onReleaseObject: () => {
    releaseCarriedBall();
  },
  ballIds: station.getBallIds(),
  getSelectedBallId: () => station.getSelectedBallId(),
  onSelectBall: (ballId) => {
    const selected = ballId === 'none' ? null : station.selectBallById(ballId);
    plannedSortTrajectory = null;
    operationStatus = selected ? `selected ${selected.id} (${selected.color})` : 'select a ball';
    resetTrajectoryLine();
    refreshGui();
  },
  onRunVisionDetection: () => {
    runVisionDetection();
  },
  onPlanFromVision: () => {
    planFromVisionDetection();
  },
  onPickVisionResult: () => {
    if (!plannedSortTrajectory) {
      planFromVisionDetection();
    }
    executePlannedSortTrajectory();
  },
  onAutoStart: () => {
    latestReport = null;
    autoController.start();
  },
  onAutoStop: () => {
    autoController.stop();
  },
  onVisionModeChanged: (mode) => {
    visionMode = mode;
    autoDeps.vision = mode === 'online' ? onlineVision : vision;
    operationStatus = `vision mode: ${mode}`;
  },
  onPlayTrajectory: () => {
    plannedSortTrajectory = null;
    executionPhase = 'idle';
    operationStatus = 'demo trajectory';
    resetTrajectoryLine();
    player.setWaypoints(createDefaultTrajectory(robot.getJointAngles()));
    player.play();
  },
  onFramesVisibleChanged: (visible) => {
    robot.setFramesVisible(visible);
  },
  onTrajectoryVisibleChanged: (visible) => {
    trajectoryLine.visible = visible;
  },
});

robot.setFramesVisible(true);
recordGraspPosition();
logForwardKinematics();
animate();

window.addEventListener('resize', onResize);
renderer.domElement.addEventListener('pointerdown', onPointerDown);

function animate(): void {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  station.update(delta);
  player.update(delta);
  autoController.tick();
  controls.update();
  updateHud();
  updateVisionPanel();
  renderVisionPreview();
  renderer.render(scene, camera);
}

function onResize(): void {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

function onPointerDown(event: PointerEvent): void {
  if (player.isPlaying() || carriedBall) {
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const intersections = raycaster.intersectObjects(station.getSelectableMeshes(), false);
  if (intersections.length === 0) {
    return;
  }

  const selected = station.selectBallFromObject(intersections[0].object);
  plannedSortTrajectory = null;
  operationStatus = selected ? `selected ${selected.id} (${selected.color})` : 'select a ball';
  resetTrajectoryLine();
  refreshGui();
}

function solveSelectedBallIKDebug(): void {
  const selected = station.getSelectedBall();
  if (!selected) {
    operationStatus = 'no selected ball';
    return;
  }

  const target = station.createPlanTarget(selected);
  const result = solveIK({ position: target.pickPosition }, robot.getJointAngles(), {
    maxIterations: 160,
    threshold: 0.012,
    gain: 0.76,
    toolOffset: vectorFromTuple(GRIPPER_GRASP_OFFSET),
  });
  robot.setJointAngles(result.jointAngles);
  operationStatus = `IK debug ${result.success ? 'ok' : 'stopped'} error=${result.error.toFixed(3)}m`;
  refreshGui();
}

function planSelectedBallSortTrajectory(): void {
  const selected = station.getSelectedBall();
  if (!selected) {
    plannedSortTrajectory = null;
    operationStatus = 'select a ball before planning';
    resetTrajectoryLine();
    return;
  }

  player.stop();
  releaseCarriedBall();
  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  const target = station.createPlanTarget(selected);
  planSortTrajectoryForTarget(target, 'manual');
}

function runVisionDetection(): void {
  latestDetections = vision.detectBalls();
  selectedVisionDetection = latestDetections[0] ?? null;
  const selected = selectedVisionDetection?.ballId
    ? station.selectBallById(selectedVisionDetection.ballId)
    : null;
  operationStatus = selectedVisionDetection
    ? `vision detected ${latestDetections.length}; selected ${selectedVisionDetection.ballId}`
    : 'vision detected no balls';
  plannedSortTrajectory = null;
  resetTrajectoryLine();
  refreshGui();
  logger.info(operationStatus, selected?.id);
}

function planFromVisionDetection(): void {
  if (!selectedVisionDetection) {
    runVisionDetection();
  }

  if (!selectedVisionDetection) {
    operationStatus = 'vision planning failed: no detection';
    return;
  }

  const ball = selectedVisionDetection.ballId
    ? station.getBallById(selectedVisionDetection.ballId)
    : null;
  if (!ball) {
    operationStatus = `vision planning failed: missing ${selectedVisionDetection.ballId}`;
    return;
  }

  station.selectBallById(ball.id);
  player.stop();
  releaseCarriedBall();
  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  const target = station.createPlanTargetFromPosition(
    ball,
    selectedVisionDetection.estimatedWorldPosition.clone(),
  );
  planSortTrajectoryForTarget(target, 'vision');
}

function autoPlanAndExecute(detection: VisionDetection): 'started' | 'unreachable' {
  const ball = findNearestBall(detection.estimatedWorldPosition);
  if (!ball) {
    return 'unreachable';
  }
  station.selectBallById(ball.id);
  player.stop();
  releaseCarriedBall();
  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  // Recognition (color + which ball) is online; the grasp uses the matched ball's actual
  // pose so back-projection error does not cause spurious missed grasps.
  const target = station.createPlanTarget(ball);
  planSortTrajectoryForTarget(target, 'vision');
  if (!plannedSortTrajectory) {
    return 'unreachable';
  }
  executePlannedSortTrajectory();
  return 'started';
}

function findNearestBall(worldPosition: Vector3): SortableBall | null {
  let nearest: SortableBall | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  station.getBalls().forEach((ball) => {
    if (ball.mesh.parent !== station.group) {
      return;
    }
    const position = new Vector3();
    ball.mesh.getWorldPosition(position);
    const distance = position.distanceTo(worldPosition);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = ball;
    }
  });
  return nearestDistance <= 0.35 ? nearest : null;
}

function planSortTrajectoryForTarget(target: SortPlanTarget, source: 'manual' | 'vision'): void {
  const toolOffset = vectorFromTuple(GRIPPER_GRASP_OFFSET);
  const startAngles = robot.getJointAngles();

  const safePrePickResult = solveGroundSafeIK(target.prePickPosition, startAngles, toolOffset, 0.02);
  if (!safePrePickResult || (!safePrePickResult.success && safePrePickResult.error > 0.08)) {
    failPlanning('pre-pick unreachable without ground collision');
    return;
  }

  const pickResult = solveGroundSafeIK(
    target.pickPosition,
    safePrePickResult.jointAngles,
    toolOffset,
    0.014,
  );
  if (!pickResult || (!pickResult.success && pickResult.error > GRASP_ATTACH_TOLERANCE)) {
    failPlanning('pick unreachable without ground collision');
    return;
  }

  const liftResult = solveGroundSafeIK(target.liftPosition, pickResult.jointAngles, toolOffset, 0.02);
  if (!liftResult || (!liftResult.success && liftResult.error > 0.08)) {
    failPlanning('lift unreachable without ground collision');
    return;
  }

  const dropResult = solveGroundSafeIK(target.dropPosition, liftResult.jointAngles, toolOffset, 0.025);
  if (!dropResult || (!dropResult.success && dropResult.error > 0.1)) {
    failPlanning('drop unreachable without ground collision');
    return;
  }

  plannedSortTrajectory = {
    ball: target.ball,
    pickPosition: target.pickPosition.clone(),
    pickWaypoints: [
      { time: 0, jointAngles: startAngles },
      { time: PICK_DURATION_SECONDS * 0.68, jointAngles: safePrePickResult.jointAngles },
      { time: PICK_DURATION_SECONDS, jointAngles: pickResult.jointAngles },
    ],
    placeWaypoints: [
      { time: 0, jointAngles: pickResult.jointAngles },
      { time: PLACE_DURATION_SECONDS * 0.35, jointAngles: liftResult.jointAngles },
      { time: PLACE_DURATION_SECONDS, jointAngles: dropResult.jointAngles },
    ],
  };
  plannedSortTrajectory.pickWaypoints = findGroundSafeWaypointRoute(
    plannedSortTrajectory.pickWaypoints,
    toolOffset,
  );
  plannedSortTrajectory.placeWaypoints = findGroundSafeWaypointRoute(
    plannedSortTrajectory.placeWaypoints,
    toolOffset,
  );
  const pickClearance = checkTrajectoryGroundClearance(
    plannedSortTrajectory.pickWaypoints,
    toolOffset,
  );
  const placeClearance = checkTrajectoryGroundClearance(
    plannedSortTrajectory.placeWaypoints,
    toolOffset,
  );
  if (!pickClearance.safe || !placeClearance.safe) {
    const minY = Math.min(pickClearance.minY, placeClearance.minY);
    failPlanning(`ground collision minY=${minY.toFixed(3)}m`);
    return;
  }
  const minClearanceY = Math.min(pickClearance.minY, placeClearance.minY);
  operationStatus = `planned ${source} ${target.ball.id} -> ${target.ball.targetBin}; minY=${minClearanceY.toFixed(
    3,
  )}m`;
  previewSortTrajectory(plannedSortTrajectory);
  refreshGui();
  logger.info(operationStatus);
}

function failPlanning(reason: string): void {
  plannedSortTrajectory = null;
  operationStatus = `planning failed: ${reason}`;
  resetTrajectoryLine();
  refreshGui();
  logger.warn(operationStatus);
}

function solveGroundSafeIK(
  targetPosition: Vector3,
  currentAngles: number[],
  toolOffset: Vector3,
  threshold: number,
): IKResult | null {
  const seeds = createGroundSafeIkSeeds(currentAngles, targetPosition);
  let bestSafeResult: IKResult | null = null;
  let bestUnsafeMinY = Number.POSITIVE_INFINITY;

  seeds.forEach((seed) => {
    const result = solveIK({ position: targetPosition }, seed, {
      maxIterations: 220,
      threshold,
      gain: 0.74,
      toolOffset,
    });
    const clearance = checkGroundClearance(result.jointAngles, toolOffset);
    if (!clearance.safe) {
      bestUnsafeMinY = Math.min(bestUnsafeMinY, clearance.minY);
      return;
    }
    if (!bestSafeResult || result.error < bestSafeResult.error) {
      bestSafeResult = result;
    }
  });

  if (!bestSafeResult && Number.isFinite(bestUnsafeMinY)) {
    logger.warn(`All IK candidates collide with ground; best minY=${bestUnsafeMinY.toFixed(3)}m`);
  }
  return bestSafeResult;
}

function createGroundSafeIkSeeds(currentAngles: number[], targetPosition?: Vector3): number[][] {
  const targetYaw = targetPosition ? Math.atan2(-targetPosition.z, targetPosition.x) : currentAngles[0] ?? 0;
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

function findGroundSafeWaypointRoute(waypoints: JointWaypoint[], toolOffset: Vector3): JointWaypoint[] {
  const directClearance = checkTrajectoryGroundClearance(waypoints, toolOffset);
  if (directClearance.safe) {
    return waypoints;
  }

  const start = waypoints[0];
  const viaHome: JointWaypoint[] = [
    { time: 0, jointAngles: start.jointAngles },
    { time: SAFE_HOME_TIME_SECONDS, jointAngles: HOME_POSE },
    ...waypoints.slice(1).map((waypoint) => ({
      time: waypoint.time + SAFE_HOME_TIME_SECONDS,
      jointAngles: waypoint.jointAngles,
    })),
  ];
  const homeClearance = checkTrajectoryGroundClearance(viaHome, toolOffset);
  if (homeClearance.safe) {
    return viaHome;
  }

  const viaLiftedStart: JointWaypoint[] = [
    start,
    { time: SAFE_HOME_TIME_SECONDS, jointAngles: [start.jointAngles[0] ?? 0, -0.9, 1.45, 0, 0.7, 0] },
    ...waypoints.slice(1).map((waypoint) => ({
      time: waypoint.time + SAFE_HOME_TIME_SECONDS,
      jointAngles: waypoint.jointAngles,
    })),
  ];
  const liftedClearance = checkTrajectoryGroundClearance(viaLiftedStart, toolOffset);
  if (liftedClearance.safe) {
    return viaLiftedStart;
  }

  logger.warn(
    `No ground-safe route found; direct minY=${directClearance.minY.toFixed(3)}m, home minY=${homeClearance.minY.toFixed(
      3,
    )}m, lifted minY=${liftedClearance.minY.toFixed(3)}m`,
  );
  return waypoints;
}

function executePlannedSortTrajectory(): void {
  if (!plannedSortTrajectory) {
    operationStatus = 'plan trajectory first';
    return;
  }

  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  carriedBall = null;
  executionPhase = 'to-pick';
  operationStatus = `moving to pick ${plannedSortTrajectory.ball.id}`;
  resetTrajectoryLine();
  player.setWaypoints(plannedSortTrajectory.pickWaypoints);
  player.play();
  refreshGui();
}

function handleTrajectoryComplete(): void {
  if (!plannedSortTrajectory) {
    executionPhase = 'idle';
    return;
  }

  if (executionPhase === 'to-pick') {
    const graspError = robot.getGraspPose().position.distanceTo(plannedSortTrajectory.pickPosition);
    if (graspError > GRASP_ATTACH_TOLERANCE) {
      robot.setGripperOpening(GRIPPER_OPEN_OPENING);
      executionPhase = 'idle';
      plannedSortTrajectory = null;
      operationStatus = `pick failed error=${graspError.toFixed(3)}m`;
      refreshGui();
      autoController.onTrajectoryComplete(false);
      return;
    }

    robot.setGripperOpening(GRIPPER_CLOSED_OPENING);
    station.attachBallToGripper(
      plannedSortTrajectory.ball,
      robot.endEffector,
      vectorFromTuple(GRIPPER_GRASP_OFFSET),
    );
    carriedBall = plannedSortTrajectory.ball;
    executionPhase = 'to-drop';
    operationStatus = `carrying ${carriedBall.id} to ${carriedBall.targetBin}`;
    player.setWaypoints(plannedSortTrajectory.placeWaypoints);
    player.play();
    refreshGui();
    autoController.onTrajectoryComplete(true);
    return;
  }

  if (executionPhase === 'to-drop') {
    releaseCarriedBall();
    plannedSortTrajectory = null;
    executionPhase = 'idle';
    autoController.onTrajectoryComplete(true);
  }
}

function releaseCarriedBall(): void {
  if (!carriedBall) {
    robot.setGripperOpening(GRIPPER_OPEN_OPENING);
    return;
  }

  const releasePosition = robot.getGraspPose().position.clone();
  station.releaseBallFromGripper(carriedBall, releasePosition);
  operationStatus = `released ${carriedBall.id} above ${carriedBall.targetBin}`;
  carriedBall = null;
  robot.setGripperOpening(GRIPPER_OPEN_OPENING);
  refreshGui();
}

function previewSortTrajectory(plan: PlannedSortTrajectory): void {
  trajectoryPositions.length = 0;
  appendTrajectoryPreview(plan.pickWaypoints);
  appendTrajectoryPreview(plan.placeWaypoints);
  updateTrajectoryGeometry();
}

function appendTrajectoryPreview(waypoints: JointWaypoint[]): void {
  const duration = waypoints[waypoints.length - 1].time;
  for (let sample = 0; sample <= PLANNED_TRAJECTORY_SAMPLES; sample += 1) {
    const elapsed = (sample / PLANNED_TRAJECTORY_SAMPLES) * duration;
    const jointAngles = sampleJointTrajectory(waypoints, elapsed);
    const graspState = computeVisualChainState(jointAngles, vectorFromTuple(GRIPPER_GRASP_OFFSET));
    trajectoryPositions.push(graspState.endEffectorPosition.clone());
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

function recordGraspPosition(): void {
  const pose = robot.getGraspPose();
  const last = trajectoryPositions[trajectoryPositions.length - 1];
  if (!last || last.distanceToSquared(pose.position) > 0.00008) {
    trajectoryPositions.push(pose.position.clone());
    updateTrajectoryGeometry();
  }
}

function resetTrajectoryLine(): void {
  trajectoryPositions.length = 0;
  recordGraspPosition();
}

function updateTrajectoryGeometry(): void {
  const positionArray = new Float32Array(trajectoryPositions.length * 3);
  trajectoryPositions.forEach((point, index) => {
    positionArray[index * 3] = point.x;
    positionArray[index * 3 + 1] = point.y;
    positionArray[index * 3 + 2] = point.z;
  });

  const nextGeometry = new BufferGeometry();
  nextGeometry.setAttribute('position', new Float32BufferAttribute(positionArray, 3));
  trajectoryLine.geometry.dispose();
  trajectoryLine.geometry = nextGeometry;
  trajectoryGeometry = nextGeometry;
}

function refreshGui(): void {
  gui?.refreshJointAngles();
}

function logForwardKinematics(): void {
  const fkPose = forwardKinematics(robot.getJointAngles());
  logger.info(`FK position: ${formatVector(fkPose.position)}`);
}

function updateHud(): void {
  const visualPose = robot.getEndEffectorPose();
  const fkPose = forwardKinematics(robot.getJointAngles());
  const dhPose = forwardKinematicsDH(robot.getJointAngles());
  const orientation = visualPose.orientation;
  hud.innerHTML = [
    '<strong>Vision Sorting Station</strong>',
    `Mode: ${visionMode} | Auto: ${autoState} — ${autoStatus}`,
    formatAutoReport(),
    `Selected: ${station.getStatusLabel()}`,
    `Operation: ${operationStatus}`,
    `Vision: ${formatVisionStatus()}`,
    `Gripper opening: ${robot.getGripperOpening().toFixed(3)} m`,
    `Visual EE position: ${formatVector(visualPose.position)} m`,
    `FK position: ${formatVector(fkPose.position)} m`,
    `DH interface: ${formatVector(dhPose.position)} m`,
    `EE quaternion: ${formatQuaternion(orientation)}`,
    `Trajectory: ${player.isPlaying() ? executionPhase : 'idle'} | samples: ${trajectoryPositions.length}`,
  ].join('<br />');
}

function formatAutoReport(): string {
  if (!latestReport) {
    return 'Report: —';
  }
  const skips = latestReport.skipped
    .map((decision) => `${decision.detection.ballId ?? 'ball'}:${decision.skipReason}`)
    .join(', ');
  const blind = latestReport.endedBlind ? ' [blind halt]' : '';
  return `Report: ${latestReport.sortedCount}/${latestReport.totalSeen} sorted${blind}; skipped: ${skips || 'none'}`;
}

function formatVisionStatus(): string {
  if (!selectedVisionDetection) {
    return `${latestDetections.length} detections`;
  }
  return `${latestDetections.length} detections, ${selectedVisionDetection.ballId} px=${selectedVisionDetection.pixel.x.toFixed(
    0,
  )},${selectedVisionDetection.pixel.y.toFixed(0)} conf=${selectedVisionDetection.confidence.toFixed(2)}`;
}

function updateVisionPanel(): void {
  const rows = latestDetections
    .slice(0, 10)
    .map(
      (detection) =>
        `<div class="vision-row ${detection.ballId === selectedVisionDetection?.ballId ? 'active' : ''}">
          <span>${detection.ballId}</span>
          <span>${detection.color}</span>
          <span>${detection.pixel.x.toFixed(0)},${detection.pixel.y.toFixed(0)}</span>
          <span>${formatVector(detection.estimatedWorldPosition, 2)}</span>
        </div>`,
    )
    .join('');
  visionTableElement.innerHTML = [
    '<div class="vision-head"><span>ID</span><span>Color</span><span>Pixel</span><span>World</span></div>',
    rows || '<div class="vision-empty">Run detection</div>',
  ].join('');
}

function renderVisionPreview(): void {
  const previousVisibility = vision.group.visible;
  vision.group.visible = false;
  visionPreviewRenderer.render(scene, vision.camera);
  vision.group.visible = previousVisibility;
}

function formatQuaternion(quaternion: Quaternion): string {
  return `${quaternion.x.toFixed(3)}, ${quaternion.y.toFixed(3)}, ${quaternion.z.toFixed(
    3,
  )}, ${quaternion.w.toFixed(3)}`;
}
