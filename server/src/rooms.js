import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { v4 as uuidv4 } from "uuid";
import { CLASSES } from "./game/constants.js";
import { findSpawn } from "./game/spawn.js";
import { computeVisible } from "./game/vision.js";
import { resolveTurn } from "./game/resolver.js";
import { saveRoom, deleteRoom, loadRoomByCode, upsertPlayerIdentity } from "./db.js";

const PERK_TYPES = ["OMNISCIENCE", "STAMINA_REFILL", "EXTENDED_VISION", "FREE_SPRINT"];
const PERK_COOLDOWN = 5;

function emptyPerks() {
  return { omniscience: 0, extendedVision: 0, freeSprint: false };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Map loading ───────────────────────────────────────────────────────────────

const MAP_FILES = {
  open26: "manhunt_map_open_26.json",
  test26: "manhunt_map_test_26.json",
};

function loadMap(mapKey) {
  const filename = MAP_FILES[mapKey];
  if (!filename) throw new Error(`Unknown map key: ${mapKey}`);
  const mapPath = join(__dirname, "../maps", filename);
  return JSON.parse(readFileSync(mapPath, "utf8"));
}

// ── Room store ────────────────────────────────────────────────────────────────

const rooms = new Map();

export function getAllRooms() { return rooms.values(); }

export function registerRoom(room) { rooms.set(room.code, room); }

function persist(room) {
  saveRoom(room).catch((err) => console.error("[db] persist failed:", err.message));
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

// Strip internal socket IDs before sending to clients.
export function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    mapKey: room.mapKey,
    turnLimit: room.turnLimit,
    headStart: room.headStart,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      classKey: p.classKey,
      token: p.token,
      isHost: p.isHost,
      isBot: !!p.isBot,
      connected: p.isBot ? true : !!p.socketId,
    })),
  };
}

// ── Lobby operations (unchanged from Phase 1) ─────────────────────────────────

export function createRoom(socketId, name, playerToken) {
  const code = generateCode();
  const playerId = playerToken || uuidv4();

  const room = {
    code,
    status: "lobby",
    mapKey: "test26",
    turnLimit: 20,
    headStart: 3,
    players: [
      {
        id: playerId,
        socketId,
        name: name || "Player",
        role: null,
        classKey: "STANDARD",
        token: (name?.[0] ?? "P").toUpperCase(),
        isHost: true,
      },
    ],
    gameState: null,
    pendingPaths: new Map(),
    lastTurnResult: null,
    turnTimerRef: null,
    deleteTimerRef: null,
  };

  rooms.set(code, room);
  upsertPlayerIdentity(playerId, name || "Player").catch(() => {});
  persist(room);
  return { room, player: room.players[0] };
}

export async function joinRoom(code, socketId, name, playerToken) {
  const upperCode = code?.toUpperCase();
  let room = rooms.get(upperCode);

  // If not in memory, try loading from DB (player returning after server restart).
  if (!room) {
    room = await loadRoomByCode(upperCode);
    if (room) rooms.set(room.code, room);
  }

  if (!room) return { error: "Room not found" };
  if (room.status === "playing" && !room.players.find((p) => p.id === playerToken)) {
    return { error: "Game already in progress" };
  }
  if (room.players.length >= 6 && !room.players.find((p) => p.id === playerToken)) {
    return { error: "Room is full (max 6)" };
  }

  if (room.deleteTimerRef) {
    clearTimeout(room.deleteTimerRef);
    room.deleteTimerRef = null;
  }

  // Reconnect: same token already in room
  const existing = playerToken
    ? room.players.find((p) => p.id === playerToken)
    : null;
  if (existing) {
    existing.socketId = socketId;
    persist(room);
    return { room, player: existing, reconnected: true };
  }

  const player = {
    id: playerToken || uuidv4(),
    socketId,
    name: name || "Player",
    role: null,
    classKey: "STANDARD",
    token: (name?.[0] ?? "P").toUpperCase(),
    isHost: false,
  };

  room.players.push(player);
  upsertPlayerIdentity(player.id, player.name).catch(() => {});
  persist(room);
  return { room, player, reconnected: false };
}

export function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

