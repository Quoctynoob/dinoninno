import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { BossListResponse, BossListItem, MeResponse } from '../../shared/api';

const POLL_MS = 2000;

// One HUD chip: dark pill background + text content
type Chip = { bg: Phaser.GameObjects.Rectangle; text: Phaser.GameObjects.Text };

// Boss selection screen. Top HUD bar (level+XP left; energy/rewards/coins right),
// title, then boss cards.
export class BossSelect extends Scene {
  titleText: Phaser.GameObjects.Text;
  cards: Phaser.GameObjects.Container[] = [];
  bosses: BossListItem[] = [];
  pollTimer: Phaser.Time.TimerEvent;
  meTimer: Phaser.Time.TimerEvent;
  me: MeResponse | null = null;
  meLoadedAt: number = 0;
  xpText: Phaser.GameObjects.Text;

  // ---- HUD chips ----
  levelChip: Chip;
  xpBarBg: Phaser.GameObjects.Rectangle;
  xpBarFill: Phaser.GameObjects.Rectangle;
  energyChip: Chip;
  rewardsChip: Chip;
  coinsChip: Chip;

  constructor() {
    super('BossSelect');
  }

  // Build a chip (positioned/sized later in updateLayout)
  private makeChip(color: string): Chip {
    const bg = this.add.rectangle(0, 0, 10, 10, 0x0d1526, 0.85).setStrokeStyle(2, 0x3a4a6b);
    const text = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color, stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0, 0.5);
    return { bg, text };
  }

  create() {
    this.cameras.main.setBackgroundColor(0x0f1626);
    this.cards = [];
    this.bosses = [];
    this.me = null;

    // ---- HUD bar (one row) ----
    this.levelChip = this.makeChip('#ffffff');
    this.xpBarBg = this.add.rectangle(0, 0, 10, 10, 0x222222).setOrigin(0, 0);
    this.xpBarFill = this.add.rectangle(0, 0, 10, 10, 0x9b6dff).setOrigin(0, 0);
    this.xpText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffffff', stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);
    this.energyChip = this.makeChip('#ffd94a');
    this.rewardsChip = this.makeChip('#ff9ecb');
    this.coinsChip = this.makeChip('#ffcf5e');

    this.titleText = this.add
      .text(0, 0, '🦖 Choose Your Hunt', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    // ---- Data ----
    void this.loadMe();
    this.meTimer = this.time.addEvent({
      delay: 1000, loop: true,
      callback: () => this.renderStats(), // local countdown tick
    });
    void this.loadBosses();
    this.pollTimer = this.time.addEvent({
      delay: POLL_MS, loop: true,
      callback: () => void this.loadBosses(),
    });

    this.updateLayout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
  }

  async loadMe() {
    try {
      const res = await fetch('/api/me');
      this.me = (await res.json()) as MeResponse;
      this.meLoadedAt = Date.now();
      this.renderStats();
      this.updateLayout(this.scale.width, this.scale.height); // chip widths follow text
    } catch (e) {
      console.error('Failed to load player:', e);
    }
  }

  // Update all chip texts; energy countdown ticks locally between refreshes
  renderStats() {
    if (!this.me) return;
    const m = this.me;

    this.levelChip.text.setText(`🏅 Lv ${m.level}`);

    let energy = `⚡ ${m.energy}/${m.energyMax}`;
    if (m.energy < m.energyMax) {
      const remaining = Math.max(m.nextEnergyInMs - (Date.now() - this.meLoadedAt), 0);
      if (remaining === 0) { void this.loadMe(); return; }
      const totalSecs = Math.ceil(remaining / 1000);
      const h = Math.floor(totalSecs / 3600);
      const mnt = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      energy += ` · ${h > 0 ? `${h}h ${mnt}m` : mnt > 0 ? `${mnt}m ${s}s` : `${s}s`}`;
    }
    this.energyChip.text.setText(energy);

    this.rewardsChip.text.setText(`🎁 ${m.rewardCap - m.rewardsToday}/${m.rewardCap}`);
    this.coinsChip.text.setText(`🪙 ${m.coins}`);

    // XP bar + number inside it
    const ratio = m.xpForNext > 0 ? m.xp / m.xpForNext : 0;
    this.xpBarFill.width = this.xpBarBg.width * Math.min(ratio, 1);
    this.xpText.setText(`${m.xp} / ${m.xpForNext}`);
  }

  async loadBosses() {
    try {
      const res = await fetch('/api/bosses');
      const data = (await res.json()) as BossListResponse;
      this.bosses = data.bosses;
      this.rebuildCards();
    } catch (e) {
      console.error('Failed to load bosses:', e);
    }
  }

  rebuildCards() {
    this.cards.forEach((c) => c.destroy());
    this.cards = [];

    this.bosses.forEach((boss) => {
      const card = this.add.container(0, 0);

      const bg = this.add
        .rectangle(0, 0, 10, 10, 0x1e2a45)
        .setStrokeStyle(3, 0x3a4a6b)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => bg.setFillStyle(0x27365a))
        .on('pointerout', () => bg.setFillStyle(0x1e2a45))
        .on('pointerdown', () => {
          if (this.me && this.me.energy <= 0) {
            this.titleText.setText('⚡ Out of energy! Rest, hunter.');
            return;
          }
          this.pollTimer.remove();
          this.meTimer.remove();
          this.scene.start('Lobby', { bossId: boss.id });
        });

      const iconKey = `boss_${boss.id}`;
      const emoji = this.textures.exists(iconKey)
        ? (this.add.image(0, 0, iconKey) as Phaser.GameObjects.Image | Phaser.GameObjects.Text)
        : this.add.text(0, 0, boss.emoji, { fontSize: 48 }).setOrigin(0.5);
      if (emoji instanceof Phaser.GameObjects.Image) emoji.setOrigin(0.5);
      const name = this.add
        .text(0, 0, boss.name, { fontFamily: 'Arial Black', color: '#ffffff' })
        .setOrigin(0.5);
      const hp = this.add
        .text(0, 0, `❤️ ${boss.maxHp} HP`, { fontFamily: 'Arial', color: '#ff9b9b' })
        .setOrigin(0.5);
      const waiting = this.add
        .text(
          0, 0,
          boss.waiting > 0 ? `🔥 ${boss.waiting} hunter${boss.waiting > 1 ? 's' : ''} waiting!` : 'Be the first to join!',
          { fontFamily: 'Arial', color: boss.waiting > 0 ? '#ffd700' : '#8899bb' }
        )
        .setOrigin(0.5);

      card.add([bg, emoji, name, hp, waiting]);
      card.setData({ bg, emoji, name, hp, waiting });
      this.cards.push(card);
    });

    this.updateLayout(this.scale.width, this.scale.height);
  }

  // Size + place one chip around its text, returns chip width
  private layoutChip(chip: Chip, x: number, y: number, fontSize: number, rightAlign: boolean): number {
    chip.text.setFontSize(fontSize);
    const padX = Math.round(fontSize * 0.7);
    const w = chip.text.width + padX * 2;
    const h = fontSize * 2.1;
    const left = rightAlign ? x - w : x;
    chip.bg.setPosition(left + w / 2, y).setSize(w, h);
    chip.text.setPosition(left + padX, y);
    return w;
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;
    const isNarrow = width < 600;

    // ---- HUD bar: one row across the top ----
    const barY = height * 0.06;
    const chipFont = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 16));
    const gap = Math.round(chipFont * 0.6);

    // Left: level chip, XP bar to its right (number lives inside the bar)
    const lvlW = this.layoutChip(this.levelChip, width * 0.03, barY, chipFont, false);
    const xpW = Math.round(Phaser.Math.Clamp(width * 0.16, 80, 150));
    const xpH = Math.round(chipFont * 1.5);
    const xpX = width * 0.03 + lvlW + gap;
    this.xpBarBg.setPosition(xpX, barY - xpH / 2).setSize(xpW, xpH);
    const ratio = this.me && this.me.xpForNext > 0 ? Math.min(this.me.xp / this.me.xpForNext, 1) : 0;
    this.xpBarFill.setPosition(xpX, barY - xpH / 2).setSize(xpW * ratio, xpH);
    this.xpText.setFontSize(Math.max(chipFont - 3, 9)).setPosition(xpX + xpW / 2, barY);

    // Right: coins, rewards, energy — laid right-to-left so they hug the edge
    let rightEdge = width * 0.97;
    rightEdge -= this.layoutChip(this.coinsChip, rightEdge, barY, chipFont, true) + gap;
    rightEdge -= this.layoutChip(this.rewardsChip, rightEdge, barY, chipFont, true) + gap;
    this.layoutChip(this.energyChip, rightEdge, barY, chipFont, true);

    // ---- Title ----
    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.045, 20, 40));
    this.titleText.setFontSize(titleSize).setPosition(cx, height * 0.17);

    // ---- Cards ----
    const nameSize = Math.round(Phaser.Math.Clamp(width * 0.028, 14, 22));
    const smallSize = Math.round(Phaser.Math.Clamp(width * 0.022, 12, 17));
    const emojiSize = Math.round(Phaser.Math.Clamp(width * 0.06, 32, 52));

    if (isNarrow) {
      const cardW = width * 0.86;
      const cardH = height * 0.19;
      this.cards.forEach((card, i) => {
        card.setPosition(cx, height * (0.32 + i * 0.22));
        this.sizeCard(card, cardW, cardH, emojiSize, nameSize, smallSize, true);
      });
    } else {
      const cardW = Math.min(width * 0.26, 280);
      const cardH = height * 0.48;
      const spacing = cardW + width * 0.03;
      this.cards.forEach((card, i) => {
        card.setPosition(cx + (i - 1) * spacing, height * 0.56);
        this.sizeCard(card, cardW, cardH, emojiSize, nameSize, smallSize, false);
      });
    }
  }

  sizeCard(
    card: Phaser.GameObjects.Container,
    w: number, h: number,
    emojiSize: number, nameSize: number, smallSize: number,
    horizontal: boolean
  ) {
    const bg = card.getData('bg') as Phaser.GameObjects.Rectangle;
    const emoji = card.getData('emoji') as Phaser.GameObjects.Text;
    const name = card.getData('name') as Phaser.GameObjects.Text;
    const hp = card.getData('hp') as Phaser.GameObjects.Text;
    const waiting = card.getData('waiting') as Phaser.GameObjects.Text;

    bg.setSize(w, h);
    if (emoji instanceof Phaser.GameObjects.Image) {
      const target = emojiSize * 1.6;
      const scale = target / Math.max(emoji.height, 1);
      emoji.setScale(scale);
    } else {
      (emoji as Phaser.GameObjects.Text).setFontSize(emojiSize);
    }
    name.setFontSize(nameSize);
    hp.setFontSize(smallSize);
    waiting.setFontSize(smallSize);

    if (horizontal) {
      emoji.setPosition(-w * 0.32, 0);
      name.setPosition(w * 0.08, -h * 0.25);
      hp.setPosition(w * 0.08, 0);
      waiting.setPosition(w * 0.08, h * 0.25);
    } else {
      emoji.setPosition(0, -h * 0.28);
      name.setPosition(0, -h * 0.05);
      hp.setPosition(0, h * 0.12);
      waiting.setPosition(0, h * 0.3);
    }
  }
}