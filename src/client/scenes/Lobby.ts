import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { LobbyStateResponse, Role, MeResponse } from '../../shared/api';

const POLL_MS = 1000;

const ROLE_INFO: { role: Role; label: string; color: number; colorHover: number }[] = [
  { role: 'attacker',  label: 'Attacker',  color: 0xe63946, colorHover: 0xf25c69 },
  { role: 'defender',  label: 'Defender',  color: 0x457b9d, colorHover: 0x5b93b8 },
  { role: 'supporter', label: 'Supporter', color: 0x2a9d8f, colorHover: 0x3cb5a6 },
];

// Lobby: waiting room for one boss. Top bar (back / boss chip / energy+rewards),
// three stands where joined players' dinos appear, role picker + ready below.
export class Lobby extends Scene {
  roomId: string = '';
  joined: boolean = false;
  myRole: Role | null = null;
  bossId: string = 'raptor';
  bossName: string = '';

  // ---- Top bar ----
  backButton: Phaser.GameObjects.Text;
  confirmingLeave: boolean = false;
  bossChipBg: Phaser.GameObjects.Rectangle;
  bossChipIcon: Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
  bossChipName: Phaser.GameObjects.Text;
  energyText: Phaser.GameObjects.Text;
  rewardsText: Phaser.GameObjects.Text;
  me: MeResponse | null = null;

  // ---- Stands + dinos ----
  stands: Phaser.GameObjects.Ellipse[] = [];
  standDinos: (Phaser.GameObjects.Sprite | null)[] = [null, null, null];
  standNames: Phaser.GameObjects.Text[] = [];
  standStatus: Phaser.GameObjects.Text[] = [];

  // ---- Role picker + ready ----
  roleButtons: { bg: Phaser.GameObjects.Rectangle; dino: Phaser.GameObjects.Sprite; label: Phaser.GameObjects.Text }[] = [];
  readyButton: Phaser.GameObjects.Text;

  pollTimer: Phaser.Time.TimerEvent;

  constructor() {
    super('Lobby');
  }

  init(data: { bossId?: string }) {
    this.bossId = data.bossId ?? 'raptor';
  }

  create() {
    this.cameras.main.setBackgroundColor(0x16213e);
    // Reset all per-scene state (Phaser reuses scene instances)
    this.roomId = '';
    this.joined = false;
    this.myRole = null;
    this.confirmingLeave = false;
    this.stands = [];
    this.standDinos = [null, null, null];
    this.standNames = [];
    this.standStatus = [];
    this.roleButtons = [];
    this.me = null;

    // ================= TOP BAR =================

    this.backButton = this.add
      .text(0, 0, '←', {
        fontFamily: 'Arial Black', color: '#ffffff', backgroundColor: '#553333',
      })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => void this.onBackPressed());

    // Boss chip: rectangle with boss icon on the left, name to its right
    const chipKey = `boss_${this.bossId}`;
    if (this.textures.exists(chipKey)) {
      this.bossChipIcon = this.add.image(0, 0, chipKey).setOrigin(0.5);
    } else {
      this.bossChipIcon = this.add.rectangle(0, 0, 24, 24, 0x6a3d7b).setOrigin(0.5);
    }

    this.bossChipBg = this.add.rectangle(0, 0, 10, 10, 0x1e2a45).setStrokeStyle(2, 0x3a4a6b).setOrigin(0, 0.5);
    this.bossChipName = this.add
      .text(0, 0, '...', { fontFamily: 'Arial Black', color: '#ffffff' })
      .setOrigin(0, 0.5);

