import GUI from 'lil-gui';
import type { RobotArm } from '../robot/RobotArm';
import { DEFAULT_JOINT_CONFIGS } from '../robot/limits';
import { degToRad, radToDeg } from '../utils/math';

export interface RobotGuiApi {
  refreshJointAngles(): void;
  destroy(): void;
}

interface RobotGuiOptions {
  robots: RobotArm[];
  robotLabels: string[];
  onProductionStart: () => void;
  onProductionStop: () => void;
  onSpeedChanged: (multiplier: number) => void;
  onBloomChanged: (enabled: boolean) => void;
  onOrbitChanged: (enabled: boolean) => void;
  onPreviewStationChanged: (station: number) => void;
  onDetectionMarkersChanged: (visible: boolean) => void;
  onFramesVisibleChanged: (visible: boolean) => void;
  onTrajectoryVisibleChanged: (visible: boolean) => void;
  onReset: () => void;
  onHome: () => void;
}

export function createRobotGui(options: RobotGuiOptions): RobotGuiApi {
  const gui = new GUI({ title: '轮毂装配线 LINE-01' });

  const productionState = {
    speed: 1,
    start: options.onProductionStart,
    stop: options.onProductionStop,
  };
  const viewState = {
    bloom: true,
    orbitCamera: false,
    previewStation: options.robotLabels[0] ?? 'ST1',
    detectionMarkers: true,
    coordinateFrames: false,
    endEffectorTrajectory: true,
  };
  const manualState = {
    selectedRobot: options.robotLabels[0] ?? 'ST1',
  };
  let selectedIndex = 0;
  const selectedRobot = (): RobotArm => options.robots[selectedIndex];

  const jointState = Object.fromEntries(
    selectedRobot()
      .getJointAngles()
      .map((angle, index) => [`J${index + 1}`, radToDeg(angle)]),
  ) as Record<string, number>;
  const gripperState = {
    opening: selectedRobot().getGripperOpening(),
  };
  const actions = {
    reset: options.onReset,
    homePose: options.onHome,
  };

  const productionFolder = gui.addFolder('生产控制');
  productionFolder.add(productionState, 'start').name('▶ 启动产线');
  productionFolder.add(productionState, 'stop').name('■ 停止产线');
  productionFolder
    .add(productionState, 'speed', 0.5, 2.5, 0.1)
    .name('节拍倍率')
    .onChange(options.onSpeedChanged);

  const visualFolder = gui.addFolder('视觉效果');
  visualFolder.add(viewState, 'bloom').name('辉光 Bloom').onChange(options.onBloomChanged);
  visualFolder.add(viewState, 'orbitCamera').name('环绕镜头').onChange(options.onOrbitChanged);
  visualFolder
    .add(viewState, 'previewStation', options.robotLabels)
    .name('视觉预览工位')
    .onChange((label: string) => {
      options.onPreviewStationChanged(Math.max(0, options.robotLabels.indexOf(label)));
    });
  visualFolder
    .add(viewState, 'detectionMarkers')
    .name('视觉检测标记')
    .onChange(options.onDetectionMarkersChanged);
  visualFolder
    .add(viewState, 'coordinateFrames')
    .name('坐标系显示')
    .onChange(options.onFramesVisibleChanged);
  visualFolder
    .add(viewState, 'endEffectorTrajectory')
    .name('末端轨迹显示')
    .onChange(options.onTrajectoryVisibleChanged);

  const jointFolder = gui.addFolder('关节手动调试');
  jointFolder.close();
  const refreshFromSelected = (): void => {
    selectedRobot()
      .getJointAngles()
      .forEach((angle, index) => {
        jointState[`J${index + 1}`] = radToDeg(angle);
      });
    gripperState.opening = selectedRobot().getGripperOpening();
    jointControllers.forEach((controller) => controller.updateDisplay());
    gripperController.updateDisplay();
  };
  jointFolder
    .add(manualState, 'selectedRobot', options.robotLabels)
    .name('机器人')
    .onChange((label: string) => {
      selectedIndex = Math.max(0, options.robotLabels.indexOf(label));
      refreshFromSelected();
    });
  const jointControllers = DEFAULT_JOINT_CONFIGS.map((config, index) => {
    const key = `J${index + 1}`;
    return jointFolder
      .add(jointState, key, radToDeg(config.limit.min), radToDeg(config.limit.max), 0.1)
      .name(config.name)
      .onChange((degrees: number) => {
        selectedRobot().setJointAngle(index, degToRad(degrees));
      });
  });
  const gripperController = jointFolder
    .add(gripperState, 'opening', 0.025, 0.18, 0.001)
    .name('夹爪开度')
    .onChange((opening: number) => {
      selectedRobot().setGripperOpening(opening);
    });
  jointFolder.add(actions, 'reset').name('全部回零位');
  jointFolder.add(actions, 'homePose').name('全部回待机位');

  return {
    refreshJointAngles(): void {
      refreshFromSelected();
    },
    destroy(): void {
      gui.destroy();
    },
  };
}
