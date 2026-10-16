import * as THREE from 'three';
import { PLAY_Y } from './config';
import type { Entity, GameContext } from './types';

/**
 * Small collectible shards dropped by enemies. Magnetised toward the player when close,
 * vacuumed up automatically between waves.
 *  - health   : green "+" cross, restores 1 HP (only drops when damaged)
 *  - overdrive: amber diamond, +12% overdrive meter
 */
export type PickupKind = 'health' | 'overdrive';

const HEALTH_COLOR = 0x4dff7a;
const OVERDRIVE_COLOR = 0xffc23d;
const BASE_MAGNET = 3.6;
const LIFETIME = 10;
const MAX_ACTIVE = 10;

/** Director flips this on during breathers so everything flies to the player. */
export const pickupState = { vacuum: false, active: 0 };

let pity = 0;
let healPity = 0;

export function resetDrops() {
  pity = 0;
  healPity = 0;
  pickupState.vacuum = false;
  pickupState.active = 0;
}

let healthGeo: THREE.BufferGeometry | null = null;
let healthEdges: THREE.BufferGeometry | null = null;
let odGeo: THREE.BufferGeometry | null = null;
let odEdges: THREE.BufferGeometry | null = null;
let haloGeo: THREE.BufferGeometry | null = null;

function geos(kind: PickupKind) {
  if (!healthGeo) {
    const a = new THREE.BoxGeometry(0.62, 0.16, 0.2);
    const b = new THREE.BoxGeometry(0.2, 0.16, 0.62);
    // merge the two bars by hand (no BufferGeometryUtils import needed)
    healthGeo = mergeTwo(a, b);
    healthEdges = new THREE.EdgesGeometry(healthGeo, 15);
    odGeo = new THREE.OctahedronGeometry(0.34, 0);
    odGeo.scale(0.75, 0.6, 1.15);
    odEdges = new THREE.EdgesGeometry(odGeo, 15);
    haloGeo = new THREE.RingGeometry(0.5, 0.58, 24);
    haloGeo.rotateX(-Math.PI / 2);
  }
  return kind === 'health' ? { geo: healthGeo!, edges: healthEdges! } : { geo: odGeo!, edges: odEdges! };
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const A = a.toNonIndexed(), B = b.toNonIndexed();
  const pa = A.getAttribute('position').array as Float32Array, pb = B.getAttribute('position').array as Float32Array;
  const out = new Float32Array(pa.length + pb.length);
  out.set(pa, 0);
  out.set(pb, pa.length);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

const _v = new THREE.Vector3();

export class Pickup implements Entity {
  alive = true;
  readonly object = new THREE.Group();
  readonly pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private life = LIFETIME;
  private age = 0;
  private spin = Math.random() * Math.PI * 2;
  private gem = new THREE.Group();
  private halo: THREE.Mesh;
  private mats: THREE.Material[] = [];
  readonly color: number;

  constructor(ctx: GameContext, readonly kind: PickupKind, x: number, z: number) {
    this.color = kind === 'health' ? HEALTH_COLOR : OVERDRIVE_COLOR;
    this.pos.set(x, 0, z);
    const { geo, edges } = geos(kind);
    const fill = new THREE.MeshBasicMaterial({ color: new THREE.Color(this.color).multiplyScalar(0.5), toneMapped: false });
    const line = new THREE.LineBasicMaterial({ color: new THREE.Color(this.color).multiplyScalar(4), toneMapped: false });
    const haloMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.color).multiplyScalar(2),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.mats.push(fill, line, haloMat);
    this.gem.add(new THREE.Mesh(geo, fill), new THREE.LineSegments(edges, line));
    this.halo = new THREE.Mesh(haloGeo!, haloMat);
    this.halo.position.y = -PLAY_Y + 0.06;
    this.object.add(this.gem, this.halo);
    // pop out of the dead enemy in a random direction
    const a = Math.random() * Math.PI * 2;
    this.vel.set(Math.sin(a) * 5, 0, Math.cos(a) * 5);
    this.object.position.set(x, PLAY_Y, z);
    ctx.scene.add(this.object);
    pickupState.active++;
  }

  update(ctx: GameContext, dt: number) {
    const p = ctx.player;
    this.age += dt;
    this.life -= dt;
    if (this.life <= 0 || !p.alive) {
      this.kill();
      return;
    }
    _v.subVectors(p.pos, this.pos).setY(0);
    const d = _v.length();
    const magnet = BASE_MAGNET * p.stats.pickupMagnet;
    if ((pickupState.vacuum || d < magnet) && this.age > 0.25) {
      // accelerate toward the player, stronger the closer it is
      const pull = pickupState.vacuum ? 60 : 30 + (1 - d / magnet) * 50;
      this.vel.addScaledVector(_v.normalize(), pull * dt);
      this.vel.multiplyScalar(Math.exp(-2 * dt));
    } else {
      this.vel.multiplyScalar(Math.exp(-4 * dt));
    }
    this.pos.addScaledVector(this.vel, dt);
    ctx.arena.clamp(this.pos, 0.5);
    if (d < p.radius + 0.55) {
      this.collect(ctx);
      return;
    }
    // visuals
    this.spin += dt * 2.5;
    this.gem.rotation.y = this.spin;
    this.gem.position.y = Math.sin(this.age * 4) * 0.12 + 0.1;
    const s = Math.min(1, this.age * 5);
    this.gem.scale.setScalar(s * (1 + Math.sin(this.age * 8) * 0.08));
    this.halo.scale.setScalar(1 + ((this.age * 1.5) % 1) * 0.6);
    (this.halo.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - ((this.age * 1.5) % 1));
    // blink before expiring
    this.object.visible = this.life > 2.5 || Math.floor(this.life * 10) % 2 === 0;
    this.object.position.set(this.pos.x, PLAY_Y, this.pos.z);
  }

  private collect(ctx: GameContext) {
    if (this.kind === 'health') {
      ctx.player.heal(ctx, 1);
    } else if (!ctx.overdriveActive && ctx.overdrive < 1) {
      ctx.overdrive = Math.min(1, ctx.overdrive + 0.12);
      if (ctx.overdrive >= 1) ctx.bus.emit('overdriveReady', {});
    }
    ctx.bus.emit('pickup', { pos: this.pos.clone(), kind: this.kind, color: this.color });
    this.kill();
  }

  private kill() {
    if (!this.alive) return;
    this.alive = false;
    pickupState.active = Math.max(0, pickupState.active - 1);
  }

  dispose() {
    if (this.alive) this.kill();
    this.object.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}

/** Called from EnemyBase.die(). `tier` ~ 1 for regular enemies, higher for big ones. */
export function rollDrop(ctx: GameContext, pos: THREE.Vector3, tier: number) {
  if (pickupState.active >= MAX_ACTIVE || !ctx.player.alive) return;
  const rate = ctx.player.stats.dropRate;
  const p = ctx.player;
  // health: rare, only when hurt; more likely the lower you are (pity builds per kill)
  if (p.hp < p.stats.maxHp) {
    const missing = 1 - p.hp / p.stats.maxHp;
    healPity += 0.0012 * tier * rate;
    const chance = (0.012 + missing * 0.03) * tier * rate + healPity;
    if (Math.random() < chance) {
      healPity = 0;
      ctx.addEntity(new Pickup(ctx, 'health', pos.x, pos.z));
      return;
    }
  }
  pity += 0.006 * tier * rate;
  const chance = 0.05 * tier * rate + pity;
  if (Math.random() < chance) {
    pity = 0;
    ctx.addEntity(new Pickup(ctx, 'overdrive', pos.x, pos.z));
  }
}
