import { MeshPhysicalMaterial, MeshStandardMaterial } from 'three';

export const robotPaintMaterial = new MeshPhysicalMaterial({
  color: 0xf2f3f1,
  metalness: 0.08,
  roughness: 0.28,
  clearcoat: 0.72,
  clearcoatRoughness: 0.2,
});

export const robotPaintShadowMaterial = new MeshPhysicalMaterial({
  color: 0xd7dad8,
  metalness: 0.1,
  roughness: 0.34,
  clearcoat: 0.48,
  clearcoatRoughness: 0.25,
});

export const jointSealMaterial = new MeshStandardMaterial({
  color: 0x171b1d,
  metalness: 0.3,
  roughness: 0.38,
});

export const darkMetalMaterial = new MeshStandardMaterial({
  color: 0x3c4347,
  metalness: 0.82,
  roughness: 0.25,
});

export const brushedMetalMaterial = new MeshStandardMaterial({
  color: 0xaeb5b8,
  metalness: 0.92,
  roughness: 0.2,
});

export const rubberMaterial = new MeshStandardMaterial({
  color: 0x111416,
  metalness: 0.02,
  roughness: 0.82,
});
