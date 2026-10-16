import type { Enemy, GameContext } from '../game/types';
import { Chaser } from './Chaser';
import { Dart } from './Dart';
import { Sentinel } from './Sentinel';
import { Flock, Swarmling } from './Swarm';
import { Splitter } from './Splitter';
import { Shielder } from './Shielder';
import { Weaver } from './Weaver';

export { tuning } from './EnemyBase';
export { Flock } from './Swarm';

export type EnemyKind = 'seeker' | 'dart' | 'sentinel' | 'swarm' | 'splitter' | 'shielder' | 'weaver';

/** Construct (does NOT add) an enemy of the given kind. Swarmlings need a shared Flock. */
export function createEnemy(ctx: GameContext, kind: EnemyKind, x: number, z: number, flock?: Flock): Enemy {
  switch (kind) {
    case 'seeker':
      return new Chaser(ctx, x, z);
    case 'dart':
      return new Dart(ctx, x, z);
    case 'sentinel':
      return new Sentinel(ctx, x, z);
    case 'swarm':
      return new Swarmling(ctx, x, z, flock ?? new Flock());
    case 'splitter':
      return new Splitter(ctx, x, z, 2);
    case 'shielder':
      return new Shielder(ctx, x, z);
    case 'weaver':
      return new Weaver(ctx, x, z);
  }
}
