import { AxesHelper, Group } from 'three';

export function createAxes(size = 0.18): Group {
  const group = new Group();
  const axes = new AxesHelper(size);
  group.add(axes);
  return group;
}
