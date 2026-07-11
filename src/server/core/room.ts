import { redis } from '@devvit/web/server';
import type { Role, PlayerInRoom, RoomStatus } from '../../shared/api';
import { postVictoryComment } from './chronicle';
import { spendEnergy, grantFightXp, getPlayer } from './player';

// ---- Config ----
// ---- Boss definitions ----
export type BossConfig = {
  id: string;
  name: string;
  emoji: string;
  maxHp: number;
  attackDamage: number; // damage per attacker tap against this boss
  counterDamage: number;    // boss damage per counter-attack
  counterIntervalMs: number; // how often the boss attacks
};

export const BOSSES: BossConfig[] = [
  { id: 'raptor', name: 'Rogue Raptor', emoji: '🦖', maxHp: 400, attackDamage: 10, counterDamage: 8,  counterIntervalMs: 5000 },
  { id: 'rex',    name: 'Tyrant Rex',   emoji: '🦴', maxHp: 800, attackDamage: 10, counterDamage: 14, counterIntervalMs: 5000 },
  { id: 'titan',  name: 'Volcano Titan',emoji: '🌋', maxHp: 1500,attackDamage: 10, counterDamage: 22, counterIntervalMs: 6000 },
];

// Shared party stats (same for all bosses for now)
const PARTY_MAX_HP = 100;
const SHIELD_PER_TAP = 6;    // defender tap -> shield charge
const HEAL_PER_TAP = 5;      // supporter tap -> party HP restore
const SHIELD_MAX = 60;       // shield can't stack infinitely

// Look up a boss config by id (falls back to first boss if unknown)
export function getBoss(bossId: string): BossConfig {
  return BOSSES.find((b) => b.id === bossId) ?? BOSSES[0]!;
}

const CAPACITY = 3;

// ---- Redis keys (all scoped by postId so multiple game posts don't collide) ----
// One "current open room" PER BOSS now
const currentRoomKey = (postId: string, bossId: string) => `game:${postId}:currentRoom:${bossId}`;
const roomKey = (roomId: string) => `room:${roomId}`;
const playersKey = (roomId: string) => `room:${roomId}:players`; // hash: username -> role
const readyKey = (roomId: string) => `room:${roomId}:ready`;     // hash: username -> "1"
// Which room a given player is currently in (their active room)
const playerRoomKey = (postId: string, username: string) =>
  `game:${postId}:playerRoom:${username}`;
// Per-fight contribution stats — hash: username -> "damage|blocked|healed"
const statsKey = (roomId: string) => `room:${roomId}:stats`;


/* HELPER FUNCTIONS */
// Deal damage to the boss; returns true if THIS hit was the killing blow
async function damageBoss(roomId: string, amount: number): Promise<boolean> {
  const newHp = await redis.hIncrBy(roomKey(roomId), 'bossHp', -amount);
  if (newHp <= 0) {
    const status = await redis.hGet(roomKey(roomId), 'status');
    if (status === 'started') {
      await redis.hSet(roomKey(roomId), { bossHp: '0', status: 'ended', result: 'win' });
      await grantFightResults(roomId, true);   // NEW
      return true;
    }
  }
  return false;
}

// Read a player's stats triple from the stats hash
async function getPlayerStats(roomId: string, username: string) {
  const raw = await redis.hGet(statsKey(roomId), username);
  const [damage, blocked, healed] = (raw ?? '0|0|0').split('|').map(Number);
  return { damage: damage ?? 0, blocked: blocked ?? 0, healed: healed ?? 0 };
}

// Add to a player's contribution counters
async function addStats(
  roomId: string,
  username: string,
  add: { damage?: number; blocked?: number; healed?: number }
) {
  const s = await getPlayerStats(roomId, username);
  await redis.hSet(statsKey(roomId), {
    [username]: `${s.damage + (add.damage ?? 0)}|${s.blocked + (add.blocked ?? 0)}|${s.healed + (add.healed ?? 0)}`,
  });
}

// Grant XP (and possibly daily rewards) to every party member for a finished fight
async function grantFightResults(roomId: string, won: boolean) {
  const [players, room] = await Promise.all([
    redis.hGetAll(playersKey(roomId)),
    redis.hGetAll(roomKey(roomId)),
  ]);
  const bossId = room?.bossId ?? 'raptor';
  await Promise.all(
    Object.keys(players ?? {}).map((name) => grantFightXp(name, bossId, won))
  );
}

