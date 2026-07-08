import { Vector2, type PerspectiveCamera, type Scene, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export interface PostPipeline {
  /** Render one frame through the composer (or plain renderer when bloom is off). */
  render(): void;
  setSize(width: number, height: number): void;
  setBloomEnabled(enabled: boolean): void;
  isBloomEnabled(): boolean;
}

/**
 * Main-view render pipeline with a subtle UnrealBloom pass so emissive elements
 * (andon lamps, LED strips, status screens, sparks) glow. The threshold is high
 * enough that regular lit surfaces stay clean.
 */
export function createPostPipeline(
  renderer: WebGLRenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): PostPipeline {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new Vector2(window.innerWidth, window.innerHeight),
    0.45,
    0.45,
    1.0,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let bloomEnabled = true;

  return {
    render(): void {
      if (bloomEnabled) {
        composer.render();
      } else {
        renderer.render(scene, camera);
      }
    },
    setSize(width: number, height: number): void {
      composer.setSize(width, height);
      bloom.setSize(width, height);
    },
    setBloomEnabled(enabled: boolean): void {
      bloomEnabled = enabled;
    },
    isBloomEnabled(): boolean {
      return bloomEnabled;
    },
  };
}
