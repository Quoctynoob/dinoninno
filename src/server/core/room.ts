import { redis } from '@devvit/web/server';
import type { Role, PlayerInRoom, RoomStatus } from '../../shared/api';

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

async function damageBoss(roomId: string, amount: number) {
  const newHp = await redis.hIncrBy(roomKey(roomId), 'bossHp', -amount);
  if (newHp <= 0) {
    await redis.hSet(roomKey(roomId), { bossHp: '0', status: 'ended', result: 'win' });
  }
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

  const players = await redis.hGetAll(playersKey(roomId));
  const count = Object.keys(players ?? {}).length;
  const alreadyIn = players?.[username] !== undefined;

  if (!alreadyIn && count >= CAPACITY) return; // full
  await redis.hSet(playersKey(roomId), { [username]: role });
  await redis.set(playerRoomKey(postId, username), roomId); // remember where I am
}

// Toggle ready. If ALL joined players are ready, the fight starts.
// Toggle ready. If ALL joined players are ready, the fight starts.
export async function setReady(postId: string, roomId: string, username: string) {
  await redis.hSet(readyKey(roomId), { [username]: '1' });

  const [players, ready] = await Promise.all([
    redis.hGetAll(playersKey(roomId)),
    redis.hGetAll(readyKey(roomId)),
  ]);

  const names = Object.keys(players ?? {});
  const allReady = names.length > 0 && names.every((n) => ready?.[n] === '1');

  if (allReady) {
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
    result: (room?.result || null) as 'win' | 'loss' | null,
  };
}

// Apply one tap based on the player's role in this room.
export async function applyTap(roomId: string, username: string) {
  // Settle boss attacks first so we're acting on current state
  const room = await settleCounters(roomId);
  if (room?.status !== 'started') return getFightState(roomId);

  const role = (await redis.hGet(playersKey(roomId), username)) as Role | undefined;
  const boss = getBoss(room.bossId ?? 'raptor');

  if (role === 'defender') {
    // Shield up + a small hit (30% damage)
    const newShield = await redis.hIncrBy(roomKey(roomId), 'shield', SHIELD_PER_TAP);
    if (newShield > SHIELD_MAX) {
      await redis.hSet(roomKey(roomId), { shield: SHIELD_MAX.toString() });
    }
    await damageBoss(roomId, Math.ceil(boss.attackDamage * 0.3));
  } else if (role === 'supporter') {
    // Heal + a small hit (30% damage)
    const newHp = await redis.hIncrBy(roomKey(roomId), 'partyHp', HEAL_PER_TAP);
    const maxHp = parseInt(room.partyMaxHp ?? '100');
    if (newHp > maxHp) {
      await redis.hSet(roomKey(roomId), { partyHp: maxHp.toString() });
    }
    await damageBoss(roomId, Math.ceil(boss.attackDamage * 0.3));
  } else {
    // Attacker: full damage
    await damageBoss(roomId, boss.attackDamage);
  }

  return getFightState(roomId);
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
  return { ...room, ...updates };
}