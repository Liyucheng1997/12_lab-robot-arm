import GUI from 'lil-gui';
import type { RobotArm } from '../robot/RobotArm';
import { DEFAULT_JOINT_CONFIGS } from '../robot/limits';
import { degToRad, radToDeg } from '../utils/math';

export interface RobotGuiApi {
  refreshJointAngles(): void;
  destroy(): void;
}

interface RobotGuiOptions {
  robot: RobotArm;
  onReset: () => void;
  onHome: () => void;
  onSolveIK: () => void;
  onPlanPickTrajectory: () => void;
  onPickTarget: () => void;
  onReleaseObject: () => void;
  ballIds: string[];
  getSelectedBallId: () => string;
  onSelectBall: (ballId: string) => void;
  onRunVisionDetection: () => void;
  onPlanFromVision: () => void;
  onPickVisionResult: () => void;
  onPlayTrajectory: () => void;
  onFramesVisibleChanged: (visible: boolean) => void;
  onTrajectoryVisibleChanged: (visible: boolean) => void;
}

export function createRobotGui(options: RobotGuiOptions): RobotGuiApi {
  const gui = new GUI({ title: 'Industrial Robot Arm' });
  const jointState = Object.fromEntries(
    options.robot.getJointAngles().map((angle, index) => [`J${index + 1}`, radToDeg(angle)]),
  ) as Record<string, number>;
  const viewState = {
    coordinateFrames: true,
    endEffectorTrajectory: true,
  };
  const gripperState = {
    opening: options.robot.getGripperOpening(),
  };
  const sortingState = {
    selectedBall: options.getSelectedBallId(),
  };
  const actions = {
    reset: options.onReset,
    homePose: options.onHome,
    solveIK: options.onSolveIK,
    planPickTrajectory: options.onPlanPickTrajectory,
    pickTarget: options.onPickTarget,
    releaseObject: options.onReleaseObject,
    runVisionDetection: options.onRunVisionDetection,
    planFromVision: options.onPlanFromVision,
    pickVisionResult: options.onPickVisionResult,
    playTrajectory: options.onPlayTrajectory,
  };

  const jointFolder = gui.addFolder('Joints');
  const jointControllers = DEFAULT_JOINT_CONFIGS.map((config, index) => {
    const key = `J${index + 1}`;
    return jointFolder
      .add(jointState, key, radToDeg(config.limit.min), radToDeg(config.limit.max), 0.1)
      .name(config.name)
      .onChange((degrees: number) => {
        options.robot.setJointAngle(index, degToRad(degrees));
      });
  });

  const sortingFolder = gui.addFolder('Manual Sorting');
  const selectedBallController = sortingFolder
    .add(sortingState, 'selectedBall', ['none', ...options.ballIds])
    .name('Selected ball')
    .onChange((ballId: string) => {
      options.onSelectBall(ballId);
    });
  sortingFolder.add(actions, 'planPickTrajectory').name('Plan trajectory');
  sortingFolder.add(actions, 'pickTarget').name('Pick selected ball');
  sortingFolder.add(actions, 'releaseObject').name('Release object');
  sortingFolder.add(actions, 'solveIK').name('Solve IK debug');

  const visionFolder = gui.addFolder('Offline Vision');
  visionFolder.add(actions, 'runVisionDetection').name('Run detection');
  visionFolder.add(actions, 'planFromVision').name('Plan from vision');
  visionFolder.add(actions, 'pickVisionResult').name('Pick vision result');

  const endEffectorFolder = gui.addFolder('End Effector');
  const gripperController = endEffectorFolder
    .add(gripperState, 'opening', 0.025, 0.18, 0.001)
    .name('Gripper opening')
    .onChange((opening: number) => {
      options.robot.setGripperOpening(opening);
    });

  const viewFolder = gui.addFolder('Visualization');
  viewFolder
    .add(viewState, 'coordinateFrames')
    .name('Show coordinate frames')
    .onChange(options.onFramesVisibleChanged);
  viewFolder
    .add(viewState, 'endEffectorTrajectory')
    .name('Show EE trajectory')
    .onChange(options.onTrajectoryVisibleChanged);

  gui.add(actions, 'reset').name('Reset');
  gui.add(actions, 'homePose').name('Home Pose');
  gui.add(actions, 'playTrajectory').name('Play trajectory');

  return {
    refreshJointAngles(): void {
      options.robot.getJointAngles().forEach((angle, index) => {
        const key = `J${index + 1}`;
        jointState[key] = radToDeg(angle);
        jointControllers[index].updateDisplay();
      });
      gripperState.opening = options.robot.getGripperOpening();
      gripperController.updateDisplay();
      sortingState.selectedBall = options.getSelectedBallId();
      selectedBallController.updateDisplay();
    },
    destroy(): void {
      gui.destroy();
    },
  };
}
