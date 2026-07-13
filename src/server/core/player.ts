import { redis } from '@devvit/web/server';

// ---- Tuning knobs (all balance changes happen here) ----
const DATA_VERSION = 'v2';        // bump to reset ALL player data
export const ENERGY_MAX = 5;
export const ENERGY_REGEN_MS = 2 * 60 * 60 * 1000; // +1 energy per 2 hours
export const DAILY_REWARD_CAP = 3;                  // rewarded wins per day
const REWARD_WINDOW_MS = 24 * 60 * 60 * 1000;       // rolling daily window
const XP_BASE = 100;              // XP needed L1 -> L2
const XP_GROWTH = 1.25;           // each level needs 25% more
export const COINS_PER_REWARD = 10;

// XP awarded per win, by boss (losses give 25% of this)
const BOSS_XP: Record<string, number> = {
  raptor: 100,
  rex: 150,
  titan: 250,
};

const playerKey = (username: string) => `player:${DATA_VERSION}:${username}`;

export type PlayerState = {
  username: string;
  level: number;
  xp: number;            // progress within current level
  xpForNext: number;     // XP needed to finish current level
  energy: number;
  energyMax: number;
  nextEnergyInMs: number; // ms until next point (0 if full)
  rewardsToday: number;   // rewarded wins used in current window
  rewardCap: number;
  coins: number;
};

// XP needed to go from level N to N+1 (exponential curve)
export function xpForLevel(level: number): number {
  return Math.round(XP_BASE * Math.pow(XP_GROWTH, level - 1));
}

// Load player, lazily applying energy regen and reward-window reset.
// Creates a fresh player on first sight.
export async function getPlayer(username: string): Promise<PlayerState> {
  const now = Date.now();
  const raw = await redis.hGetAll(playerKey(username));

  // Fresh player defaults
  let level = parseInt(raw?.level ?? '1');
  let xp = parseInt(raw?.xp ?? '0');
  let energy = parseInt(raw?.energy ?? ENERGY_MAX.toString());
  let energyStamp = parseInt(raw?.energyStamp ?? now.toString());
  let rewardsToday = parseInt(raw?.rewardsToday ?? '0');
  let rewardWindowStart = parseInt(raw?.rewardWindowStart ?? '0');
  const coins = parseInt(raw?.coins ?? '0');

  // ---- Lazy energy regen: how many points accrued since last stamp? ----
  if (energy < ENERGY_MAX) {
    const gained = Math.floor((now - energyStamp) / ENERGY_REGEN_MS);
    if (gained > 0) {
      energy = Math.min(energy + gained, ENERGY_MAX);
      // Move the stamp forward by whole intervals only (keeps partial progress)
      energyStamp = energy >= ENERGY_MAX ? now : energyStamp + gained * ENERGY_REGEN_MS;
    }
  } else {
    energyStamp = now; // full: timer idles at "now"
  }

  // ---- Rolling daily reward window ----
  if (rewardWindowStart > 0 && now - rewardWindowStart >= REWARD_WINDOW_MS) {
    rewardsToday = 0;
    rewardWindowStart = 0; // next rewarded win starts a new window
  }

  await redis.hSet(playerKey(username), {
    level: level.toString(),
    xp: xp.toString(),
    energy: energy.toString(),
    energyStamp: energyStamp.toString(),
    rewardsToday: rewardsToday.toString(),
    rewardWindowStart: rewardWindowStart.toString(),
    coins: coins.toString(),
  });

  const nextEnergyInMs =
    energy >= ENERGY_MAX ? 0 : Math.max(energyStamp + ENERGY_REGEN_MS - now, 0);

  return {
    username, level, xp,
    xpForNext: xpForLevel(level),
    energy, energyMax: ENERGY_MAX,
    nextEnergyInMs,
    rewardsToday, rewardCap: DAILY_REWARD_CAP,
    coins,
  };
}

// Spend 1 energy (called at fight start). Returns false if none available.
export async function spendEnergy(username: string): Promise<boolean> {
  const p = await getPlayer(username); // settles regen first
  if (p.energy <= 0) return false;

  // If leaving full state, the regen clock starts NOW
  const updates: Record<string, string> = { energy: (p.energy - 1).toString() };
  if (p.energy === ENERGY_MAX) {
    updates.energyStamp = Date.now().toString();
  }
  await redis.hSet(playerKey(username), updates);
  return true;
}

// Grant XP for a fight result; handles level-ups (possibly multiple).
// Returns what happened so the client can celebrate.
export async function grantFightXp(
  username: string,
  bossId: string,
  won: boolean
): Promise<{ xpGained: number; leveledUpTo: number | null; rewardGranted: boolean; coinsGained: number }> {
  const p = await getPlayer(username);
  const winXp = BOSS_XP[bossId] ?? 100;
  const xpGained = won ? winXp : Math.round(winXp * 0.25);

  let level = p.level;
  let xp = p.xp + xpGained;
  let leveled = false;

  // Carry XP across multiple level-ups if needed
  while (xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level += 1;
    leveled = true;
  }

  // ---- Daily reward (wins only, first N per rolling window) ----
  let rewardGranted = false;
  let coinsGained = 0;
  const updates: Record<string, string> = {
    level: level.toString(),
    xp: xp.toString(),
  };

  if (won && p.rewardsToday < DAILY_REWARD_CAP) {
    rewardGranted = true;
    coinsGained = COINS_PER_REWARD;
    updates.rewardsToday = (p.rewardsToday + 1).toString();
    updates.coins = (p.coins + coinsGained).toString();
    if (p.rewardsToday === 0) {
      updates.rewardWindowStart = Date.now().toString(); // first rewarded win opens the window
    }
  }

  await redis.hSet(playerKey(username), updates);
  return { xpGained, leveledUpTo: leveled ? level : null, rewardGranted, coinsGained };
}