export function removePlayer(socketId) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;

  const player = room.players.find((p) => p.socketId === socketId);
  if (player) player.socketId = null;

  // Always persist so reconnecting players find their game.
  persist(room);

  if (room.players.filter((p) => !p.isBot).every((p) => !p.socketId)) {
    // All humans gone — evict from memory after 2h but keep in DB.
    room.deleteTimerRef = setTimeout(() => {
      rooms.delete(room.code);
      console.log(`[room] ${room.code} evicted from memory (still in DB)`);
    }, 2 * 60 * 60 * 1000);
    return room;
  }

  if (!room.players.some((p) => p.isHost && p.socketId)) {
    const next = room.players.find((p) => p.socketId);
    if (next) {
      room.players.forEach((p) => (p.isHost = false));
      next.isHost = true;
    }
  }

  return room;
}

const PLAYER_FIELDS = ["name", "role", "classKey", "token"];
const ROOM_FIELDS = ["mapKey", "turnLimit", "headStart"];

export function updatePlayer(socketId, updates) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return null;
  for (const key of PLAYER_FIELDS) {
    if (updates[key] !== undefined) player[key] = updates[key];
  }
  persist(room);
  return room;
}

export function updateRoomSettings(socketId, updates) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  const player = room.players.find((p) => p.socketId === socketId);
  if (!player?.isHost) return null;
  for (const key of ROOM_FIELDS) {
    if (updates[key] !== undefined) room[key] = updates[key];
  }
  persist(room);
  return room;
}

// ── Game initialisation ───────────────────────────────────────────────────────

export function initGame(room) {
  const mapData = loadMap(room.mapKey);

  const hunterSetup = room.players.find((p) => p.role === "HUNTER");
  const runnerSetups = room.players.filter((p) => p.role === "RUNNER");

  if (!hunterSetup) throw new Error("No hunter assigned");
  if (!runnerSetups.length) throw new Error("No runners assigned");

  const startX = mapData.start?.hunter?.x ?? 13;
  const startY = mapData.start?.hunter?.y ?? 13;
  const spawnRadius = mapData.start?.runners_spawn_radius ?? 3;
  const startPos = { x: startX, y: startY };

  const hunterClass = CLASSES[hunterSetup.classKey] ?? CLASSES.STANDARD;

  const gamePlayers = [
    {
      id: hunterSetup.id,
      name: hunterSetup.name,
      token: hunterSetup.token,
      role: "HUNTER",
      classKey: hunterSetup.classKey,
      x: startX,
      y: startY,
      facing: 0,
      stamina: hunterClass.staminaMax,
      path: [],
      ready: false,
      activePerks: emptyPerks(),
    },
  ];

  for (const runner of runnerSetups) {
    const info = CLASSES[runner.classKey] ?? CLASSES.STANDARD;
    const spawn = findSpawn(gamePlayers, mapData, startPos, spawnRadius);
    // Bot runners face toward the hunter so they see the threat immediately.
    // Human runners keep facing 180 (away) — they control direction manually.
    const facing = runner.isBot
      ? Math.atan2(startY - spawn.y, startX - spawn.x) * 180 / Math.PI
      : 180;
    gamePlayers.push({
      id: runner.id,
      name: runner.name,
      token: runner.token,
      role: "RUNNER",
      classKey: runner.classKey,
      x: spawn.x,
      y: spawn.y,
      facing,
      stamina: info.staminaMax,
      path: [],
      ready: false,
      activePerks: emptyPerks(),
    });
    // Seed bot memory with the hunter's starting position so the bot keeps
    // fleeing even after it moves away and can no longer see the hunter.
    if (runner.isBot) {
      if (!runner.botMemory) runner.botMemory = {};
      runner.botMemory[hunterSetup.id] = { x: startX, y: startY };
    }
  }

  // Assign perk types randomly — one of each, shuffled across box positions.
  const shuffledTypes = [...PERK_TYPES].sort(() => Math.random() - 0.5);
  const perkBoxes = (mapData.perkBoxes ?? []).map((pos, i) => ({
    x: pos.x,
    y: pos.y,
    type: shuffledTypes[i] ?? "STAMINA_REFILL",
    cooldownTurnsLeft: 0,
  }));

  room.gameState = {
    players: gamePlayers,
    map: mapData,
    turn: 1,
    headStartTurnsLeft: room.headStart,
    gameOver: null,
    perkBoxes,
    lastTurnAt: new Date().toISOString(),
  };
  room.pendingPaths = new Map();
  room.lastTurnResult = null;
  room.status = "playing";

  persist(room);
  return mapData;
}

