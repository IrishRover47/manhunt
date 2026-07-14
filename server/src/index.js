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
} from "./rooms.js";

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

const TURN_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

function startTurnTimer(room) {
  clearTurnTimer(room);
  room.turnTimerRef = setTimeout(() => {
    console.log(`[timer] auto-submitting idle players in ${room.code}`);
    const gs = room.gameState;
    if (!gs) return;
    // Fill in empty paths for anyone who didn't submit.
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

// ── Turn resolution + broadcast ───────────────────────────────────────────────

function broadcastTurnResult(room) {
  const { tickSnapshots, gameOver } = resolveTurnInRoom(room);

  for (const p of room.players) {
    if (!p.socketId) continue;
    const snaps = filteredTickSnaps(tickSnapshots, p.id, room.gameState.map);
    const final = filteredState(room, p.id);
    io.to(p.socketId).emit("turn_result", { tickSnapshots: snaps, finalState: final });
  }

  console.log(
    `[turn] room ${room.code} turn ${room.gameState.turn - 1} → ${room.gameState.turn}` +
      (gameOver ? ` GAME OVER: ${gameOver.winner} wins` : "")
  );

  if (!gameOver) startTurnTimer(room);
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
  socket.on("join_room", ({ code, name, playerToken } = {}) => {
    const result = joinRoom(code, socket.id, name, playerToken);

    if (result.error) {
      socket.emit("room_error", { message: result.error });
      return;
    }

    const { room, player, reconnected } = result;
    socket.join(room.code);

    if (reconnected && room.status !== "lobby") {
      // Send current game state back to the reconnecting client.
      const rs = reconnectState(room, player.id);
      if (rs?.type === "game") {
        socket.emit("game_started", rs.state);
        socket.emit("ready_count", {
          readyCount: rs.readyCount,
          totalCount: rs.totalCount,
          submitted: rs.submitted,
        });
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

    // Send each connected player their personalised starting state.
    for (const p of room.players) {
      if (!p.socketId) continue;
      const state = filteredState(room, p.id);
      io.to(p.socketId).emit("game_started", state);
    }

    // Broadcast updated room status to lobby (handles spectators / late joins).
    io.to(room.code).emit("room_state", { room: publicRoom(room) });

    startTurnTimer(room);
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

    // Ignore if hunter is in head-start (can't act yet).
    if (player.role === "HUNTER" && gs.headStartTurnsLeft > 0) return;

    room.pendingPaths.set(player.id, Array.isArray(path) ? path : []);

    // Broadcast ready count to all players in the room.
    const eligibleIds = gs.players
      .filter((p) => !(p.role === "HUNTER" && gs.headStartTurnsLeft > 0))
      .map((p) => p.id);
    const readyCount = room.pendingPaths.size;
    const totalCount = eligibleIds.length;

    io.to(room.code).emit("ready_count", { readyCount, totalCount, submitted: false });

    if (readyCount >= totalCount) {
      clearTurnTimer(room);
      broadcastTurnResult(room);
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const room = removePlayer(socket.id);
    if (room) {
      io.to(room.code).emit("room_state", { room: publicRoom(room) });
    }
    console.log("[disconnect]", socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Manhunt server on :${PORT}`));
