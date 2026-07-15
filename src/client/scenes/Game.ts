import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { FightStateResponse, Role, PlayerContribution } from '../../shared/api';

const TAP_COOLDOWN_MS = 400;
const POLL_INTERVAL_MS = 500;

export class Game extends Scene {
  camera: Phaser.Cameras.Scene2D.Camera;

  // ---- Fight state ----
  roomId: string = '';
  myRole: Role = 'attacker';
  bossHp: number = 0;
  bossMaxHp: number = 1;
  partyHp: number = 0;
  partyMaxHp: number = 1;
  shield: number = 0;
  fightOver: boolean = false;
  lastTapAt: number = 0;
  lastSeenBossHp: number | null = null;
  lastSeenPartyHp: number | null = null;

  // ---- Visuals ----
  background: Phaser.GameObjects.Image | null = null;
  bossSprite: Phaser.GameObjects.Image;
  bossIdleTween: Phaser.Tweens.Tween | null = null;
  currentBossId: string = '';
  initialBossId: string = 'raptor';
  partySprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
  partyShadows: Map<string, Phaser.GameObjects.Image> = new Map();
  partyNames: Map<string, Phaser.GameObjects.Text> = new Map();
  partyBars: Map<string, { bg: Phaser.GameObjects.Rectangle; fill: Phaser.GameObjects.Rectangle }> = new Map();

  // ---- Fight UI ----
  bossNameText: Phaser.GameObjects.Text;
  bossHpBarBg: Phaser.GameObjects.Rectangle;
  bossHpBarFill: Phaser.GameObjects.Rectangle;
  bossHpText: Phaser.GameObjects.Text;
  shieldText: Phaser.GameObjects.Text;
  bossBarWidth: number = 300;

