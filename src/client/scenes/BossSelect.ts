import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { BossListResponse, BossListItem } from '../../shared/api';

const POLL_MS = 2000; // refresh "hunters waiting" counts

// Boss selection: shows 3 boss cards with live waiting counts.
// Picking one hands off to the Lobby scene for that boss.
export class BossSelect extends Scene {
  titleText: Phaser.GameObjects.Text;
  cards: Phaser.GameObjects.Container[] = [];
  bosses: BossListItem[] = [];
  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('BossSelect');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x0f1626);

    this.titleText = this.add
      .text(0, 0, '🦖 Choose Your Hunt', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    // Load bosses now + poll so waiting counts stay fresh
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

  // Destroy + recreate cards from latest data (simple and safe at this scale)
  rebuildCards() {
    this.cards.forEach((c) => c.destroy());
    this.cards = [];

    this.bosses.forEach((boss) => {
      const card = this.add.container(0, 0);

      // Card background (sized in updateLayout)
      const bg = this.add
        .rectangle(0, 0, 10, 10, 0x1e2a45)
        .setStrokeStyle(3, 0x3a4a6b)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => bg.setFillStyle(0x27365a))
        .on('pointerout', () => bg.setFillStyle(0x1e2a45))
        .on('pointerdown', () => {
          this.pollTimer.remove();
          this.scene.start('Lobby', { bossId: boss.id });
        });

      const emoji = this.add.text(0, 0, boss.emoji, { fontSize: 48 }).setOrigin(0.5);
      const name = this.add
        .text(0, 0, boss.name, {
          fontFamily: 'Arial Black', color: '#ffffff',
        })
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
      // Stash refs for layout
      card.setData({ bg, emoji, name, hp, waiting });
      this.cards.push(card);
    });

    this.updateLayout(this.scale.width, this.scale.height);
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;
    const isNarrow = width < 600;

    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.05, 22, 44));
    this.titleText.setFontSize(titleSize).setPosition(cx, height * 0.09);

    const nameSize = Math.round(Phaser.Math.Clamp(width * 0.028, 14, 22));
    const smallSize = Math.round(Phaser.Math.Clamp(width * 0.022, 12, 17));
    const emojiSize = Math.round(Phaser.Math.Clamp(width * 0.06, 32, 52));

    if (isNarrow) {
      // Phone: cards stacked vertically, wide and short
      const cardW = width * 0.86;
      const cardH = height * 0.2;
      this.cards.forEach((card, i) => {
        card.setPosition(cx, height * (0.24 + i * 0.25));
        this.sizeCard(card, cardW, cardH, emojiSize, nameSize, smallSize, true);
      });
    } else {
      // Desktop: three cards in a row
      const cardW = Math.min(width * 0.26, 280);
      const cardH = height * 0.5;
      const spacing = cardW + width * 0.03;
      this.cards.forEach((card, i) => {
        card.setPosition(cx + (i - 1) * spacing, height * 0.52);
        this.sizeCard(card, cardW, cardH, emojiSize, nameSize, smallSize, false);
      });
    }
  }

  // Layout the elements inside one card. Horizontal arrangement on phones, vertical on desktop.
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
    emoji.setFontSize(emojiSize);
    name.setFontSize(nameSize);
    hp.setFontSize(smallSize);
    waiting.setFontSize(smallSize);

    if (horizontal) {
      // emoji left, texts stacked to its right
      emoji.setPosition(-w * 0.32, 0);
      name.setPosition(w * 0.08, -h * 0.25);
      hp.setPosition(w * 0.08, 0);
      waiting.setPosition(w * 0.08, h * 0.25);
    } else {
      // vertical stack
      emoji.setPosition(0, -h * 0.28);
      name.setPosition(0, -h * 0.05);
      hp.setPosition(0, h * 0.12);
      waiting.setPosition(0, h * 0.3);
    }
  }
}