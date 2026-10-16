import * as THREE from 'three';
import type { DamageSource, Enemy, GameContext } from '../game/types';
import { EnemyBase, angleDiff, glowColor, neonShared, scaledHp, scaledSpeed, telegraphMat } from './EnemyBase';

export const SHIELDER_COLOR = 0x3d7bff;
const SHIELD_COLOR = 0xcfe8ff;
/** Half-angle of the frontal arc that blocks shots (radians). */
const ARC = 1.2;
const _w = new THREE.Color(1, 1, 1);

/**
 * Invisible-to-the-player hit volume in front of a Shielder. vulnerable=false so shots
 * (even piercing ones) are consumed. Also shields enemies standing behind it.
 * Visuals live on the owner.
 */
class ShieldPart implements Enemy {
  kind = 'shield';
  alive = true;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  radius = 1.0;
  hp = 1;
  maxHp = 1;
  collidable = false;
  contactDamage = true;
  vulnerable = false;
  scoreValue = 0;
  color = SHIELD_COLOR;
  isBoss = false;
  countsForWave = false;
  object = new THREE.Group();

  constructor(private owner: Shielder) {}

  update() {
    if (!this.owner.alive) this.alive = false;
  }

  damage(ctx: GameContext, _amount: number, from: THREE.Vector3, source: DamageSource) {
    // dash / overdrive hit the body directly (Game applies them to every enemy in range)
    if (source === 'bullet' || source === 'blast') this.owner.blocked(ctx, from);
    return false;
  }

  dispose() {}
}

/**
 * "Shielder": slow blue tank with a curved frontal shield that turns (slowly) to face the player.
 * Shots from the front are blocked — flank it, or dash through it. Periodically braces (shield flares)
 * and lunges a short distance. Its shield also protects allies behind it.
 */
export class Shielder extends EnemyBase {
  kind = 'shielder';
  private heading = 0;
  private part: ShieldPart;
  private shield = new THREE.Group();
  private shieldMat: THREE.LineBasicMaterial;
  private shieldFill: THREE.MeshBasicMaterial;
  private core: THREE.Mesh;
  private coreMat: THREE.MeshBasicMaterial;
  private speed: number;
  private turnRate: number;
  private state: 'walk' | 'brace' | 'lunge' = 'walk';
  private timer = 2.5 + Math.random() * 1.5;
  private blockFlash = 0;
  private stomp = Math.random() * 10;
  private arcRing: THREE.Mesh;
  private arcMat: THREE.MeshBasicMaterial;

