import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
  Vector3,
} from 'three';

interface FlashRing {
  mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  elapsed: number;
  duration: number;
}

interface SparkBurst {
  points: Points<BufferGeometry, PointsMaterial>;
  velocities: Vector3[];
  elapsed: number;
  duration: number;
}

/**
 * Lightweight scripted effects: an expanding confirmation ring when a part is
 * seated, and an additive spark burst while the nut is torqued down.
 */
export class EffectsManager {
  readonly group = new Group();
  private readonly rings: FlashRing[] = [];
  private readonly bursts: SparkBurst[] = [];

  constructor() {
    this.group.name = 'Cell effects';
  }

  /** Expanding flat ring, e.g. green for a seated part. */
  spawnFlashRing(position: Vector3, color: number, duration = 0.7): void {
    const mesh = new Mesh(
      new RingGeometry(0.05, 0.075, 40),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    mesh.position.copy(position);
    mesh.rotation.x = -Math.PI / 2;
    this.group.add(mesh);
    this.rings.push({ mesh, elapsed: 0, duration });
  }

  /** Short additive spark burst, e.g. while fastening the hub nut. */
  spawnSparks(position: Vector3, count = 46, duration = 0.65): void {
    const positions = new Float32Array(count * 3);
    const velocities: Vector3[] = [];
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 1.4;
      velocities.push(
        new Vector3(
          Math.cos(angle) * speed * (0.35 + Math.random() * 0.65),
          0.6 + Math.random() * 1.6,
          Math.sin(angle) * speed * (0.35 + Math.random() * 0.65),
        ),
      );
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: new Color(0xffc964),
      size: 0.016,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const points = new Points(geometry, material);
    this.group.add(points);
    this.bursts.push({ points, velocities, elapsed: 0, duration });
  }

  update(delta: number): void {
    for (let i = this.rings.length - 1; i >= 0; i -= 1) {
      const ring = this.rings[i];
      ring.elapsed += delta;
      const t = Math.min(ring.elapsed / ring.duration, 1);
      const scale = 1 + t * 4.2;
      ring.mesh.scale.set(scale, scale, scale);
      ring.mesh.material.opacity = 0.95 * (1 - t);
      if (t >= 1) {
        this.disposeRing(ring);
        this.rings.splice(i, 1);
      }
    }

    for (let i = this.bursts.length - 1; i >= 0; i -= 1) {
      const burst = this.bursts[i];
      burst.elapsed += delta;
      const t = Math.min(burst.elapsed / burst.duration, 1);
      const attribute = burst.points.geometry.getAttribute('position');
      for (let p = 0; p < burst.velocities.length; p += 1) {
        const velocity = burst.velocities[p];
        velocity.y -= 4.6 * delta;
        attribute.setXYZ(
          p,
          attribute.getX(p) + velocity.x * delta,
          attribute.getY(p) + velocity.y * delta,
          attribute.getZ(p) + velocity.z * delta,
        );
      }
      attribute.needsUpdate = true;
      burst.points.material.opacity = 1 - t;
      if (t >= 1) {
        this.disposeBurst(burst);
        this.bursts.splice(i, 1);
      }
    }
  }

  private disposeRing(ring: FlashRing): void {
    this.group.remove(ring.mesh);
    ring.mesh.geometry.dispose();
    ring.mesh.material.dispose();
  }

  private disposeBurst(burst: SparkBurst): void {
    this.group.remove(burst.points);
    burst.points.geometry.dispose();
    burst.points.material.dispose();
  }
}
