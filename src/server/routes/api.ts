import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  DecrementResponse,
  IncrementResponse,
  InitResponse,
} from '../../shared/api';

import {
  resolveRoomForPlayer,
  getLobbyState,
  joinRoom,
  setReady,
  getFightState,
  applyTap,
} from '../core/room';
import type { LobbyStateResponse, FightStateResponse, Role } from '../../shared/api';
import { BOSSES, getOrCreateCurrentRoom, leaveRoom } from '../core/room';
import { getPlayer } from '../core/player';


type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

api.get('/init', async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error('API Init Error: postId not found in devvit context');
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from context',
      },
      400
    );
  }

  try {
    const [count, username] = await Promise.all([
      redis.get('count'),
      reddit.getCurrentUsername(),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? 'anonymous',
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = 'Unknown error during initialization';
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>(
      { status: 'error', message: errorMessage },
      400
    );
  }
});

api.post('/increment', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', 1);
  return c.json<IncrementResponse>({
    count,
    postId,
    type: 'increment',
  });
});

api.post('/decrement', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', -1);
  return c.json<DecrementResponse>({
    count,
    postId,
    type: 'decrement',
  });
});

// ---- Lobby ----

// GET /lobby?bossId=raptor  — lobby state for the chosen boss's current room
api.get('/lobby', async (c) => {
  const { postId } = context;
  if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'postId required' }, 400);

  const bossId = c.req.query('bossId') ?? 'raptor';
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const roomId = await resolveRoomForPlayer(postId, username, bossId);
  const state = await getLobbyState(roomId, username);

  return c.json<LobbyStateResponse>({ type: 'lobby-state', roomId, ...state });
});


// POST /lobby/join  body: { role, bossId }
api.post('/lobby/join', async (c) => {
  const { postId } = context;
  if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'postId required' }, 400);

  const { role, bossId } = await c.req.json<{ role: Role; bossId: string }>();
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const roomId = await resolveRoomForPlayer(postId, username, bossId ?? 'raptor');

  await joinRoom(postId, roomId, username, role);
  const state = await getLobbyState(roomId, username);
  return c.json<LobbyStateResponse>({ type: 'lobby-state', roomId, ...state });
});


// Ready up. When everyone's ready the room starts (server-side check)
api.post('/lobby/ready', async (c) => {
  const { postId } = context;
  if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'postId required' }, 400);

  const { roomId } = await c.req.json<{ roomId: string }>();
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';

  await setReady(postId, roomId, username);
  const state = await getLobbyState(roomId, username);
  return c.json<LobbyStateResponse>({ type: 'lobby-state', roomId, ...state });
});

// POST /lobby/leave  body: { roomId } — leave a waiting room (not a started fight)
api.post('/lobby/leave', async (c) => {
  const { postId } = context;
  if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'postId required' }, 400);

  const { roomId } = await c.req.json<{ roomId: string }>();
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';

  // Only allow leaving rooms that haven't started (mid-fight leaving comes later w/ penalties)
  const status = await redis.hGet(`room:${roomId}`, 'status');
  if (status === 'open') {
    await leaveRoom(postId, roomId, username);
  }

  return c.json({ type: 'left' });
});

// ---- Fight ----

// Poll fight state (boss HP, win/loss)
api.get('/fight/:roomId', async (c) => {
  const roomId = c.req.param('roomId');
  const state = await getFightState(roomId);
  return c.json<FightStateResponse>({ type: 'fight-state', roomId, ...state });
});

// One attack tap
api.post('/fight/:roomId/tap', async (c) => {
  const { postId } = context;
  const roomId = c.req.param('roomId');
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const state = await applyTap(roomId, username, postId ?? '');
  return c.json<FightStateResponse>({ type: 'fight-state', roomId, ...state });
});



// List bosses with how many players are waiting in each one's open room
api.get('/bosses', async (c) => {
  const { postId } = context;
  if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'postId required' }, 400);

  const bosses = await Promise.all(
    BOSSES.map(async (b) => {
      const roomId = await getOrCreateCurrentRoom(postId, b.id);
      const players = await redis.hGetAll(`room:${roomId}:players`);
      return {
        id: b.id,
        name: b.name,
        emoji: b.emoji,
        maxHp: b.maxHp,
        waiting: Object.keys(players ?? {}).length,
      };
    })
  );

  return c.json({ type: 'boss-list', bosses });
});

// Current player's profile (energy, level, xp, rewards, coins)
api.get('/me', async (c) => {
  const username = (await reddit.getCurrentUsername()) ?? 'anonymous';
  const player = await getPlayer(username);
  return c.json({ type: 'me', ...player });
});