// Apply any boss counter-attacks that are "due" based on elapsed time.
// Called before reads and taps so state is always settled up to now.
// Returns the room hash after settlement.
async function settleCounters(roomId: string): Promise<Record<string, string>> {
  const room = await redis.hGetAll(roomKey(roomId));
  if (room?.status !== 'started') return room ?? {};

  const boss = getBoss(room.bossId ?? 'raptor');
  const startedAt = parseInt(room.startedAt ?? '0');
  const applied = parseInt(room.countersApplied ?? '0');

  // How many attacks SHOULD have happened by now?
  const due = Math.floor((Date.now() - startedAt) / boss.counterIntervalMs);
  let pending = due - applied;
  if (pending <= 0) return room;

  // Cap retroactive attacks so an abandoned room doesn't insta-wipe on revisit
  pending = Math.min(pending, 5);

  let shield = parseInt(room.shield ?? '0');
  let partyHp = parseInt(room.partyHp ?? '0');

  // Each pending attack: shield soaks first, overflow hits party HP
  for (let i = 0; i < pending; i++) {
    let dmg = boss.counterDamage;
    const soaked = Math.min(shield, dmg);
    shield -= soaked;
    dmg -= soaked;
    partyHp = Math.max(partyHp - dmg, 0);
    if (partyHp === 0) break;
  }

  const updates: Record<string, string> = {
    shield: shield.toString(),
    partyHp: partyHp.toString(),
    countersApplied: due.toString(),
  };

  // Party wiped -> loss (only if boss isn't already dead)
  if (partyHp === 0 && parseInt(room.bossHp ?? '1') > 0) {
    updates.status = 'ended';
    updates.result = 'loss';
  }

  await redis.hSet(roomKey(roomId), updates);

  if (updates.result === 'loss') {
    await grantFightResults(roomId, false);   // NEW
  }

  return { ...room, ...updates };
}


// Get the current open room id, creating the first room if none exists
export async function getOrCreateCurrentRoom(postId: string, bossId: string): Promise<string> {
  const existing = await redis.get(currentRoomKey(postId, bossId));
  if (existing) return existing;
  return createNewRoom(postId, bossId);
}

// Spawn a fresh room for a boss and point "current" at it (rolling rooms)
export async function createNewRoom(postId: string, bossId: string): Promise<string> {
  const boss = getBoss(bossId);
  const roomId = `${postId}:${bossId}:${Date.now()}`;
  await redis.hSet(roomKey(roomId), {
    status: 'open',
    bossId: boss.id,
    bossHp: boss.maxHp.toString(),
    bossMaxHp: boss.maxHp.toString(),
    partyHp: PARTY_MAX_HP.toString(),
    partyMaxHp: PARTY_MAX_HP.toString(),
    shield: '0',
    countersApplied: '0',   // how many boss attacks we've already processed
    startedAt: '',
    result: '',

  });
  await redis.set(currentRoomKey(postId, bossId), roomId);
  return roomId;
}

// Read full lobby state for a room
export async function getLobbyState(roomId: string, username: string) {
  const [room, playersHash, readyHash] = await Promise.all([
    redis.hGetAll(roomKey(roomId)),
    redis.hGetAll(playersKey(roomId)),
    redis.hGetAll(readyKey(roomId)),
  ]);

  const players: PlayerInRoom[] = Object.entries(playersHash ?? {}).map(
    ([name, role]) => ({
      username: name,
      role: role as Role,
      ready: readyHash?.[name] === '1',
    })
  );

  return {
    status: (room?.status ?? 'open') as RoomStatus,
    players,
    capacity: CAPACITY,
    joined: players.some((p) => p.username === username),
    myRole: (playersHash?.[username] as Role | undefined) ?? null,
  };
}

// Join the room with a chosen role. Also records this as the player's active room.
export async function joinRoom(postId: string, roomId: string, username: string, role: Role) {
  const room = await redis.hGetAll(roomKey(roomId));
  if (room?.status !== 'open') return;

  // Energy gate: can't join a hunt with no energy
  const player = await getPlayer(username);
  if (player.energy <= 0) return;

  const players = await redis.hGetAll(playersKey(roomId));
  const count = Object.keys(players ?? {}).length;
  const alreadyIn = players?.[username] !== undefined;

  if (!alreadyIn && count >= CAPACITY) return;
  await redis.hSet(playersKey(roomId), { [username]: role });
  await redis.set(playerRoomKey(postId, username), roomId);
}


// Toggle ready. If ALL joined players are ready, the fight starts
// (spending 1 energy from each player).
export async function setReady(postId: string, roomId: string, username: string) {
  await redis.hSet(readyKey(roomId), { [username]: '1' });

  const [players, ready] = await Promise.all([
    redis.hGetAll(playersKey(roomId)),
    redis.hGetAll(readyKey(roomId)),
  ]);

  const names = Object.keys(players ?? {});
  const allReady = names.length > 0 && names.every((n) => ready?.[n] === '1');

  if (allReady) {
    // Spend energy from every party member (gate at join is primary enforcement)
    await Promise.all(names.map((n) => spendEnergy(n)));

    await redis.hSet(roomKey(roomId), {
      status: 'started',
      startedAt: Date.now().toString(),
    });
    const bossId = (await redis.hGet(roomKey(roomId), 'bossId')) ?? 'raptor';
    await createNewRoom(postId, bossId);
  }
}

