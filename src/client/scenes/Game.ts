import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { FightStateResponse } from '../../shared/api';

const TAP_COOLDOWN_MS = 400; // time between allowed taps
const POLL_INTERVAL_MS = 500; // how often we refresh boss HP from server

export class Game extends Scene {
  camera: Phaser.Cameras.Scene2D.Camera;

  // ---- Fight state ----
  roomId: string = '';
  bossHp: number = 0;
  bossMaxHp: number = 1;
  defeated: boolean = false;
  lastTapAt: number = 0;

  // ---- UI elements ----
  bossNameText: Phaser.GameObjects.Text;
  hpText: Phaser.GameObjects.Text;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
  attackButton: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;

  // Current HP bar width in px (needed to re-apply fill % on resize)
  hpBarWidth: number = 500;

  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('Game');
  }

  // Receives { roomId } from the Lobby scene
  init(data: { roomId: string }) {
    this.roomId = data.roomId;
    this.defeated = false;
    this.lastTapAt = 0;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x1a1a2e);

    // ---- Create UI at 0,0 — updateLayout() positions everything ----

    this.bossNameText = this.add
      .text(0, 0, '🦖 Rogue Raptor', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.hpBarBg = this.add.rectangle(0, 0, 500, 36, 0x333333).setOrigin(0.5);
    this.hpBarFill = this.add.rectangle(0, 0, 500, 36, 0xe63946).setOrigin(0, 0.5);

    this.hpText = this.add
      .text(0, 0, '...', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 4,
      })
      .setOrigin(0.5);

    this.statusText = this.add
      .text(0, 0, '', { fontFamily: 'Arial', color: '#aaaaaa' })
      .setOrigin(0.5);

    this.attackButton = this.add
      .text(0, 0, '⚔️ ATTACK', {
        fontFamily: 'Arial Black', color: '#ffd700',
        backgroundColor: '#7b2d26',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.attackButton.setStyle({ backgroundColor: '#94382e' }))
      .on('pointerout', () => this.attackButton.setStyle({ backgroundColor: '#7b2d26' }))
      .on('pointerdown', () => void this.onAttackTap());

    // ---- Initial load + polling for other players' damage ----
    void this.loadFightState();
    this.pollTimer = this.time.addEvent({
      delay: POLL_INTERVAL_MS,
      loop: true,
      callback: () => void this.loadFightState(),
    });

    // ---- Responsive layout: run now + on every resize ----
    this.updateLayout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
  }

  // Position + size everything from actual screen dimensions
  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;

    // Scale fonts with width, clamped
    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.055, 24, 48));
    const hpSize = Math.round(Phaser.Math.Clamp(width * 0.026, 14, 22));
    const statusSize = Math.round(Phaser.Math.Clamp(width * 0.024, 13, 20));
    const attackSize = Math.round(Phaser.Math.Clamp(width * 0.05, 24, 44));

    // HP bar spans most of the width on phones, capped on desktop
    this.hpBarWidth = Math.min(width * 0.85, 500);
    const barHeight = Math.round(Phaser.Math.Clamp(height * 0.045, 24, 36));

    this.bossNameText.setFontSize(titleSize).setPosition(cx, height * 0.16);

    this.hpBarBg
      .setPosition(cx, height * 0.3)
      .setSize(this.hpBarWidth, barHeight);
    this.hpBarFill
      .setPosition(cx - this.hpBarWidth / 2, height * 0.3)
      .setSize(this.hpBarWidth * (this.bossHp / this.bossMaxHp), barHeight);
    this.hpText.setFontSize(hpSize).setPosition(cx, height * 0.3);

    this.statusText.setFontSize(statusSize).setPosition(cx, height * 0.4);

    // Big thumb-friendly attack button in the lower half (mobile-first)
    this.attackButton
      .setFontSize(attackSize)
      .setPadding({
        x: Math.round(attackSize * 1.2),
        y: Math.round(attackSize * 0.6),
      } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.68);
  }

  // Fetch current fight state for this room (on load + every poll tick)
  async loadFightState() {
    if (!this.roomId) return;
    try {
      const response = await fetch(`/api/fight/${this.roomId}`);
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as FightStateResponse;
      this.applyHp(data.bossHp, data.bossMaxHp);
    } catch (error) {
      console.error('Failed to load fight state:', error);
    }
  }

  // One attack tap: cooldown check -> feedback -> tell server -> update HP
  async onAttackTap() {
    if (this.defeated || !this.roomId) return;

    const now = Date.now();
    if (now - this.lastTapAt < TAP_COOLDOWN_MS) {
      this.statusText.setText('Cooling down...');
      return;
    }
    this.lastTapAt = now;
    this.statusText.setText('');

    // Hit feedback: camera shake + button pop
    this.camera.shake(80, 0.004);
    this.tweens.add({
      targets: this.attackButton,
      scale: { from: 1.1, to: 1 },
      duration: 120,
    });

    try {
      const response = await fetch(`/api/fight/${this.roomId}/tap`, { method: 'POST' });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as FightStateResponse;
      this.applyHp(data.bossHp, data.bossMaxHp);
    } catch (error) {
      console.error('Failed to attack:', error);
    }
  }

  // Update HP state + animate the bar; handles the victory transition once
  applyHp(hp: number, maxHp: number) {
    this.bossHp = hp;
    this.bossMaxHp = maxHp;
    this.hpText.setText(`${hp} / ${maxHp}`);

    // Animate fill width relative to the CURRENT bar width (responsive-safe)
    const targetWidth = Math.max((hp / maxHp) * this.hpBarWidth, 0);
    this.tweens.add({
      targets: this.hpBarFill,
      width: targetWidth,
      duration: 200,
      ease: 'Cubic.easeOut',
    });

    if (hp <= 0 && !this.defeated) {
      this.defeated = true;
      this.bossNameText.setText('💀 Raptor Defeated!');
      this.attackButton.setText('🏆 VICTORY');
      this.statusText.setText('The pack has triumphed!');
      this.camera.shake(300, 0.01);
    }
  }
}