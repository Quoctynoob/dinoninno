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
  bossSprite: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  bossIdleTween: Phaser.Tweens.Tween | null = null;
  partySprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
  partyShadows: Map<string, Phaser.GameObjects.Image> = new Map();
  partyNames: Map<string, Phaser.GameObjects.Text> = new Map();
  partyBars: Map<string, { bg: Phaser.GameObjects.Rectangle; fill: Phaser.GameObjects.Rectangle }> = new Map();

  // ---- UI ----
  bossNameText: Phaser.GameObjects.Text;
  bossHpBarBg: Phaser.GameObjects.Rectangle;
  bossHpBarFill: Phaser.GameObjects.Rectangle;
  bossHpText: Phaser.GameObjects.Text;
  shieldText: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
  resultText: Phaser.GameObjects.Text;
  backButton: Phaser.GameObjects.Text;
  bossBarWidth: number = 300;
  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('Game');
  }

  init(data: { roomId: string; role?: Role }) {
    this.roomId = data.roomId;
    this.myRole = data.role ?? 'attacker';
    this.fightOver = false;
    this.lastTapAt = 0;
    this.lastSeenBossHp = null;
    this.lastSeenPartyHp = null;
    this.partySprites = new Map();
    this.partyShadows = new Map();
    this.partyNames = new Map();
    this.partyBars = new Map();
    this.bossIdleTween = null;
    this.background = null;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x1a2f1a); // jungle-dark fallback behind bg image

    // ---- Background (covers screen; placeholder = plain color if missing) ----
    if (this.textures.exists('bg_arena')) {
      this.background = this.add.image(0, 0, 'bg_arena').setOrigin(0.5);
    }

    // ---- Boss: sprite if art exists, placeholder otherwise — TAP THE BOSS TO ACT ----
    if (this.textures.exists('boss_volcano')) {
      this.bossSprite = this.add.image(0, 0, 'boss_volcano')
        .setOrigin(0.5, 1)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => void this.onActionTap());
    } else {
      this.bossSprite = this.add.rectangle(0, 0, 64, 64, 0x6a3d7b)
        .setOrigin(0.5, 1)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => void this.onActionTap());
    }

    // ---- Boss UI (floats above the boss) ----
    this.bossNameText = this.add
      .text(0, 0, 'Loading...', {
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

    // ---- Party UI (bottom strip) ----
    this.shieldText = this.add
      .text(0, 0, '', { fontFamily: 'Arial Black', color: '#7fb3ff', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5);

    // ---- Status / result ----
    this.statusText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial', color: '#ffffff', align: 'center',
        stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);
    this.resultText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffd700',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setVisible(false);


    // ---- Back button (post-fight) ----
    this.backButton = this.add
      .text(0, 0, '↩️ Back to Hunts', {
        fontFamily: 'Arial Black', color: '#ffffff', backgroundColor: '#444466',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.pollTimer.remove();
        this.scene.start('BossSelect');
      })
      .setVisible(false);

    // ---- Boss idle: gentle breathing bob (runs forever until death) ----
    this.bossIdleTween = this.tweens.add({
      targets: this.bossSprite,
      scaleY: { from: 1, to: 1.04 },
      scaleX: { from: 1, to: 0.98 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // ---- Load + poll ----
    void this.loadFightState();
    this.pollTimer = this.time.addEvent({
      delay: POLL_INTERVAL_MS, loop: true,
      callback: () => void this.loadFightState(),
    });

    this.updateLayout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
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

    // My dino attacks; button pops; attackers also shake the camera
    if (this.myRole === 'attacker') this.camera.shake(80, 0.004);
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

  // Place each party member's dino: bottom-left squad, staggered, facing the boss
  syncPartySprites(contributions: PlayerContribution[]) {
    const { width, height } = this.scale;
    const dinoScale = Math.max(Math.round((height * 0.08) / 24), 2);

    contributions.forEach((p, i) => {
      if (this.partySprites.has(p.username)) return;

      // Diagonal stagger: front-most squad member lowest + right-most
      const x = width * (0.16 + i * 0.11);
      const y = height * (0.66 + i * 0.05);
      const key = `dino_${p.role}`;

      const shadow = this.add.image(x, y + 4 * dinoScale, 'shadow')
        .setScale(dinoScale).setAlpha(0.45);
      const sprite = this.add.sprite(x, y, key)
        .setScale(dinoScale)
        .play(`${key}_idle`);
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

      this.partyBars.set(p.username, { bg: barBg, fill: barFill });

      this.partyShadows.set(p.username, shadow);
      this.partySprites.set(p.username, sprite);
      this.partyNames.set(p.username, nameTag);
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
    if (this.bossSprite instanceof Phaser.GameObjects.Image) {
      this.bossSprite.setTint(0xff6666);
      this.time.delayedCall(120, () => {
        (this.bossSprite as Phaser.GameObjects.Image).clearTint();
      });
    }
  }

  applyState(s: FightStateResponse) {
    if (this.fightOver) return;

    this.syncPartySprites(s.contributions);

    // ---- Detect changes for juice (floating numbers, reactions) ----
    if (this.lastSeenBossHp !== null && s.bossHp < this.lastSeenBossHp) {
      const dmg = this.lastSeenBossHp - s.bossHp;
      this.spawnFloatingNumber(this.bossSprite.x, this.bossSprite.y - 60, `-${dmg}`, '#ffdd57');
      this.bossHitReaction();
    }
    if (this.lastSeenPartyHp !== null && s.partyHp < this.lastSeenPartyHp) {
      // Boss counter-attack landed: number over the squad + red screen edge flash
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
    const ratio = s.partyHp / s.partyMaxHp;
    // Mini bars above each dino mirror the shared party HP (per-player HP: future)
    this.partyBars.forEach(({ bg, fill }) => {
      const w = bg.width * ratio;
      this.tweens.add({ targets: fill, width: Math.max(w, 0), duration: 200, ease: 'Cubic.easeOut' });
      fill.setFillStyle(ratio > 0.5 ? 0x4caf50 : ratio > 0.25 ? 0xff9800 : 0xf44336);
    });

    // ---- End states (once) ----
    if (s.result && !this.fightOver) {
      this.fightOver = true;
      this.pollTimer.remove();
      this.backButton.setVisible(true);
      this.resultText.setVisible(true);

      if (s.result === 'win') {
        this.resultText.setText('🏆 VICTORY!').setColor('#ffd700');
        this.camera.shake(300, 0.01);
        this.bossDeathAnimation();
      } else {
        this.resultText.setText('💀 DEFEAT').setColor('#ff6b6b');
        // Squad slumps: hurt animation on everyone
        this.partySprites.forEach((sprite) => {
          const base = sprite.texture.key;
          sprite.play(`${base}_hurt`);
        });
      }

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

    // ---- Boss: right-of-center, standing on an implied ground line ----
    const groundY = height * 0.72;
    const bossX = isNarrow ? width * 0.68 : width * 0.66;
    // Boss height ~28% of screen; source is 64px tall
    const bossScale = Math.max((height * 0.28) / 64, 1.5);
    this.bossSprite.setPosition(bossX, groundY);
    this.bossSprite.setScale(bossScale);

    // ---- Boss UI floats above the boss ----
    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.036, 16, 30));
    const barTextSize = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 16));
    this.bossBarWidth = Math.min(width * 0.34, 260);
    const bossBarH = Math.round(Phaser.Math.Clamp(height * 0.03, 14, 22));
    const bossTopY = groundY - 64 * bossScale;

    this.bossNameText.setFontSize(titleSize).setPosition(bossX, bossTopY - bossBarH * 2.4);
    this.bossHpBarBg.setPosition(bossX, bossTopY - bossBarH).setSize(this.bossBarWidth, bossBarH);
    this.bossHpBarFill
      .setPosition(bossX - this.bossBarWidth / 2, bossTopY - bossBarH)
      .setSize(this.bossBarWidth * (this.bossHp / this.bossMaxHp || 0), bossBarH);
    this.bossHpText.setFontSize(barTextSize).setPosition(bossX, bossTopY - bossBarH);

    // ---- Shield indicator: floats near the squad (bottom-left area) ----
    this.shieldText
      .setFontSize(barTextSize + 2)
      .setPosition(width * 0.16, height * 0.86);

    // ---- Status / result / buttons ----
    const labelSize = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 16));
    const actionSize = Math.round(Phaser.Math.Clamp(width * 0.045, 22, 40));
    const resultSize = Math.round(Phaser.Math.Clamp(width * 0.065, 30, 56));

    this.statusText.setFontSize(labelSize).setPosition(cx, height * 0.3);
    this.resultText.setFontSize(resultSize).setPosition(cx, height * 0.42);
    this.backButton
      .setFontSize(Math.round(actionSize * 0.6))
      .setPadding({ x: 20, y: 12 } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.91);
  }
}