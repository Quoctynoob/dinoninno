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
};

export const BOSSES: BossConfig[] = [
  { id: 'raptor', name: 'Rogue Raptor', emoji: '🦖', maxHp: 400, attackDamage: 10 },
  { id: 'rex', name: 'Tyrant Rex', emoji: '🦴', maxHp: 800, attackDamage: 10 },
  { id: 'titan', name: 'Volcano Titan', emoji: '🌋', maxHp: 1500, attackDamage: 10 },
];

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
    await redis.hSet(roomKey(roomId), { status: 'started' });
    // Roll over a fresh room for THIS boss
    const bossId = (await redis.hGet(roomKey(roomId), 'bossId')) ?? 'raptor';
    await createNewRoom(postId, bossId);
  }
}

// Read fight state (boss HP etc.)
export async function getFightState(roomId: string) {
  const room = await redis.hGetAll(roomKey(roomId));
  return {
    status: (room?.status ?? 'open') as RoomStatus,
    bossHp: parseInt(room?.bossHp ?? '0'),
    bossMaxHp: parseInt(room?.bossMaxHp ?? '1'),
    result: (room?.result || null) as 'win' | 'loss' | null,
  };
}

// Apply one attack tap. Marks the room won when HP reaches 0.
export async function applyTap(roomId: string) {
  const status = await redis.hGet(roomKey(roomId), 'status');
  if (status !== 'started') return getFightState(roomId);

  const bossId = (await redis.hGet(roomKey(roomId), 'bossId')) ?? 'raptor';
  const boss = getBoss(bossId);

  // Atomic decrement — safe under simultaneous taps
  const newHp = await redis.hIncrBy(roomKey(roomId), 'bossHp', -boss.attackDamage);

  if (newHp <= 0) {
    await redis.hSet(roomKey(roomId), { bossHp: '0', status: 'ended', result: 'win' });
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