// ── Per-player visibility filtering ──────────────────────────────────────────

export function filteredState(room, playerId) {
  const gs = room.gameState;
  if (!gs) return null;

  const player = gs.players.find((p) => p.id === playerId);
  if (!player) return null;

  const perks = player.activePerks ?? emptyPerks();
  const isOmniscient = perks.omniscience > 0;
  const visionBonus = perks.extendedVision > 0 ? 5 : 0;
  const visionOpts = { omniscience: isOmniscient, rangeBonus: visionBonus };

  const visible = computeVisible(player.x, player.y, player.facing, gs.map, visionOpts);

  return {
    yourPlayer: {
      id: player.id,
      name: player.name,
      token: player.token,
      role: player.role,
      classKey: player.classKey,
      x: player.x,
      y: player.y,
      facing: player.facing,
      stamina: player.stamina,
      activePerks: perks,
    },
    visiblePlayers: gs.players
      .filter((p) => p.id !== playerId && visible.has(`${p.x},${p.y}`))
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        token: p.token,
        x: p.x,
        y: p.y,
        facing: p.facing,
      })),
    turn: gs.turn,
    turnLimit: room.turnLimit,
    headStartTurnsLeft: gs.headStartTurnsLeft,
    gameOver: gs.gameOver,
    mapKey: room.mapKey,
    playerCounts: {
      hunters: gs.players.filter((p) => p.role === "HUNTER").length,
      runners: gs.players.filter((p) => p.role === "RUNNER").length,
    },
    // Box positions only — type and cooldown are hidden from clients.
    perkBoxes: (gs.perkBoxes ?? []).map((b) => ({ x: b.x, y: b.y })),
    lastTurnAt: gs.lastTurnAt ?? null,
  };
}

// Filter tick snapshots so each client only sees players visible to them
// at each step of the animation.
export function filteredTickSnaps(tickSnapshots, playerId, map) {
  return tickSnapshots.map((snap) => {
    const me = snap.find((p) => p.id === playerId);
    if (!me) return [];
    const visible = computeVisible(me.x, me.y, me.facing, map);
    return snap.filter(
      (p) => p.id === playerId || visible.has(`${p.x},${p.y}`)
    );
  });
}

// ── Perk application ─────────────────────────────────────────────────────────

function applyPerk(player, type, classInfo) {
  if (!player.activePerks) player.activePerks = emptyPerks();
  switch (type) {
    case "OMNISCIENCE":     player.activePerks.omniscience = 1; break;
    case "EXTENDED_VISION": player.activePerks.extendedVision = 3; break;
    case "FREE_SPRINT":     player.activePerks.freeSprint = true; break;
    case "STAMINA_REFILL":  player.stamina = classInfo.staminaMax; break;
  }
}

// ── Turn resolution ───────────────────────────────────────────────────────────

