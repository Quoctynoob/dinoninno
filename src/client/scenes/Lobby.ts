import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { LobbyStateResponse, Role } from '../../shared/api';

const POLL_MS = 1000;


// Lobby: join the current room, pick a role, ready up.
// When the server reports status 'started', we hand off to the Game scene.
export class Lobby extends Scene {
  roomId: string = '';
  joined: boolean = false;
  myRole: Role | null = null;
  bossId: string = 'raptor';


  titleText: Phaser.GameObjects.Text;
  playersText: Phaser.GameObjects.Text;
  roleButtons: Phaser.GameObjects.Text[] = [];
  readyButton: Phaser.GameObjects.Text;
  pollTimer: Phaser.Time.TimerEvent;

  // Receives { bossId } from BossSelect
  init(data: { bossId?: string }) {
    this.bossId = data.bossId ?? 'raptor';
  }

  constructor() {
    super('Lobby');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x16213e);

    // ---- Create all UI at 0,0 — updateLayout() positions everything ----

    this.titleText = this.add
      .text(0, 0, '🦖 Join the Hunt', {
        fontFamily: 'Arial Black', color: '#ffffff',
        stroke: '#000000', strokeThickness: 8,
      })
      .setOrigin(0.5);

    this.playersText = this.add
      .text(0, 0, 'Loading room...', {
        fontFamily: 'Arial', color: '#dddddd', align: 'center',
      })
      .setOrigin(0.5);

    // Role picker buttons
    const roles: { role: Role; label: string; color: string }[] = [
      { role: 'attacker', label: '⚔️ Attacker', color: '#e63946' },
      { role: 'defender', label: '🛡️ Defender', color: '#457b9d' },
      { role: 'supporter', label: '💚 Supporter', color: '#2a9d8f' },
    ];

    roles.forEach((r) => {
      const btn = this.add
        .text(0, 0, r.label, {
          fontFamily: 'Arial Black', color: '#ffffff',
          backgroundColor: r.color,
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => void this.joinWithRole(r.role));
      this.roleButtons.push(btn);
    });

    this.readyButton = this.add
      .text(0, 0, '✅ READY', {
        fontFamily: 'Arial Black', color: '#ffd700',
        backgroundColor: '#333333',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => void this.readyUp());

    // ---- Poll lobby state so we see others join/ready in near-realtime ----
    void this.refreshLobby();
    this.pollTimer = this.time.addEvent({
      delay: POLL_MS, loop: true,
      callback: () => void this.refreshLobby(),
    });

    // ---- Responsive layout: run now + on every resize ----
    this.updateLayout(this.scale.width, this.scale.height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
  }

  // Position + size everything based on actual screen dimensions
  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);

    const isNarrow = width < 600; // phone-ish portrait
    const cx = width / 2;

    // Font sizes scale with screen width, clamped to sane ranges
    const titleSize = Math.round(Phaser.Math.Clamp(width * 0.055, 24, 48));
    const bodySize = Math.round(Phaser.Math.Clamp(width * 0.03, 14, 24));
    const buttonSize = Math.round(Phaser.Math.Clamp(width * 0.032, 15, 26));
    const readySize = Math.round(Phaser.Math.Clamp(width * 0.042, 20, 36));

    this.titleText.setFontSize(titleSize).setPosition(cx, height * 0.1);
    this.playersText.setFontSize(bodySize).setPosition(cx, height * 0.28);

    const btnPad = {
      x: Math.round(buttonSize * 0.8),
      y: Math.round(buttonSize * 0.5),
    } as Phaser.Types.GameObjects.Text.TextPadding;

    if (isNarrow) {
      // Phone: stack role buttons vertically
      this.roleButtons.forEach((btn, i) => {
        btn.setFontSize(buttonSize).setPadding(btnPad);
        btn.setPosition(cx, height * (0.45 + i * 0.11));
      });
      this.readyButton
        .setFontSize(readySize)
        .setPadding(btnPad)
        .setPosition(cx, height * 0.87);
    } else {
      // Desktop/tablet: role buttons in a row
      const spacing = Math.min(width * 0.26, 270);
      this.roleButtons.forEach((btn, i) => {
        btn.setFontSize(buttonSize).setPadding(btnPad);
        btn.setPosition(cx + (i - 1) * spacing, height * 0.55);
      });
      this.readyButton
        .setFontSize(readySize)
        .setPadding(btnPad)
        .setPosition(cx, height * 0.78);
    }
  }

  // Pull latest lobby state; if the fight started, switch scenes
  async refreshLobby() {
    try {
      const res = await fetch('/api/lobby?bossId=raptor'); //change later
      const data = (await res.json()) as LobbyStateResponse;

      if (data.status === 'started' && data.joined) {
        this.pollTimer.remove();
        this.scene.start('Game', { roomId: data.roomId });
        return;
      }

      this.roomId = data.roomId;
      this.joined = data.joined;

      const lines = data.players.map(
        (p) => `${p.ready ? '✅' : '⏳'} ${p.username} — ${p.role}`
      );
      const slotsLeft = data.capacity - data.players.length;
      for (let i = 0; i < slotsLeft; i++) lines.push('▫️ (empty slot)');
      this.playersText.setText(lines.join('\n'));
    } catch (e) {
      console.error('Lobby poll failed:', e);
    }
  }

  // Join (or switch role)
  async joinWithRole(role: Role) {
    try {
      const res = await fetch('/api/lobby/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, bossId: 'raptor' }), //change later

      });
      const data = (await res.json()) as LobbyStateResponse;
      this.myRole = role;
      this.joined = data.joined;
      void this.refreshLobby();
      
    } catch (e) {
      console.error('Join failed:', e);
    }
  }

  // Mark self ready; server starts the fight when all players are ready
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
}