    // Energy + rewards (right side of the bar)
    this.energyText = this.add
      .text(0, 0, '⚡ -/-', { fontFamily: 'Arial Black', color: '#ffd94a', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(1, 0.5);
    this.rewardsText = this.add
      .text(0, 0, ' -/-', { fontFamily: 'Arial Black', color: '#ff9ecb', stroke: '#000000', strokeThickness: 3 })
      .setOrigin(1, 0.5);

    // ================= STANDS =================
    for (let i = 0; i < 3; i++) {
      const stand = this.add.ellipse(0, 0, 100, 30, 0x0d1526).setStrokeStyle(3, 0x3a4a6b);
      this.stands.push(stand);

      const name = this.add
        .text(0, 0, '', { fontFamily: 'Arial', color: '#ffffff', stroke: '#000000', strokeThickness: 3 })
        .setOrigin(0.5);
      this.standNames.push(name);

      const status = this.add
        .text(0, 0, 'Waiting...', { fontFamily: 'Arial', color: '#667799' })
        .setOrigin(0.5);
      this.standStatus.push(status);
    }

    // ================= ROLE PICKER =================
    ROLE_INFO.forEach((info) => {
      const bg = this.add
        .rectangle(0, 0, 10, 10, info.color)
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerover', () => bg.setFillStyle(info.colorHover))
        .on('pointerout', () => this.refreshRoleHighlights())
        .on('pointerdown', () => void this.joinWithRole(info.role));

      const dino = this.add.sprite(0, 0, `dino_${info.role}`).play(`dino_${info.role}_idle`);
      const label = this.add
        .text(0, 0, info.label, {
          fontFamily: 'Arial Black', color: '#ffffff', stroke: '#000000', strokeThickness: 3,
        })
        .setOrigin(0.5);

      this.roleButtons.push({ bg, dino, label });
    });

    this.readyButton = this.add
      .text(0, 0, 'READY', {
        fontFamily: 'Arial Black', color: '#ffd700', backgroundColor: '#333333',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => void this.readyUp());

    // ================= DATA =================
    void this.loadMe();
    void this.refreshLobby();
    // Fetch boss name for the chip (one-time)
    void fetch('/api/bosses')
      .then((r) => r.json())
      .then((d: { bosses: { id: string; name: string }[] }) => {
        const b = d.bosses.find((x) => x.id === this.bossId);
        this.bossChipName.setText(b?.name ?? this.bossId);
        this.updateLayout(this.scale.width, this.scale.height); // chip width depends on name
      });
      
    this.pollTimer = this.time.addEvent({
      delay: POLL_MS, loop: true,
      callback: () => void this.refreshLobby(),
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
      this.energyText.setText(`⚡ ${this.me.energy}/${this.me.energyMax}`);
      this.rewardsText.setText(` ${this.me.rewardCap - this.me.rewardsToday}/${this.me.rewardCap}`);
    } catch (e) {
      console.error('Failed to load player:', e);
    }
  }

  // Highlight my chosen role's button; dim the rest
  refreshRoleHighlights() {
    this.roleButtons.forEach((btn, i) => {
      const info = ROLE_INFO[i]!;
      btn.bg.setFillStyle(info.color);
      btn.bg.setStrokeStyle(this.myRole === info.role ? 4 : 0, 0xffd700);
      btn.bg.setAlpha(this.myRole && this.myRole !== info.role ? 0.55 : 1);
      btn.dino.setAlpha(this.myRole && this.myRole !== info.role ? 0.55 : 1);
    });
  }

  async refreshLobby() {
    try {
      const res = await fetch(`/api/lobby?bossId=${this.bossId}`);
      const data = (await res.json()) as LobbyStateResponse;

      if (data.status === 'started' && data.joined) {
        this.pollTimer.remove();
        this.scene.start('Game', { roomId: data.roomId, role: data.myRole ?? this.myRole ?? 'attacker', bossId: this.bossId });
        return;
      }

      this.roomId = data.roomId;
      this.joined = data.joined;
      if (data.myRole) {
        this.myRole = data.myRole;
        this.refreshRoleHighlights();
      }

      // ---- Populate the stands ----
      for (let i = 0; i < 3; i++) {
        const p = data.players[i];
        const existing = this.standDinos[i];

        if (p) {
          const key = `dino_${p.role}`;
          // (Re)create the dino if the slot is empty or the role changed
          if (!existing || existing.texture.key !== key) {
            existing?.destroy();
            const stand = this.stands[i]!;
            const dino = this.add.sprite(stand.x, stand.y - 8, key).play(`${key}_idle`);
            dino.setScale(this.currentDinoScale());
            dino.setOrigin(0.5, 1);
            this.standDinos[i] = dino;
          }
          this.standNames[i]!.setText(p.username);
          this.standStatus[i]!.setText(p.ready ? 'Ready!' : 'Not ready').setColor(p.ready ? '#7dff9b' : '#ffd94a');
        } else {
          existing?.destroy();
          this.standDinos[i] = null;
          this.standNames[i]!.setText('');
          this.standStatus[i]!.setText('Waiting...').setColor('#667799');
        }
      }
    } catch (e) {
      console.error('Lobby poll failed:', e);
    }
  }

  currentDinoScale(): number {
    return Math.max(Math.round((this.scale.height * 0.09) / 24), 2);
  }

  async joinWithRole(role: Role) {
    try {
      const res = await fetch('/api/lobby/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, bossId: this.bossId }),
      });
      const data = (await res.json()) as LobbyStateResponse;
      this.myRole = role;
      this.joined = data.joined;
      this.refreshRoleHighlights();
      void this.refreshLobby();
    } catch (e) {
      console.error('Join failed:', e);
    }
  }

  async readyUp() {
    if (!this.joined || !this.roomId) return;
    try {
      await fetch('/api/lobby/ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: this.roomId }),
      });
      void this.refreshLobby();
    } catch (e) {
      console.error('Ready failed:', e);
    }
  }

  async onBackPressed() {
    if (!this.confirmingLeave) {
      this.confirmingLeave = true;
      this.backButton.setText('⚠️').setStyle({ backgroundColor: '#884444' });
      this.time.delayedCall(3000, () => {
        this.confirmingLeave = false;
        this.backButton.setText('←').setStyle({ backgroundColor: '#553333' });
      });
      return;
    }
    try {
      if (this.joined && this.roomId) {
        await fetch('/api/lobby/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomId: this.roomId }),
        });
      }
    } catch (e) {
      console.error('Leave failed:', e);
    }
    this.pollTimer.remove();
    this.scene.start('BossSelect');
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    const cx = width / 2;
    const isNarrow = width < 600;

    // ---- Top bar ----
    const barY = height * 0.07;
    const backSize = Math.round(Phaser.Math.Clamp(width * 0.03, 16, 24));
    this.backButton
      .setFontSize(backSize)
      .setPadding({ x: 12, y: 8 } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(width * 0.03, barY);

    // Boss chip: sits after the back button
    const chipH = Math.round(Phaser.Math.Clamp(height * 0.07, 34, 48));
    const chipNameSize = Math.round(Phaser.Math.Clamp(width * 0.024, 13, 19));
    const chipX = width * 0.03 + backSize + 28;
    const iconSize = chipH * 0.72;
    this.bossChipName.setFontSize(chipNameSize);
    const chipW = iconSize + this.bossChipName.width + 26;
    this.bossChipBg.setPosition(chipX, barY).setSize(chipW, chipH);
    this.bossChipIcon.setPosition(chipX + 8 + iconSize / 2, barY);
    // Scale icon to fit the chip (works for image or placeholder rect)
    if (this.bossChipIcon instanceof Phaser.GameObjects.Image) {
      this.bossChipIcon.setScale(iconSize / this.bossChipIcon.width);
    } else {
      this.bossChipIcon.setSize(iconSize, iconSize);
    }
    this.bossChipName.setPosition(chipX + iconSize + 16, barY);

    // Energy + rewards: right-aligned
    const resSize = Math.round(Phaser.Math.Clamp(width * 0.024, 13, 18));
    this.energyText.setFontSize(resSize).setPosition(width * 0.97, barY - (isNarrow ? resSize * 0.7 : 0));
    this.rewardsText
      .setFontSize(resSize)
      .setPosition(width * 0.97, isNarrow ? barY + resSize * 0.7 : barY + resSize * 1.4);
    if (!isNarrow) {
      // Desktop: stack them vertically at right edge
      this.energyText.setPosition(width * 0.97, barY - resSize * 0.75);
      this.rewardsText.setPosition(width * 0.97, barY + resSize * 0.75);
    }

    // ---- Stands: three across the middle ----
    const standY = height * (isNarrow ? 0.46 : 0.5);
    const standW = Math.min(width * 0.24, 150);
    const spacing = isNarrow ? width * 0.3 : Math.min(width * 0.26, 240);
    const nameSize = Math.round(Phaser.Math.Clamp(width * 0.022, 11, 16));
    const dinoScale = this.currentDinoScale();

    this.stands.forEach((stand, i) => {
      const x = cx + (i - 1) * spacing;
      stand.setPosition(x, standY).setSize(standW, standW * 0.3);
      this.standDinos[i]?.setPosition(x, standY - 4).setScale(dinoScale);
      this.standNames[i]!.setFontSize(nameSize).setPosition(x, standY - 26 * dinoScale * 0.9 - 14);
      this.standStatus[i]!.setFontSize(nameSize - 1).setPosition(x, standY + standW * 0.2 + 12);
    });

    // ---- Role picker: three buttons under the stands ----
    const roleY = height * (isNarrow ? 0.72 : 0.74);
    const roleBtnW = Math.min(width * 0.27, 170);
    const roleBtnH = Math.round(Phaser.Math.Clamp(height * 0.11, 56, 84));
    const roleSpacing = isNarrow ? width * 0.31 : Math.min(width * 0.29, 250);
    const roleLabelSize = Math.round(Phaser.Math.Clamp(width * 0.02, 11, 15));

    this.roleButtons.forEach((btn, i) => {
      const x = cx + (i - 1) * roleSpacing;
      btn.bg.setPosition(x, roleY).setSize(roleBtnW, roleBtnH);
      btn.dino.setPosition(x - roleBtnW * 0.28, roleY).setScale(Math.max(dinoScale - 1, 1.5));
      btn.label.setFontSize(roleLabelSize).setPosition(x + roleBtnW * 0.12, roleY);
    });

    // ---- Ready ----
    const readySize = Math.round(Phaser.Math.Clamp(width * 0.04, 20, 34));
    this.readyButton
      .setFontSize(readySize)
      .setPadding({ x: Math.round(readySize * 1.1), y: Math.round(readySize * 0.5) } as Phaser.Types.GameObjects.Text.TextPadding)
      .setPosition(cx, height * 0.9);
  }
}