  // ---- End screen (single container = one switch for everything) ----
  endScreen: Phaser.GameObjects.Container;
  endPanel: Phaser.GameObjects.Rectangle;
  resultText: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
  celebrationText: Phaser.GameObjects.Text;
  backButton: Phaser.GameObjects.Text;
  preFightMe: { level: number; coins: number } | null = null;

  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('Game');
  }

  // Receives { roomId, role, bossId } from the Lobby
  init(data: { roomId: string; role?: Role; bossId?: string }) {
    this.roomId = data.roomId;
    this.myRole = data.role ?? 'attacker';
    this.initialBossId = data.bossId ?? 'raptor';
    this.fightOver = false;
    this.lastTapAt = 0;
    this.lastSeenBossHp = null;
    this.lastSeenPartyHp = null;
    this.background = null;
    this.bossIdleTween = null;
    this.currentBossId = '';
    this.preFightMe = null;
    this.partySprites = new Map();
    this.partyShadows = new Map();
    this.partyNames = new Map();
    this.partyBars = new Map();
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x0d1526);
    this.camera.fadeIn(300, 13, 21, 38);

    // ---- Background + boss: created directly with real art (known from the lobby) ----
    this.background = this.add.image(0, 0, `bg_${this.initialBossId}`).setOrigin(0.5).setDepth(-10);
    this.bossSprite = this.add.image(0, 0, `boss_${this.initialBossId}`).setOrigin(0.5, 1);
    this.currentBossId = this.initialBossId;

    // ---- Tap anywhere on the battlefield to act ----
    this.input.on('pointerdown', () => void this.onActionTap());

    // ---- Boss UI (floats above the boss) ----
    this.bossNameText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 6,
      })
      .setOrigin(0.5);
    this.bossHpBarBg = this.add.rectangle(0, 0, 10, 10, 0x222222).setOrigin(0.5);
    this.bossHpBarFill = this.add.rectangle(0, 0, 10, 10, 0xe63946).setOrigin(0, 0.5);
    this.bossHpText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);

    // ---- Shield indicator (near the squad) ----
    this.shieldText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#7fb3ff',
        stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);

    // ---- Boss idle: gentle breathing bob ----
    this.bossIdleTween = this.tweens.add({
      targets: this.bossSprite,
      scaleY: { from: 1, to: 1.04 },
      scaleX: { from: 1, to: 0.98 },
      duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    // ---- Load + poll ----
    void this.loadFightState();
    this.pollTimer = this.time.addEvent({
      delay: POLL_INTERVAL_MS, loop: true,
      callback: () => void this.loadFightState(),
    });

    // Snapshot my level/coins so the end screen can show what this fight earned
    void fetch('/api/me')
      .then((r) => r.json())
      .then((me: { level: number; coins: number }) => {
        this.preFightMe = { level: me.level, coins: me.coins };
      });

    // ================= END SCREEN (full-page, single container) =================
    this.endPanel = this.add.rectangle(0, 0, 10, 10, 0x0d1526, 1);

    this.resultText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffd700',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial', color: '#ffffff', align: 'center',
        stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);

    this.celebrationText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#7dff9b',
        stroke: '#000000', strokeThickness: 4, align: 'center',
      })
      .setOrigin(0.5);

    this.backButton = this.add
      .text(0, 0, '↩️ Back to Hunts', {
        fontFamily: 'Arial Black', color: '#ffffff', backgroundColor: '#444466',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.pollTimer.remove();
        this.scene.start('BossSelect');
      });

    this.endScreen = this.add.container(0, 0, [
      this.endPanel,
      this.resultText,
      this.statusText,
      this.celebrationText,
      this.backButton,
    ]);
    this.endScreen.setDepth(100).setVisible(false);

    // ---- Responsive layout ----
    this.updateLayout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
  }

  // Play a sound with random pitch variation. Safe if audio isn't loaded (no-op).
  playVaried(key: string, volume: number) {
    if (!this.cache.audio.exists(key)) return;
    this.sound.play(key, { volume, detune: Phaser.Math.Between(-100, 100) });
  }

  async loadFightState() {
    if (!this.roomId) return;
    try {
      const response = await fetch(`/api/fight/${this.roomId}`);
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as FightStateResponse;
      this.applyState(data);
    } catch (error) {
      console.error('Failed to load fight state:', error);
    }
  }

  async onActionTap() {
    if (this.fightOver || !this.roomId) return;
    const now = Date.now();
    if (now - this.lastTapAt < TAP_COOLDOWN_MS) return;
    this.lastTapAt = now;

    // Role-flavored tap sound (pitch-varied, quiet — it fires constantly)
    const sfx = this.myRole === 'supporter' ? 'sfx_heal' : this.myRole === 'defender' ? 'sfx_shield' : 'sfx_hit';
    this.playVaried(sfx, 0.3);

    // Attackers shake the camera a touch
    if (this.myRole === 'attacker') this.camera.shake(80, 0.004);

    // My dino plays its attack animation, then returns to idle
    this.partySprites.forEach((sprite) => {
      if (sprite.texture.key === `dino_${this.myRole}`) {
        sprite.play(`dino_${this.myRole}_attack`);
        sprite.once('animationcomplete', () => sprite.play(`dino_${this.myRole}_idle`));
      }
    });

    // Boss squishes slightly under your tap (immediate local feedback)
    this.tweens.add({
      targets: this.bossSprite,
      scaleX: this.bossSprite.scaleX * 1.05,
      scaleY: this.bossSprite.scaleY * 0.95,
      duration: 70, yoyo: true,
    });

    try {
      const response = await fetch(`/api/fight/${this.roomId}/tap`, { method: 'POST' });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as FightStateResponse;
      this.applyState(data);
    } catch (error) {
      console.error('Tap failed:', error);
    }
  }

  // Safety net: if the server says this room is a different boss (e.g. reconnect
  // into an active fight), swap the textures to match
  ensureBossArt(bossId: string) {
    if (bossId === this.currentBossId) return;
    this.currentBossId = bossId;
    this.bossSprite.setTexture(`boss_${bossId}`);
    this.background?.setTexture(`bg_${bossId}`);
    this.updateLayout(this.scale.width, this.scale.height);
  }

  // Place each party member's dino: bottom-left squad with name + mini HP bar above
  syncPartySprites(contributions: PlayerContribution[]) {
    const { width, height } = this.scale;
    const dinoScale = Math.max(Math.round((height * 0.08) / 24), 2);

    contributions.forEach((p, i) => {
      if (this.partySprites.has(p.username)) return;

      const x = width * (0.16 + i * 0.11);
      const y = height * (0.66 + i * 0.05);
      const key = `dino_${p.role}`;

      const shadow = this.add.image(x, y + 4 * dinoScale, 'shadow')
        .setScale(dinoScale).setAlpha(0.45);
      const sprite = this.add.sprite(x, y, key)
        .setScale(dinoScale)
        .play(`${key}_idle`);

      // Boss-style name + mini HP bar above the dino
      const barW = 20 * dinoScale;
      const barH = Math.max(3 * Math.floor(dinoScale / 2), 4);
      const barY = y - 12 * dinoScale;

      const nameTag = this.add
        .text(x, barY - barH - 6, p.username, {
          fontFamily: 'Arial', fontSize: 11, color: '#ffffff',
          stroke: '#000000', strokeThickness: 3,
        })
        .setOrigin(0.5);
      const barBg = this.add.rectangle(x, barY, barW, barH, 0x222222).setOrigin(0.5);
      const barFill = this.add
        .rectangle(x - barW / 2, barY, barW, barH, 0x4caf50)
        .setOrigin(0, 0.5);

      this.partyShadows.set(p.username, shadow);
      this.partySprites.set(p.username, sprite);
      this.partyNames.set(p.username, nameTag);
      this.partyBars.set(p.username, { bg: barBg, fill: barFill });
    });
  }

  // Floating damage/heal number that drifts up and fades
  spawnFloatingNumber(x: number, y: number, text: string, color: string) {
    const num = this.add
      .text(x + Phaser.Math.Between(-14, 14), y, text, {
        fontFamily: 'Arial Black',
        fontSize: Math.round(Phaser.Math.Clamp(this.scale.width * 0.03, 16, 26)),
        color, stroke: '#000000', strokeThickness: 4,
      })
      .setOrigin(0.5);
    this.tweens.add({
      targets: num,
      y: y - 46,
      alpha: { from: 1, to: 0 },
      duration: 800,
      ease: 'Cubic.easeOut',
      onComplete: () => num.destroy(),
    });
  }

  // Boss reaction to taking damage: shake + red flash
  bossHitReaction() {
    this.tweens.add({
      targets: this.bossSprite,
      x: this.bossSprite.x + 6,
      duration: 50,
      yoyo: true,
      repeat: 2,
    });
    this.bossSprite.setTint(0xff6666);
    this.time.delayedCall(120, () => this.bossSprite.clearTint());
  }

  // Apply full fight state to the UI
  applyState(s: FightStateResponse) {
    // Once the fight ended, ignore any late/stale responses
    if (this.fightOver) return;

    this.ensureBossArt(s.bossId);
    this.syncPartySprites(s.contributions);

    // ---- Detect changes for juice (floating numbers, reactions, sounds) ----
    if (this.lastSeenBossHp !== null && s.bossHp < this.lastSeenBossHp) {
      const dmg = this.lastSeenBossHp - s.bossHp;
      this.spawnFloatingNumber(this.bossSprite.x, this.bossSprite.y - 60, `-${dmg}`, '#ffdd57');
      this.bossHitReaction();
      // Soft tick for teammates' hits (skip if it was likely my own tap echoing back)
      if (Date.now() - this.lastTapAt > 300 && Math.random() < 0.5) {
        this.playVaried('sfx_hit', 0.15);
      }
    }
    if (this.lastSeenPartyHp !== null && s.partyHp < this.lastSeenPartyHp) {
      const dmg = this.lastSeenPartyHp - s.partyHp;
      const firstDino = [...this.partySprites.values()][0];
      if (firstDino) this.spawnFloatingNumber(firstDino.x + 30, firstDino.y - 30, `-${dmg}`, '#ff6b6b');
      this.camera.flash(150, 120, 20, 20);
    }
    if (this.lastSeenPartyHp !== null && s.partyHp > this.lastSeenPartyHp) {
      const heal = s.partyHp - this.lastSeenPartyHp;
      const firstDino = [...this.partySprites.values()][0];
      if (firstDino) this.spawnFloatingNumber(firstDino.x + 30, firstDino.y - 30, `+${heal}`, '#7dff9b');
    }
    this.lastSeenBossHp = s.bossHp;
    this.lastSeenPartyHp = s.partyHp;

    // ---- Numbers + bars ----
    this.bossHp = s.bossHp;
    this.bossMaxHp = s.bossMaxHp;
    this.partyHp = s.partyHp;
    this.partyMaxHp = s.partyMaxHp;
    this.shield = s.shield;

    this.bossNameText.setText(`${s.bossName}`);
    this.bossHpText.setText(`${s.bossHp} / ${s.bossMaxHp}`);
    this.shieldText.setText(s.shield > 0 ? `🛡️ ${s.shield}` : '');

    this.tweens.add({
      targets: this.bossHpBarFill,
      width: Math.max((s.bossHp / s.bossMaxHp) * this.bossBarWidth, 0),
      duration: 200, ease: 'Cubic.easeOut',
    });

    // Mini bars above each dino mirror the shared party HP (per-player HP: future)
    const ratio = s.partyHp / s.partyMaxHp;
    this.partyBars.forEach(({ bg, fill }) => {
      const w = bg.width * ratio;
      this.tweens.add({ targets: fill, width: Math.max(w, 0), duration: 200, ease: 'Cubic.easeOut' });
      fill.setFillStyle(ratio > 0.5 ? 0x4caf50 : ratio > 0.25 ? 0xff9800 : 0xf44336);
    });

    // ---- End state (runs once) ----
    if (s.result && !this.fightOver) {
      this.fightOver = true;
      this.pollTimer.remove();

      if (s.result === 'win') {
        this.resultText.setText('🏆 VICTORY!').setColor('#ffd700');
        this.camera.shake(300, 0.01);
        this.bossDeathAnimation();
      } else {
        this.resultText.setText('💀 DEFEAT').setColor('#ff6b6b');
        this.partySprites.forEach((sprite) => {
          const base = sprite.texture.key;
          sprite.play(`${base}_hurt`);
        });
      }
      this.playVaried(s.result === 'win' ? 'sfx_victory' : 'sfx_defeat', 0.7);

      // Per-player contribution recap
      const lines = s.contributions.map((p) => {
        const parts = [`⚔️ ${p.damage}`];
        if (p.blocked > 0) parts.push(`🛡️ ${p.blocked}`);
        if (p.healed > 0) parts.push(`💚 ${p.healed}`);
        return `${p.username}: ${parts.join('  ')}`;
      });
      lines.push('');
      lines.push(s.result === 'win'
        ? '✨ XP earned! Check the hunt board.'
        : '✨ Some XP earned for the effort.');
      this.statusText.setText(lines.join('\n'));

      // What did I personally earn? Compare against pre-fight snapshot
      void fetch('/api/me')
        .then((r) => r.json())
        .then((me: { level: number; coins: number }) => {
          const celebration: string[] = [];
          if (this.preFightMe) {
            const coinsGained = me.coins - this.preFightMe.coins;
            if (coinsGained > 0) celebration.push(`🪙 +${coinsGained} coins!`);
            if (me.level > this.preFightMe.level) {
              celebration.push(`⬆️ LEVEL UP! Now Lv ${me.level}`);
              this.playVaried('sfx_victory', 0.5);
              this.celebrationText.setScale(0.3);
              this.tweens.add({
                targets: this.celebrationText,
                scale: 1, duration: 400, ease: 'Back.easeOut',
              });
            }
          }
          this.celebrationText.setText(celebration.join('\n'));
        });

      // Let the boss death animation breathe, then take over the page
      this.time.delayedCall(800, () => {
        this.endScreen.setVisible(true);
      });
    }
  }

  // Boss death: stop idle, dramatic squash + fade + fall
  bossDeathAnimation() {
    this.bossIdleTween?.remove();
    this.tweens.add({
      targets: this.bossSprite,
      scaleY: 0.2,
      scaleX: 1.3,
      alpha: 0.3,
      angle: 8,
      y: this.bossSprite.y + 20,
      duration: 700,
      ease: 'Bounce.easeOut',
    });
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;
    const isNarrow = width < 600;

    // ---- Background covers screen ----
    if (this.background) {
      this.background.setPosition(cx, height / 2);
      const scale = Math.max(width / this.background.width, height / this.background.height);
      this.background.setScale(scale);
    }

    // ---- Boss: right-of-center on the ground line ----
    // ---- Boss: size capped by BOTH height and width so no screen shape breaks it ----
    const groundY = height * 0.72;
    const bossX = isNarrow ? width * 0.66 : width * 0.68;

    const srcH = this.bossSprite.height || 64;
    const srcW = this.bossSprite.width || 64;

    // Boss may be at most 34% of screen height AND 42% of screen width,
    // whichever is more restrictive — tall bosses obey the height cap,
    // wide bosses obey the width cap. Never breaks on any aspect ratio.
    const bossScale = Math.min(
      (height * 0.34) / srcH,
      (width * 0.42) / srcW
    );
    this.bossSprite.setPosition(bossX, groundY);
    this.bossSprite.setScale(bossScale);

    // ---- Boss UI: pinned to a fixed screen band (NOT the boss's head) ----
    // Fixed band = always visible, always readable, regardless of boss size.
    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.036, 16, 30));
    const barTextSize = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 16));
    this.bossBarWidth = Math.min(width * 0.42, 280);
    const bossBarH = Math.round(Phaser.Math.Clamp(height * 0.03, 14, 22));

    const bossBarY = height * 0.12;                    // bar band: 12% from top
    const bossNameY = bossBarY - bossBarH * 1.6;       // name right above the bar

    this.bossNameText.setFontSize(titleSize).setPosition(bossX, bossNameY);
    this.bossHpBarBg.setPosition(bossX, bossBarY).setSize(this.bossBarWidth, bossBarH);
    this.bossHpBarFill
      .setPosition(bossX - this.bossBarWidth / 2, bossBarY)
      .setSize(this.bossBarWidth * (this.bossHp / this.bossMaxHp || 0), bossBarH);
    this.bossHpText.setFontSize(barTextSize).setPosition(bossX, bossBarY);

    // ---- Shield indicator near the squad ----
    this.shieldText
      .setFontSize(barTextSize + 2)
      .setPosition(width * 0.16, height * 0.86);

    // ---- End screen: full-page takeover ----
    const labelSize = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 16));
    const actionSize = Math.round(Phaser.Math.Clamp(width * 0.045, 22, 40));
    const resultSize = Math.round(Phaser.Math.Clamp(width * 0.065, 30, 56));

    this.endPanel.setPosition(cx, height / 2).setSize(width, height);
    this.resultText.setFontSize(resultSize).setPosition(cx, height * 0.18);
    this.statusText.setFontSize(Math.round(labelSize * 1.15)).setPosition(cx, height * 0.45);
    this.celebrationText.setFontSize(Math.round(labelSize * 1.5)).setPosition(cx, height * 0.68);
    this.backButton
      .setFontSize(Math.round(actionSize * 0.6))
      .setPadding({ x: 20, y: 12 } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.85);

      console.log('boss debug:', { srcH, bossScale, texH: this.bossSprite.height, dispH: this.bossSprite.displayHeight, screenH: height });
  }
}