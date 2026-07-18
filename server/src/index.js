import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createRoom,
  joinRoom,
  getRoomBySocket,
  removePlayer,
  updatePlayer,
  updateRoomSettings,
  publicRoom,
  initGame,
  filteredState,
  filteredTickSnaps,
  resolveTurnInRoom,
  reconnectState,
  addBotToRoom,
  removeBotFromRoom,
  getAllRooms,
  registerRoom,
  listGamesForSocket,
} from "./rooms.js";
import { chooseBotPath } from "./bot.js";
import { initDb, loadAllRooms } from "./db.js";

const app = express();
const httpServer = createServer(app);

const rawOrigin = process.env.CLIENT_ORIGIN || "*";
const corsOrigin =
  rawOrigin === "*"
    ? "*"
    : rawOrigin.split(",").map((o) => o.trim());

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Turn timer ────────────────────────────────────────────────────────────────

const TURN_TIMEOUT_MS = 3 * 60 * 1000; // 3 min real-time timer (while players are online)

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnTimerRef = setTimeout(() => {
    console.log(`[timer] auto-submitting idle players in ${room.code}`);
    const gs = room.gameState;
    if (!gs) return;
    const eligibleIds = gs.players
      .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
      .map((p) => p.id);
    for (const id of eligibleIds) {
      if (!room.pendingPaths.has(id)) room.pendingPaths.set(id, []);
    }
    broadcastTurnResult(room);
  }, TURN_TIMEOUT_MS);
}

function clearTurnTimer(room) {
  if (room.turnTimerRef) {
    clearTimeout(room.turnTimerRef);
    room.turnTimerRef = null;
  }
}

// ── 24h async idle check ──────────────────────────────────────────────────────
// Runs every 5 minutes. If a turn has been waiting > 24h, auto-submits empty
// paths for anyone who hasn't moved and resolves the turn.

const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const room of getAllRooms()) {
    if (room.status !== "playing") continue;
    const gs = room.gameState;
    if (!gs || gs.gameOver) continue;

    const lastTurnAt = gs.lastTurnAt ? new Date(gs.lastTurnAt).getTime() : null;
    if (!lastTurnAt || now - lastTurnAt < IDLE_TIMEOUT_MS) continue;

    const eligibleIds = gs.players
      .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
      .map((p) => p.id);

    const missing = eligibleIds.filter((id) => !room.pendingPaths.has(id));
    if (!missing.length) continue; // all already submitted, turn resolution pending

    console.log(`[idle] 24h elapsed in ${room.code} — auto-submitting for ${missing.join(", ")}`);
    for (const id of missing) room.pendingPaths.set(id, []);

    clearTurnTimer(room);
    broadcastTurnResult(room);
  }
}, 5 * 60 * 1000);

// ── Bot path submission ───────────────────────────────────────────────────────

function submitBotPaths(room) {
  const gs = room.gameState;
  if (!gs || gs.gameOver) return;

  const bots = room.players.filter((p) => p.isBot);
  for (const bot of bots) {
    const gsPlayer = gs.players.find((p) => p.id === bot.id);
    if (!gsPlayer) continue;
    if (gsPlayer.role === "HUNTER" && gs.headStartTurnsLeft > 0) continue;
    if (room.pendingPaths.has(bot.id)) continue;
    try {
      room.pendingPaths.set(bot.id, chooseBotPath(room, bot.id));
    } catch (err) {
      console.error(`[bot] chooseBotPath threw for ${bot.id} (${gsPlayer.role}):`, err);
      room.pendingPaths.set(bot.id, []);
    }
  }

  const eligibleIds = gs.players
    .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
    .map((p) => p.id);
  const readyCount = eligibleIds.filter((id) => room.pendingPaths.has(id)).length;
  const totalCount = eligibleIds.length;
  io.to(room.code).emit("ready_count", { readyCount, totalCount, submitted: false });

  if (readyCount >= totalCount) {
    clearTurnTimer(room);
    broadcastTurnResult(room);
  }
}

// ── Turn resolution + broadcast ───────────────────────────────────────────────

function broadcastTurnResult(room) {
  const { tickSnapshots, gameOver, catches, perkNotices } = resolveTurnInRoom(room);

  for (const p of room.players) {
    if (!p.socketId) continue;
    const snaps = filteredTickSnaps(tickSnapshots, p.id, room.gameState.map);
    const final = filteredState(room, p.id);
    io.to(p.socketId).emit("turn_result", { tickSnapshots: snaps, finalState: final, catches, perkNotices });
  }

  console.log(
    `[turn] room ${room.code} turn ${room.gameState.turn - 1} → ${room.gameState.turn}` +
      (gameOver ? ` GAME OVER: ${gameOver.winner} wins` : "")
  );

  if (!gameOver) {
    startTurnTimer(room);
    submitBotPaths(room);
  }
}

