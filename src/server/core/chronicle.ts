import { reddit } from '@devvit/web/server';
import type { PlayerContribution } from '../../shared/api';

const ROLE_EMOJI: Record<string, string> = {
  attacker: '⚔️', defender: '🛡️', supporter: '💚',
};

// Post a one-line victory announcement on the game post.
// Fire-and-forget: failures are logged, never break the win.
export async function postVictoryComment(
  postId: string,
  bossName: string,
  bossEmoji: string,
  contributions: PlayerContribution[],
  durationMs: number
) {
  try {
    const partyLine = contributions
      .map((p) => `u/${p.username} (${ROLE_EMOJI[p.role] ?? '⚔️'})`)
      .join(', ');

    const secs = Math.max(Math.round(durationMs / 1000), 1);
    const duration = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;

    const text =
      `🏆 **${bossEmoji} ${bossName} has fallen!**\n\n` +
      `${partyLine} brought it down in ${duration}. Who hunts next?`;

    await reddit.submitComment({ id: postId as `t3_${string}`, text });
  } catch (e) {
    console.error('Victory comment failed (non-fatal):', e);
  }
}