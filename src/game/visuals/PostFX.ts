import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * Light bloom (headlights / windows) + SMAA. Tone mapping lives on the renderer
 * and is applied by OutputPass so we don't double-map.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private bloom: UnrealBloomPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.addPass(new RenderPass(scene, camera));

    const size = new THREE.Vector2();
    renderer.getSize(size);
    this.bloom = new UnrealBloomPass(size, 0.18, 0.32, 0.86);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new SMAAPass());
    this.composer.addPass(new OutputPass());
  }

  /** Night: a bit more bloom so headlights read as glow. Day stays subtle. */
  setNight(night: number): void {
    const n = THREE.MathUtils.clamp(night, 0, 1);
    this.bloom.strength = 0.12 + n * 0.38;
    this.bloom.radius = 0.28 + n * 0.12;
    this.bloom.threshold = 0.88 - n * 0.18;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