// ── Socket.io event handlers ──────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("[connect]", socket.id);

  // ── Lobby: create ──────────────────────────────────────────────────────────
  socket.on("create_room", ({ name, playerToken } = {}) => {
    const { room, player } = createRoom(socket.id, name, playerToken);
    socket.join(room.code);
    socket.emit("room_joined", { room: publicRoom(room), yourId: player.id });
    console.log(`[lobby] created ${room.code} by ${name}`);
  });

  // ── Lobby: join / reconnect ────────────────────────────────────────────────
  socket.on("join_room", async ({ code, name, playerToken } = {}) => {
    const result = await joinRoom(code, socket.id, name, playerToken);

    if (result.error) {
      socket.emit("room_error", { message: result.error });
      return;
    }

    const { room, player, reconnected } = result;
    socket.join(room.code);

    if (reconnected && room.status !== "lobby") {
      const rs = reconnectState(room, player.id);
      if (rs?.type === "game") {
        socket.emit("game_started", rs.state);

        // Send catch-up animation if the last turn resolved while they were away.
        if (rs.lastTurnResult) {
          const snaps = filteredTickSnaps(
            rs.lastTurnResult.tickSnapshots,
            player.id,
            room.gameState.map
          );
          socket.emit("turn_result", {
            tickSnapshots: snaps,
            finalState: rs.state,
            catches: rs.lastTurnResult.catches,
            perkNotices: rs.lastTurnResult.perkNotices,
          });
        }

        socket.emit("ready_count", {
          readyCount: rs.readyCount,
          totalCount: rs.totalCount,
          submitted: rs.submitted,
        });

        // Restart turn timer if no one else is driving it.
        if (!rs.state.gameOver && !room.turnTimerRef) {
          startTurnTimer(room);
          submitBotPaths(room);
        }
      }
      console.log(`[reconnect] ${name} rejoined ${room.code}`);
    } else {
      socket.emit("room_joined", { room: publicRoom(room), yourId: player.id });
      socket.to(room.code).emit("room_state", { room: publicRoom(room) });
      console.log(`[lobby] ${name} joined ${room.code}`);
    }
  });

  // ── Lobby: player settings ─────────────────────────────────────────────────
  socket.on("update_player", (updates = {}) => {
    const room = updatePlayer(socket.id, updates);
    if (!room) return;
    io.to(room.code).emit("room_state", { room: publicRoom(room) });
  });

  // ── Lobby: room settings (host only) ──────────────────────────────────────
  socket.on("update_room", (updates = {}) => {
    const room = updateRoomSettings(socket.id, updates);
    if (!room) return;
    io.to(room.code).emit("room_state", { room: publicRoom(room) });
  });

  // ── Lobby: bot management (host only) ────────────────────────────────────
  socket.on("add_bot", ({ role } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const result = addBotToRoom(room.code, socket.id, role);
    if (result.error) { socket.emit("room_error", { message: result.error }); return; }
    io.to(room.code).emit("room_state", { room: publicRoom(result.room) });
  });

  socket.on("remove_bot", ({ botId } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const updated = removeBotFromRoom(room.code, socket.id, botId);
    if (updated) io.to(room.code).emit("room_state", { room: publicRoom(updated) });
  });

  // ── Game: start (host only) ────────────────────────────────────────────────
  socket.on("start_game", () => {
    const room = getRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player?.isHost || room.status !== "lobby") return;

    try {
      initGame(room);
    } catch (err) {
      socket.emit("room_error", { message: `Cannot start: ${err.message}` });
      return;
    }

    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = filteredState(room, p.id);
      io.to(p.socketId).emit("game_started", state);
    }

    io.to(room.code).emit("room_state", { room: publicRoom(room) });

    startTurnTimer(room);
    submitBotPaths(room);
    console.log(`[game] started in ${room.code}`);
  });

  // ── Game: submit planned path ──────────────────────────────────────────────
  socket.on("submit_path", ({ path } = {}) => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.status !== "playing") return;

    const player = room.players.find((p) => p.socketId === socket.id);
    if (!player) return;

    const gs = room.gameState;
    if (!gs || gs.gameOver) return;

    room.pendingPaths.set(player.id, Array.isArray(path) ? path : []);

    const eligibleIds = gs.players
      .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
      .map((p) => p.id);
    const readyCount = eligibleIds.filter((id) => room.pendingPaths.has(id)).length;
    const totalCount = eligibleIds.length;

    io.to(room.code).emit("ready_count", { readyCount, totalCount, submitted: false });

    if (readyCount >= totalCount) {
      clearTurnTimer(room);
      broadcastTurnResult(room);
    }
  });

  // ── Game browser ──────────────────────────────────────────────────────────
  socket.on("list_games", async ({ playerToken } = {}) => {
    try {
      const result = await listGamesForSocket(playerToken);
      socket.emit("games_list", result);
    } catch (err) {
      console.error("[list_games] error:", err);
      socket.emit("games_list", { myGames: [], openLobbies: [] });
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const room = removePlayer(socket.id);
    if (room) {
      if (room.players.filter((p) => !p.isBot).every((p) => !p.socketId)) {
        clearTurnTimer(room);
        console.log(`[room] ${room.code} empty — state saved to DB`);
      } else {
        io.to(room.code).emit("room_state", { room: publicRoom(room) });
      }
    }
    console.log("[disconnect]", socket.id);
  });
});

// ── Startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

async function start() {
  await initDb();

  // Reload any rooms that were active before the last server restart.
  const savedRooms = await loadAllRooms();
  for (const room of savedRooms) {
    registerRoom(room);
    // Bots need to resubmit their paths — they can't have been holding paths
    // across a restart, so clear any stale pending paths from bots.
    if (room.status === "playing" && room.gameState && !room.gameState.gameOver) {
      for (const p of room.players) {
        if (p.isBot) room.pendingPaths.delete(p.id);
      }
    }
  }
  console.log(`[startup] restored ${savedRooms.length} room(s) from DB`);

  httpServer.listen(PORT, () => console.log(`Manhunt server on :${PORT}`));
}

start().catch((err) => {
  console.error("[startup] fatal:", err);
  process.exit(1);
});
