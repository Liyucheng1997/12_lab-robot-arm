# 工业机械臂视觉分拣仿真

基于 Three.js、Cannon-es 和 TypeScript 构建的六自由度工业机械臂仿真系统。系统通过固定前置相机实时读取渲染像素，识别红、蓝小球的位置与颜色，并自动完成抓取、避障和分类。

当前版本：**1.5.0**

## 功能

- 六自由度机械臂、夹爪和正向/逆向运动学
- 红、蓝小球与三个物理料盒
- 基于相机像素的在线颜色识别
- HSV 分割、连通域检测和相邻小球中心拆分
- 像素坐标反投影到世界坐标
- 自动执行观察、规划、抓取、搬运和放置流程
- 机械臂自碰撞、地面碰撞和料盒体积碰撞检测
- 安全过渡点与轨迹采样验证
- 在线视觉和离线真值调试模式切换
- 实时检测结果、轨迹、坐标系和运行报告

## 在线视觉

在线模式不会读取小球的预设位置或颜色。每次检测按以下流程运行：

```text
前置相机渲染
  -> 读取 RGBA 像素
  -> HSV 红蓝分割
  -> 连通域分析
  -> 相邻球中心拆分
  -> 像素质心反投影
  -> 生成抓取目标
```

检测窗口只显示识别出的颜色区域和质心。相机视野覆盖左、中、右三个料盒，因此可以观察小球从灰色源盒移动到红色或蓝色目标盒的过程。

自动分拣仅将灰色源盒中的检测结果作为待抓目标，已经进入目标盒的小球仍会显示在检测结果中，但不会被重复抓取。

## 技术栈

- TypeScript 5
- Three.js
- Cannon-es
- lil-gui
- Vite
- Vitest
- ESLint

## 运行要求

- Node.js 18 或更高版本
- 支持 WebGL2 的桌面浏览器

## 快速开始

```bash
npm install
npm run dev
```

打开终端中 Vite 输出的地址，默认通常为：

```text
http://localhost:5173
```

## 操作方式

### 自动分拣

1. 在 **Auto Sort** 中选择 `online`。
2. 点击 **Start**。
3. 系统持续执行识别、抓取和分类，直到灰色源盒中没有可处理的小球。
4. HUD 显示当前状态、检测数量和最终报告。

### 手动调试

- **Manual Sorting**：选择指定小球并规划或执行抓取。
- **Vision (manual debug)**：单独运行检测、根据检测结果规划和抓取。
- **Vision mode**：
  - `online`：从实时相机像素计算检测结果。
  - `offline`：使用场景真值，用于比较和调试。
- **Visualization**：显示机械臂坐标系和末端轨迹。

## 碰撞安全

轨迹规划会检查：

- 机械臂连杆之间的自碰撞
- 连杆和夹爪与地面的碰撞
- 连杆和夹爪与三个料盒底板、侧壁的碰撞
- 插值轨迹中的中间姿态，而不只是起点和终点

抓取和放置路径包含抬升及安全过渡点。若找不到满足逆运动学和碰撞约束的路径，该目标会被报告为不可达，而不会强制执行。

## 测试与构建

```bash
npm test
npm run lint
npm run build
```

当前测试覆盖：

- HSV 像素分类与连通域检测
- 相邻同色小球拆分
- 自动分拣控制器状态转换
- 机械臂自碰撞检测
- 所有初始小球的无碰撞可达性

## 项目结构

```text
src/
├── robot/       # 机械臂模型、运动学、轨迹和碰撞检测
├── scene/       # Three.js 场景、相机、灯光和渲染器
├── sorting/     # 料盒、小球物理和自动分拣控制器
├── vision/      # 在线/离线视觉、图像处理和相机配置
├── ui/          # lil-gui 控制界面
├── utils/       # 数学、坐标轴和日志工具
└── main.ts      # 应用组装与运行循环

tests/unit/      # Vitest 单元与可达性测试
specs/           # 功能规格、设计和接口文档
```

## 设计文档

详细需求、设计和验证场景位于：

- [`specs/001-online-vision-sorting/spec.md`](specs/001-online-vision-sorting/spec.md)
- [`specs/001-online-vision-sorting/plan.md`](specs/001-online-vision-sorting/plan.md)
- [`specs/001-online-vision-sorting/quickstart.md`](specs/001-online-vision-sorting/quickstart.md)