  constructor(ctx: GameContext, x: number, z: number) {
    super(ctx, x, z, SHIELDER_COLOR, 1.1);
    this.radius = 1.05;
    this.hp = this.maxHp = scaledHp(ctx, 16);
    this.scoreValue = 400;
    this.dropTier = 3;
    this.knockResist = 0.15;
    this.speed = scaledSpeed(ctx, 2.3);
    this.turnRate = 1.15 * ctx.difficulty.enemySpeed;
    this.heading = this.angleToPlayer(ctx);

    // hull: wide trapezoid slab
    const hull = neonShared(
      'shielder-hull',
      () => {
        const s = new THREE.Shape();
        s.moveTo(-0.95, 0.55);
        s.lineTo(0.95, 0.55);
        s.lineTo(0.6, -0.8);
        s.lineTo(-0.6, -0.8);
        s.closePath();
        const g = new THREE.ExtrudeGeometry(s, { depth: 0.55, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 });
        g.rotateX(Math.PI / 2);
        g.translate(0, 0.27, 0);
        return g;
      },
      this.color,
    );
    this.body.add(hull.group);
    this.registerEdges(hull.edgeMat);

    // rear weak-point core: pulsing, the visual "hit me here"
    this.coreMat = new THREE.MeshBasicMaterial({ color: glowColor(0xffffff, 2), toneMapped: false });
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), this.coreMat);
    this.core.position.set(0, 0.45, -0.75);
    this.body.add(this.core);

    // shield: curved wall segment in front
    const sh = neonShared(
      'shielder-shield',
      () => {
        const g = new THREE.CylinderGeometry(1.75, 1.75, 0.8, 9, 1, true, -ARC * 0.85, ARC * 1.7);
        g.translate(0, 0.15, 0);
        return g;
      },
      SHIELD_COLOR,
      3,
      0.35,
    );
    this.shieldMat = sh.edgeMat;
    this.shieldFill = sh.fill.material as THREE.MeshBasicMaterial;
    this.shieldFill.side = THREE.DoubleSide;
    this.shieldFill.color.copy(glowColor(SHIELDER_COLOR, 0.6));
    this.shieldFill.blending = THREE.AdditiveBlending;
    this.shieldFill.depthWrite = false;
    this.shield.add(sh.group);
    this.body.add(this.shield);

    // floor arc showing the protected cone
    this.arcMat = telegraphMat(SHIELD_COLOR, 0.12);
    this.arcRing = new THREE.Mesh(new THREE.RingGeometry(1.9, 2.2, 16, 1, -Math.PI / 2 - ARC, ARC * 2), this.arcMat);
    this.arcRing.rotation.x = -Math.PI / 2;
    this.arcRing.position.y = -0.5;
    this.body.add(this.arcRing);

    this.part = new ShieldPart(this);
    // added before the body so frontal shots meet the shield first
    ctx.addEnemy(this.part);
  }

  /** Called by the shield part or own damage() when a shot is deflected. */
  blocked(ctx: GameContext, from: THREE.Vector3) {
    this.blockFlash = 1;
    ctx.bus.emit('shieldBlock', { pos: from.clone(), color: SHIELD_COLOR });
  }

  damage(ctx: GameContext, amount: number, from: THREE.Vector3, source: DamageSource): boolean {
    if (!this.alive || !this.collidable) return false;
    if (source === 'bullet' || source === 'blast') {
      const a = Math.atan2(from.x - this.pos.x, from.z - this.pos.z);
      if (Math.abs(angleDiff(this.heading, a)) < ARC) {
        this.blocked(ctx, from);
        return false;
      }
    }
    // flanked hits on the core feel great: extra hit-stop on dash
    return super.damage(ctx, amount, from, source);
  }

  protected think(ctx: GameContext, dt: number) {
    this.timer -= dt;
    const target = this.angleToPlayer(ctx);
    const d = this.distToPlayer(ctx);
    const rate = this.state === 'lunge' ? 0 : this.state === 'brace' ? this.turnRate * 0.5 : this.turnRate;
    const diff = angleDiff(this.heading, target);
    this.heading += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);

    let brace = 0;
    if (this.state === 'walk') {
      const sp = d > 3 ? this.speed : 0;
      this.vel.set(fx * sp, 0, fz * sp);
      this.separate(ctx, 1.2);
      if (this.timer <= 0 && d < 10) {
        this.state = 'brace';
        this.timer = 0.6;
        ctx.bus.emit('enemyTelegraph', { pos: this.pos.clone(), kind: this.kind });
      }
    } else if (this.state === 'brace') {
      brace = 1 - this.timer / 0.6;
      this.vel.set(-fx, 0, -fz).multiplyScalar(0.8); // rock back
      if (this.timer <= 0) {
        this.state = 'lunge';
        this.timer = 0.38;
        this.vel.set(fx, 0, fz).multiplyScalar(scaledSpeed(ctx, 15));
      }
    } else {
      brace = 1;
      this.vel.multiplyScalar(Math.exp(-3 * dt));
      if (this.timer <= 0) {
        this.state = 'walk';
        this.timer = 3.2 + Math.random() * 1.5;
      }
    }
    this.pos.addScaledVector(this.vel, dt);

    // part follows the front
    this.part.pos.set(this.pos.x + fx * 1.35, 0, this.pos.z + fz * 1.35);
    this.part.collidable = this.collidable;

    // visuals
    this.body.rotation.y = this.heading;
    this.stomp += dt * (this.state === 'walk' ? 6 : 0);
    this.body.position.y = Math.abs(Math.sin(this.stomp)) * 0.08;
    this.body.rotation.z = Math.sin(this.stomp) * 0.05;
    this.blockFlash = Math.max(0, this.blockFlash - dt * 6);
    const k = Math.max(this.blockFlash, brace * (0.6 + Math.sin(ctx.time * 40) * 0.2));
    this.shieldMat.color.copy(glowColor(SHIELD_COLOR, 2.4)).lerp(_w.setScalar(5), k * 0.6);
    this.shieldFill.opacity = 0.25 + k * 0.4;
    this.shield.scale.set(1 + this.blockFlash * 0.06 + brace * 0.08, 1, 1 + brace * 0.12);
    this.arcMat.opacity = 0.1 + brace * 0.35;
    const pulse = 0.8 + Math.sin(ctx.time * 5) * 0.2;
    this.core.scale.setScalar(pulse);
    this.core.rotation.y += dt * 3;
    this.coreMat.color.setRGB(2 * pulse, 2.2 * pulse, 3 * pulse);
  }

  protected onDeath(_ctx: GameContext) {
    this.part.alive = false;
  }

  despawn() {
    super.despawn();
    this.part.alive = false;
  }
}
