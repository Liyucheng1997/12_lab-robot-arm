import type { RobotDescription } from '../types/robot';

export async function loadURDF(url: string): Promise<RobotDescription> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load URDF from ${url}: ${response.status}`);
  }

  const xml = await response.text();

  // TODO: Parse URDF XML into RobotDescription, load mesh assets, and map URDF axes to Three.js frames.
  return {
    name: extractRobotName(xml) ?? 'URDF Robot',
    links: [],
    joints: [],
  };
}

function extractRobotName(xml: string): string | null {
  const match = xml.match(/<robot[^>]*name=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

export class WebSocketRobotBridge {
  private socket: WebSocket | null = null;

  connect(url: string): void {
    this.socket = new WebSocket(url);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
  }

  sendJointCommand(jointAngles: number[]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    // TODO: Adapt this payload to ROSBridge sensor_msgs/JointState or trajectory_msgs messages.
    this.socket.send(
      JSON.stringify({
        type: 'joint_command',
        jointAngles,
        timestamp: Date.now(),
      }),
    );
  }
}
