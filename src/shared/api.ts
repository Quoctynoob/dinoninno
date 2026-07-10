// ---- Room / Lobby types ----

export type Role = 'attacker' | 'defender' | 'supporter';

export type RoomStatus = 'open' | 'started' | 'ended';

export type PlayerInRoom = {
  username: string;
  role: Role;
  ready: boolean;
};

export type LobbyStateResponse = {
  type: 'lobby-state';
  roomId: string;
  status: RoomStatus;
  players: PlayerInRoom[];
  capacity: number;
  joined: boolean;
  myRole: Role | null;
};

export type FightStateResponse = {
  type: 'fight-state';
  roomId: string;
  status: RoomStatus;
  bossId: string;
  bossName: string;
  bossEmoji: string;
  bossHp: number;
  bossMaxHp: number;
  partyHp: number;
  partyMaxHp: number;
  shield: number;
  result: 'win' | 'loss' | null;
};

export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
};

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
};

// ---- Boss selection ----

export type BossListItem = {
  id: string;
  name: string;
  emoji: string;
  maxHp: number;
  waiting: number; // players currently in this boss's open room
};

export type BossListResponse = {
  type: 'boss-list';
  bosses: BossListItem[];
};