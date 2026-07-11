import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { FightStateResponse, Role } from '../../shared/api';

const TAP_COOLDOWN_MS = 400;
const POLL_INTERVAL_MS = 500;

// Role -> button appearance
const ROLE_BUTTON: Record<Role, { label: string; bg: string; hover: string }> = {
  attacker:  { label: '⚔️ ATTACK', bg: '#7b2d26', hover: '#94382e' },
  defender:  { label: '🛡️ SHIELD', bg: '#2d4a7b', hover: '#385b94' },
  supporter: { label: '💚 HEAL',   bg: '#2d7b4a', hover: '#38945b' },
};

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

  // ---- UI ----
  bossNameText: Phaser.GameObjects.Text;
  bossHpBarBg: Phaser.GameObjects.Rectangle;
  bossHpBarFill: Phaser.GameObjects.Rectangle;
  bossHpText: Phaser.GameObjects.Text;

  partyLabel: Phaser.GameObjects.Text;
  partyHpBarBg: Phaser.GameObjects.Rectangle;
  partyHpBarFill: Phaser.GameObjects.Rectangle;
  partyHpText: Phaser.GameObjects.Text;
  shieldText: Phaser.GameObjects.Text;

  actionButton: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
  resultText: Phaser.GameObjects.Text;
  backButton: Phaser.GameObjects.Text;

  bossBarWidth: number = 500;
  partyBarWidth: number = 400;
  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('Game');
  }

  // Receives { roomId, role } from the Lobby
  init(data: { roomId: string; role?: Role }) {
    this.roomId = data.roomId;
    this.myRole = data.role ?? 'attacker';
    this.fightOver = false;
    this.lastTapAt = 0;
  }

  create() {
    this.camera = this.cameras.main;
    this.camera.setBackgroundColor(0x1a1a2e);

    // ---- Boss section (top) ----
    this.bossNameText = this.add
      .text(0, 0, 'Loading...', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.bossHpBarBg = this.add.rectangle(0, 0, 10, 10, 0x333333).setOrigin(0.5);
    this.bossHpBarFill = this.add.rectangle(0, 0, 10, 10, 0xe63946).setOrigin(0, 0.5);
    this.bossHpText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 4,
      })
      .setOrigin(0.5);

    // ---- Party section (middle) ----
    this.partyLabel = this.add
      .text(0, 0, '🏕️ PARTY', { fontFamily: 'Arial Black', color: '#9ad1ff' })
      .setOrigin(0.5);

    this.partyHpBarBg = this.add.rectangle(0, 0, 10, 10, 0x333333).setOrigin(0.5);
    this.partyHpBarFill = this.add.rectangle(0, 0, 10, 10, 0x4caf50).setOrigin(0, 0.5);
    this.partyHpText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 3,
      })
      .setOrigin(0.5);

    this.shieldText = this.add
      .text(0, 0, '', { fontFamily: 'Arial Black', color: '#7fb3ff' })
      .setOrigin(0.5);

    // ---- Status / result ----
    this.statusText = this.add
      .text(0, 0, '', { fontFamily: 'Arial', color: '#aaaaaa' })
      .setOrigin(0.5);

    this.resultText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black', color: '#ffd700',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setVisible(false);

    // ---- Action button (role-specific) ----
    const rb = ROLE_BUTTON[this.myRole];
    this.actionButton = this.add
      .text(0, 0, rb.label, {
        fontFamily: 'Arial Black', color: '#ffd700', backgroundColor: rb.bg,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.actionButton.setStyle({ backgroundColor: rb.hover }))
      .on('pointerout', () => this.actionButton.setStyle({ backgroundColor: rb.bg }))
      .on('pointerdown', () => void this.onActionTap());

    // ---- Back to hunt button (shown after fight ends) ----
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

    // Feedback differs slightly by role
    if (this.myRole === 'attacker') this.camera.shake(80, 0.004);
    this.tweens.add({
      targets: this.actionButton,
      scale: { from: 1.1, to: 1 },
      duration: 120,
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

  // Apply full fight state to the UI
  applyState(s: FightStateResponse) {
    this.bossHp = s.bossHp;
    this.bossMaxHp = s.bossMaxHp;
    this.partyHp = s.partyHp;
    this.partyMaxHp = s.partyMaxHp;
    this.shield = s.shield;

    this.bossNameText.setText(`${s.bossEmoji} ${s.bossName}`);
    this.bossHpText.setText(`${s.bossHp} / ${s.bossMaxHp}`);
    this.partyHpText.setText(`${s.partyHp} / ${s.partyMaxHp}`);
    this.shieldText.setText(s.shield > 0 ? `🛡️ ${s.shield}` : '');

    // Animate both bars
    this.tweens.add({
      targets: this.bossHpBarFill,
      width: Math.max((s.bossHp / s.bossMaxHp) * this.bossBarWidth, 0),
      duration: 200, ease: 'Cubic.easeOut',
    });
    this.tweens.add({
      targets: this.partyHpBarFill,
      width: Math.max((s.partyHp / s.partyMaxHp) * this.partyBarWidth, 0),
      duration: 200, ease: 'Cubic.easeOut',
    });

    // Party HP bar turns orange/red as it gets low
    const ratio = s.partyHp / s.partyMaxHp;
    this.partyHpBarFill.setFillStyle(ratio > 0.5 ? 0x4caf50 : ratio > 0.25 ? 0xff9800 : 0xf44336);

    // ---- End states ----
    if (s.result && !this.fightOver) {
      this.fightOver = true;
      this.actionButton.setVisible(false);
      this.backButton.setVisible(true);
      this.resultText.setVisible(true);

      if (s.result === 'win') {
        this.resultText.setText('🏆 VICTORY!').setColor('#ffd700');
        this.statusText.setText('The pack has triumphed!');
        this.camera.shake(300, 0.01);
      } else {
        this.resultText.setText('💀 DEFEAT').setColor('#ff6b6b');
        this.statusText.setText(`${s.bossName} was too strong... this time.`);
      }
    }

    if (s.result === 'win') {
      this.resultText.setText('🏆 VICTORY!').setColor('#ffd700');
      this.camera.shake(300, 0.01);
    } else {
      this.resultText.setText('💀 DEFEAT').setColor('#ff6b6b');
    }

    // Per-player contribution recap replaces the status line
    const lines = s.contributions.map((p) => {
      const parts = [`⚔️ ${p.damage}`];
      if (p.blocked > 0) parts.push(`🛡️ ${p.blocked}`);
      if (p.healed > 0) parts.push(`💚 ${p.healed}`);
      return `${p.username}: ${parts.join('  ')}`;
    });
    lines.push('');
    lines.push(s.result === 'win' ? '✨ XP earned! Check your profile at the hunt board.' : '✨ Some XP earned for the effort.');
    this.statusText.setText(lines.join('\n'));
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;

    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.05, 22, 42));
    const barTextSize = Math.round(Phaser.Math.Clamp(width * 0.024, 13, 20));
    const labelSize = Math.round(Phaser.Math.Clamp(width * 0.022, 12, 18));
    const actionSize = Math.round(Phaser.Math.Clamp(width * 0.05, 24, 44));
    const resultSize = Math.round(Phaser.Math.Clamp(width * 0.07, 32, 60));

    this.bossBarWidth = Math.min(width * 0.85, 500);
    this.partyBarWidth = Math.min(width * 0.7, 400);
    const bossBarH = Math.round(Phaser.Math.Clamp(height * 0.045, 22, 34));
    const partyBarH = Math.round(Phaser.Math.Clamp(height * 0.035, 16, 26));

    // Boss (top)
    this.bossNameText.setFontSize(titleSize).setPosition(cx, height * 0.11);
    this.bossHpBarBg.setPosition(cx, height * 0.21).setSize(this.bossBarWidth, bossBarH);
    this.bossHpBarFill
      .setPosition(cx - this.bossBarWidth / 2, height * 0.21)
      .setSize(this.bossBarWidth * (this.bossHp / this.bossMaxHp || 0), bossBarH);
    this.bossHpText.setFontSize(barTextSize).setPosition(cx, height * 0.21);

    // Party (middle)
    this.partyLabel.setFontSize(labelSize).setPosition(cx - this.partyBarWidth / 2 + 40, height * 0.31);
    this.shieldText.setFontSize(labelSize).setPosition(cx + this.partyBarWidth / 2 - 30, height * 0.31);
    this.partyHpBarBg.setPosition(cx, height * 0.37).setSize(this.partyBarWidth, partyBarH);
    this.partyHpBarFill
      .setPosition(cx - this.partyBarWidth / 2, height * 0.37)
      .setSize(this.partyBarWidth * (this.partyHp / this.partyMaxHp || 0), partyBarH);
    this.partyHpText.setFontSize(barTextSize - 2).setPosition(cx, height * 0.37);

    // Status / result
    this.statusText.setFontSize(labelSize).setPosition(cx, height * 0.46);
    this.resultText.setFontSize(resultSize).setPosition(cx, height * 0.52);

    // Buttons (bottom)
    this.actionButton
      .setFontSize(actionSize)
      .setPadding({ x: Math.round(actionSize * 1.2), y: Math.round(actionSize * 0.6) } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.68);
    this.backButton
      .setFontSize(Math.round(actionSize * 0.6))
      .setPadding({ x: 20, y: 12 } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.7);
  }
}