// Read fight state (boss HP etc.)
// Read fight state, settling any due boss attacks first
export async function getFightState(roomId: string) {
  const room = await settleCounters(roomId);
  const boss = getBoss(room?.bossId ?? 'raptor');

  // Per-player contributions (username -> stats), plus roles for display
  const [statsHash, playersHash] = await Promise.all([
    redis.hGetAll(statsKey(roomId)),
    redis.hGetAll(playersKey(roomId)),
  ]);
  const contributions = Object.entries(playersHash ?? {}).map(([name, role]) => {
    const [damage, blocked, healed] = (statsHash?.[name] ?? '0|0|0').split('|').map(Number);
    return { username: name, role: role as Role, damage: damage ?? 0, blocked: blocked ?? 0, healed: healed ?? 0 };
  });

  return {
    status: (room?.status ?? 'open') as RoomStatus,
    bossId: boss.id,
    bossName: boss.name,
    bossEmoji: boss.emoji,
    bossHp: parseInt(room?.bossHp ?? '0'),
    bossMaxHp: parseInt(room?.bossMaxHp ?? '1'),
    partyHp: parseInt(room?.partyHp ?? '0'),
    partyMaxHp: parseInt(room?.partyMaxHp ?? '100'),
    shield: parseInt(room?.shield ?? '0'),
    startedAt: parseInt(room?.startedAt || '0'),
    contributions,
    result: (room?.result || null) as 'win' | 'loss' | null,
  };
}

// Apply one tap based on the player's role in this room.
// Apply one tap based on the player's role in this room.
// Records contribution stats and announces the victory on a killing blow.
export async function applyTap(roomId: string, username: string, postId: string) {
  // Settle boss counter-attacks first so we're acting on current state
  const room = await settleCounters(roomId);
  if (room?.status !== 'started') return getFightState(roomId);

  const role = (await redis.hGet(playersKey(roomId), username)) as Role | undefined;
  const boss = getBoss(room.bossId ?? 'raptor');

  let killed = false;

  if (role === 'defender') {
    // Shield up (atomic, clamped) + a small hit (30% damage)
    const newShield = await redis.hIncrBy(roomKey(roomId), 'shield', SHIELD_PER_TAP);
    if (newShield > SHIELD_MAX) {
      await redis.hSet(roomKey(roomId), { shield: SHIELD_MAX.toString() });
    }
    const dmg = Math.ceil(boss.attackDamage * 0.3);
    killed = await damageBoss(roomId, dmg);
    await addStats(roomId, username, { blocked: SHIELD_PER_TAP, damage: dmg });
  } else if (role === 'supporter') {
    // Heal party HP (atomic, clamped) + a small hit (30% damage)
    const newHp = await redis.hIncrBy(roomKey(roomId), 'partyHp', HEAL_PER_TAP);
    const maxHp = parseInt(room.partyMaxHp ?? '100');
    if (newHp > maxHp) {
      await redis.hSet(roomKey(roomId), { partyHp: maxHp.toString() });
    }
    const dmg = Math.ceil(boss.attackDamage * 0.3);
    killed = await damageBoss(roomId, dmg);
    await addStats(roomId, username, { healed: HEAL_PER_TAP, damage: dmg });
  } else {
    // Attacker (default): full damage
    killed = await damageBoss(roomId, boss.attackDamage);
    await addStats(roomId, username, { damage: boss.attackDamage });
  }

  const state = await getFightState(roomId);

  // Killing blow -> announce the victory (once; fire-and-forget)
  if (killed) {
    const durationMs = Date.now() - state.startedAt;
    void postVictoryComment(postId, state.bossName, state.bossEmoji, state.contributions, durationMs);
  }

  return state;
}

// The room this player should see:
// - their active room if mid-fight (started), or if it's an open room for the SAME boss
// - otherwise auto-leave the stale open room and resolve to the chosen boss's room
export async function resolveRoomForPlayer(
  postId: string,
  username: string,
  bossId: string
): Promise<string> {
  const myRoomId = await redis.get(playerRoomKey(postId, username));

  if (myRoomId) {
    const room = await redis.hGetAll(roomKey(myRoomId));
    const status = room?.status;

    // Mid-fight: locked in, boss choice doesn't matter
    if (status === 'started') return myRoomId;

    // Waiting in an open room for the SAME boss: stay
    if (status === 'open' && room?.bossId === bossId) return myRoomId;

    // Open room for a DIFFERENT boss: leave it, fall through
    if (status === 'open') {
      await leaveRoom(postId, myRoomId, username);
    } else {
      // Room ended/missing: just clear the stale pointer
      await redis.del(playerRoomKey(postId, username));
    }
  }

  return getOrCreateCurrentRoom(postId, bossId);
}

// Remove a player from a room: clears their slot, ready flag, and room pointer.
// (We don't delete the room itself — an empty open room is just... an open room.)
export async function leaveRoom(postId: string, roomId: string, username: string) {
  await Promise.all([
    redis.hDel(playersKey(roomId), [username]),
    redis.hDel(readyKey(roomId), [username]),
    redis.del(playerRoomKey(postId, username)),
  ]);
}