// Called once all paths are collected. Resolves the turn, updates room state,
// and returns data needed to broadcast results.
export function resolveTurnInRoom(room) {
  const gs = room.gameState;

  const playersWithPaths = gs.players.map((p) => ({
    ...p,
    path: room.pendingPaths.get(p.id) ?? [],
    ready: true,
  }));

  const { players: resolved, tickSnapshots, catches } = resolveTurn(
    playersWithPaths,
    gs.map,
    gs.headStartTurnsLeft
  );

  const newHeadStart = Math.max(0, gs.headStartTurnsLeft - 1);
  const newTurn = gs.turn + 1;

  const allCaught = resolved.every((p) => p.role === "HUNTER");
  const runnersWin =
    newTurn > room.turnLimit && resolved.some((p) => p.role === "RUNNER");
  const gameOver = allCaught
    ? { winner: "HUNTER", turn: newTurn - 1 }
    : runnersWin
    ? { winner: "RUNNER", turn: room.turnLimit }
    : null;

  // Tick down active perk counters and consume freeSprint (used in this turn's resolution).
  for (const p of resolved) {
    if (!p.activePerks) { p.activePerks = emptyPerks(); continue; }
    if (p.activePerks.omniscience > 0) p.activePerks.omniscience--;
    if (p.activePerks.extendedVision > 0) p.activePerks.extendedVision--;
    p.activePerks.freeSprint = false; // freeSprint lasts exactly one turn
  }

  // Tick down box cooldowns.
  for (const box of gs.perkBoxes ?? []) {
    if (box.cooldownTurnsLeft > 0) box.cooldownTurnsLeft--;
  }

  // Check if any player finished their turn on an active perk box.
  const perkNotices = [];
  for (const box of gs.perkBoxes ?? []) {
    if (box.cooldownTurnsLeft > 0) continue;
    for (const p of resolved) {
      if (p.x !== box.x || p.y !== box.y) continue;
      applyPerk(p, box.type, CLASSES[p.classKey] ?? CLASSES.STANDARD);
      box.cooldownTurnsLeft = PERK_COOLDOWN;
      perkNotices.push({ playerId: p.id, playerName: p.name, perk: box.type });
      break; // one player per box per turn
    }
  }

  room.gameState = {
    players: resolved,
    map: gs.map,
    turn: newTurn,
    headStartTurnsLeft: newHeadStart,
    gameOver,
    perkBoxes: gs.perkBoxes ?? [],
    lastTurnAt: new Date().toISOString(),
  };
  room.pendingPaths = new Map();
  room.lastTurnResult = { tickSnapshots, catches, perkNotices, resolvedTurn: gs.turn };

  if (gameOver) room.status = "done";

  // Wipe converted runner bots' memory so they start fresh as hunters.
  for (const c of catches) {
    const rp = room.players.find((p) => p.id === c.id && p.isBot);
    if (rp) rp.botMemory = {};
  }

  persist(room);
  return { tickSnapshots, gameOver, catches, perkNotices };
}

// ── Bot management ────────────────────────────────────────────────────────────

let _botSeq = 0;

export function addBotToRoom(code, hostSocketId, role) {
  const room = rooms.get(code?.toUpperCase());
  if (!room) return { error: "Room not found" };
  if (room.status !== "lobby") return { error: "Game already started" };
  const host = room.players.find((p) => p.socketId === hostSocketId);
  if (!host?.isHost) return { error: "Not host" };
  if (room.players.length >= 6) return { error: "Room is full (max 6)" };
  if (!["HUNTER", "RUNNER"].includes(role)) return { error: "Invalid role" };

  const label = role === "HUNTER" ? "Hunter" : "Runner";
  const player = {
    id: uuidv4(),
    socketId: null,
    name: `${label} Bot ${++_botSeq}`,
    role,
    classKey: "STANDARD",
    token: role === "HUNTER" ? "H" : "R",
    isBot: true,
    isHost: false,
    botMemory: {},
  };
  room.players.push(player);
  persist(room);
  return { room };
}

export function removeBotFromRoom(code, hostSocketId, botId) {
  const room = rooms.get(code?.toUpperCase());
  if (!room || room.status !== "lobby") return null;
  const host = room.players.find((p) => p.socketId === hostSocketId);
  if (!host?.isHost) return null;
  const idx = room.players.findIndex((p) => p.id === botId && p.isBot);
  if (idx === -1) return null;
  room.players.splice(idx, 1);
  persist(room);
  return room;
}

// ── Reconnect state ───────────────────────────────────────────────────────────

export function reconnectState(room, playerId) {
  if (room.status === "lobby") {
    return { type: "lobby", room: publicRoom(room), yourId: playerId };
  }

  const state = filteredState(room, playerId);
  if (!state) return null;

  const gs = room.gameState;
  const eligibleIds = gs.players
    .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
    .map((p) => p.id);

  const submitted = room.pendingPaths.has(playerId);

  // Only send catch-up animation if the player hasn't submitted yet this turn
  // (meaning they were away when the last turn resolved).
  const lastTurnResult = !submitted ? (room.lastTurnResult ?? null) : null;

  return {
    type: "game",
    state,
    submitted,
    readyCount: room.pendingPaths.size,
    totalCount: eligibleIds.length,
    lastTurnResult,
  };
}
