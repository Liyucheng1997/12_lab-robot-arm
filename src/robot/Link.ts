import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';

export class Link {
  readonly group = new Group();

  constructor(
    readonly name: string,
    readonly offset: Vector3,
    radius: number,
    color: number,
  ) {
    this.group.name = name;
    this.group.add(this.createLinkMesh(offset, radius, color));
  }

  /**
   * Replace this placeholder geometry with a glTF visual mesh while keeping the same kinematic frame.
   */
  replaceVisual(mesh: Mesh): void {
    this.group.clear();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private createLinkMesh(offset: Vector3, radius: number, color: number): Mesh {
    const length = offset.length();
    const material = new MeshStandardMaterial({
      color,
      metalness: 0.35,
      roughness: 0.42,
    });

    if (length <= 0.001) {
      const mesh = new Mesh(new BoxGeometry(radius, radius, radius), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    }

    const mesh = new Mesh(new CylinderGeometry(radius, radius, length, 24), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const midpoint = offset.clone().multiplyScalar(0.5);
    mesh.position.copy(midpoint);

    const cylinderUp = new Vector3(0, 1, 0);
    const direction = offset.clone().normalize();
    mesh.quaternion.copy(new Quaternion().setFromUnitVectors(cylinderUp, direction));
    return mesh;
  }
}
