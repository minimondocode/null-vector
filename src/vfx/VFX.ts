import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { EventBus } from '../core/EventBus';
import { settings } from '../core/Settings';
import type { Arena } from '../game/Arena';
import type { SectorTheme } from '../game/config';
import type { GameContext } from '../game/types';

/**
 * Visual effects facade. STUB — to be replaced by the full VFX system
 * (deformable grid, particles, post-processing, quality presets). Keep this public API.
 */
export class VFX {
  /** Camera offset to add this frame (screen shake). */
  shakeOffset = new THREE.Vector3();
  private trauma = 0;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private floor?: THREE.Object3D;
  private currentTheme?: SectorTheme;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    bus: EventBus,
  ) {
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.5, 0.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    bus.on('explosion', (e) => this.shake(0.08 * e.size));
    bus.on('playerHit', () => this.shake(0.6));
  }

  setTheme(theme: SectorTheme, arena: Arena) {
    this.currentTheme = theme;
    if (this.floor) this.scene.remove(this.floor);
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(arena.size * 2, arena.size, new THREE.Color(theme.primary).multiplyScalar(0.6), new THREE.Color(theme.primary).multiplyScalar(0.25));
    g.add(grid);
    const pts = arena.outline().map((p) => new THREE.Vector3(p.x, 0.05, p.y));
    pts.push(pts[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(theme.primary).multiplyScalar(3), toneMapped: false }));
    g.add(line);
    this.floor = g;
    this.scene.add(g);
    this.scene.background = new THREE.Color(theme.background);
  }

  /** Arena size changed at runtime (ROOT shrinks it): redraw walls/floor clip without full theme rebuild. */
  refreshArena(arena: Arena) {
    this.setTheme(this.currentTheme!, arena);
  }

  burst(_pos: THREE.Vector3, _color: number, _count: number, _speed = 8, _life = 0.6, _size = 1) {}
  ring(_pos: THREE.Vector3, _color: number, _radius: number, _duration = 0.5) {}
  flash(_color: number, _strength: number) {}
  gridImpulse(_pos: THREE.Vector3, _strength: number, _radius: number) {}

  shake(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(realDt: number, _worldDt: number, _ctx: GameContext) {
    this.trauma = Math.max(0, this.trauma - realDt * 1.6);
    const s = this.trauma * this.trauma * settings.data.screenShake * 0.8;
    this.shakeOffset.set((Math.random() * 2 - 1) * s, 0, (Math.random() * 2 - 1) * s);
  }

  render() {
    this.composer.render();
  }

  resize(w: number, h: number) {
    this.composer.setSize(w, h);
  }
}
