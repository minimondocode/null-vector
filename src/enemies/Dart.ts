import * as THREE from 'three';
import type { GameContext } from '../game/types';
import { EnemyBase, angleDiff, neonShared, scaledHp, scaledSpeed, stripGeo, telegraphMat, tuning } from './EnemyBase';

export const DART_COLOR = 0xffe03d;
const _t = new THREE.Vector3();

type DartState = 'approach' | 'windup' | 'dash' | 'recover';

const WINDUP = 0.8;
/** Last part of the wind-up where the aim is locked (line turns white). */
const LOCK = 0.3;
const DASH_TIME = 0.42;

/**
 * "Dart": a needle that keeps its distance, then winds up (pulls back, squashes, line telegraph
 * locks and flashes) and dashes in a straight line. Teaches sidestepping.
 */
export class Dart extends EnemyBase {
  kind = 'dart';
  private state: DartState = 'approach';
  private timer = 1 + Math.random() * 1.2;
  private heading = 0;
  private dashSpeed: number;
  private moveSpeed: number;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private hull = new THREE.Group();
  private line: THREE.Mesh;
  private lineMat: THREE.MeshBasicMaterial;
  private tip: THREE.Mesh;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, DART_COLOR, 0.75);
    this.radius = 0.55;
    this.hp = this.maxHp = scaledHp(ctx, 3);
    this.scoreValue = 120;
    this.dropTier = 1.2;
    this.knockResist = 0.7;
    this.moveSpeed = scaledSpeed(ctx, 5.5);
    this.dashSpeed = scaledSpeed(ctx, 30);
    const { group, edgeMat } = neonShared(
      'dart',
      () => {
        // long thin needle with swept fins: a 4-sided cone stretched along +Z
        const g = new THREE.ConeGeometry(0.42, 1.9, 4, 1);
        g.rotateX(Math.PI / 2);
        g.rotateZ(Math.PI / 4);
        g.scale(1, 0.4, 1);
        return g;
      },
      this.color,
    );
    const fins = neonShared(
      'dart-fins',
      () => {
        const g = new THREE.BoxGeometry(1.5, 0.06, 0.28);
        g.translate(0, 0, -0.55);
        return g;
      },
      this.color,
      2.4,
    );
    this.hull.add(group, fins.group);
    this.body.add(this.hull);
    this.registerEdges(edgeMat, fins.edgeMat);

    const len = this.dashSpeed * DASH_TIME;
    this.lineMat = telegraphMat(DART_COLOR, 0);
    this.line = new THREE.Mesh(stripGeo(0.5, len), this.lineMat);
    this.line.position.y = -0.55;
    this.line.visible = false;
    this.object.add(this.line);
    this.tip = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 4), telegraphMat(DART_COLOR, 0));
    this.tip.rotation.x = -Math.PI / 2;
    this.tip.position.set(0, 0, len);
    this.line.add(this.tip);
    this.tip.position.y = 0.01;
  }

  protected think(ctx: GameContext, dt: number) {
    this.timer -= dt;
    const p = ctx.player.pos;
    switch (this.state) {
      case 'approach': {
        // hold a 7–11 unit band, orbiting
        const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const radial = d > 11 ? 1 : d < 7 ? -1 : 0;
        _t.set((dx / d) * radial - (dz / d) * this.orbitDir * 0.8, 0, (dz / d) * radial + (dx / d) * this.orbitDir * 0.8);
        _t.normalize().multiplyScalar(this.moveSpeed);
        this.vel.lerp(_t, 1 - Math.exp(-3 * dt));
        this.separate(ctx, 0.6);
        this.avoidWalls(ctx, 3, 1.2);
        this.pos.addScaledVector(this.vel, dt);
        this.heading = this.angleTo(p);
        this.turnBody(this.heading, dt, 8);
        this.hull.scale.set(1, 1, 1);
        this.hull.rotation.z += dt * 2;
        if (this.timer <= 0 && d < 16) this.startWindup(ctx);
        break;
      }
      case 'windup': {
        const t = 1 - this.timer / WINDUP; // 0..1
        const locked = this.timer < LOCK;
        if (!locked) this.heading = this.angleTo(p);
        this.turnBody(this.heading, dt, locked ? 30 : 14);
        // anticipation: drift backwards, squash, spin up
        this.vel.set(-Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(1.6 * (1 - t));
        this.pos.addScaledVector(this.vel, dt);
        this.hull.scale.set(1 + t * 0.35, 1, 1 - t * 0.35);
        this.hull.rotation.z += dt * (4 + t * 30);
        this.line.visible = true;
        this.line.rotation.y = this.heading;
        const flick = locked ? (Math.floor(this.timer * 30) % 2 === 0 ? 1 : 0.55) : 1;
        this.lineMat.opacity = (locked ? 0.75 : 0.12 + t * 0.3) * flick;
        this.lineMat.color.setHex(locked ? 0xffffff : DART_COLOR).multiplyScalar(locked ? 2.2 : 1.6);
        (this.tip.material as THREE.MeshBasicMaterial).opacity = this.lineMat.opacity;
        this.tip.rotation.z += dt * 6;
        this.flash = Math.max(this.flash, locked ? 0.05 : 0);
        if (this.timer <= 0) {
          this.state = 'dash';
          this.timer = DASH_TIME;
          this.line.visible = false;
          this.vel.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.dashSpeed);
          ctx.bus.emit('enemyShoot', { pos: this.pos.clone(), kind: this.kind });
        }
        break;
      }
      case 'dash': {
        this.pos.addScaledVector(this.vel, dt);
        this.hull.scale.set(0.7, 1, 1.7);
        this.hull.rotation.z += dt * 20;
        // stop early when slamming into a wall
        if (ctx.arena.distanceToEdge(this.pos.x, this.pos.z) < this.radius + 0.05) {
          this.timer = 0;
          this.punch = 1;
          ctx.vfx.burst(this.pos, DART_COLOR, 8, 9, 0.35, 0.7);
        }
        if (this.timer <= 0) {
          this.state = 'recover';
          this.timer = 0.75;
        }
        break;
      }
      case 'recover': {
        this.vel.multiplyScalar(Math.exp(-7 * dt));
        this.pos.addScaledVector(this.vel, dt);
        const t = this.timer / 0.75;
        this.hull.scale.set(1 + Math.sin(t * 18) * 0.12 * t, 1, 1 - Math.sin(t * 18) * 0.12 * t);
        this.hull.rotation.z += dt * 6 * t;
        if (this.timer <= 0) {
          this.state = 'approach';
          this.timer = (1.3 + Math.random() * 1.2) / Math.max(0.5, tuning.fire * ctx.difficulty.enemyFireRate);
          if (Math.random() < 0.35) this.orbitDir *= -1;
        }
        break;
      }
    }
  }

  private startWindup(ctx: GameContext) {
    this.state = 'windup';
    this.timer = WINDUP;
    ctx.bus.emit('enemyTelegraph', { pos: this.pos.clone(), kind: this.kind });
  }

  private angleTo(p: THREE.Vector3) {
    return Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
  }

  private turnBody(target: number, dt: number, rate: number) {
    this.body.rotation.y += angleDiff(this.body.rotation.y, target) * Math.min(1, rate * dt);
  }
}
