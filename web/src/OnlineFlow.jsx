import { useState, useEffect, useMemo } from "react";
import { TILE_SIZE, CLASSES, MAPS, directions } from "./game/constants.js";
import { canMoveTo } from "./game/map.js";
import { computeVisible, computeVisibleAlongPath } from "./game/vision.js";
import { plannedCost, recoveryFor } from "./game/stamina.js";
import { getSocket, disconnectSocket, getPlayerToken } from "./socket.js";

// ── Style helpers ─────────────────────────────────────────────────────────────

function btn(bg, color, extra = {}) {
  return {
    padding: "10px 20px",
    background: bg,
    color,
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "system-ui",
    ...extra,
  };
}

const inputStyle = {
  padding: "10px 12px",
  fontSize: 15,
  border: "1px solid #ccc",
  borderRadius: 8,
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "system-ui",
};

// ── Game card (used in browse screen) ────────────────────────────────────────

function GameCard({ game, onJoin, onAbandon, isMine }) {
  const statusText =
    game.status === "lobby"
      ? `Lobby · ${game.players.length} player${game.players.length !== 1 ? "s" : ""}`
      : `Turn ${game.turn}/${game.turnLimit}`;

  const myRoleColor =
    game.myRole === "HUNTER" ? "#c62828" : game.myRole === "RUNNER" ? "#1565c0" : "#888";

  return (
    <div onClick={onJoin} style={{
      padding: "12px 14px", border: "1px solid #ddd", borderRadius: 8,
      background: "white", cursor: "pointer",
      transition: "box-shadow 0.15s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 18, letterSpacing: 3 }}>
          {game.code}
        </span>
        <span style={{
          fontSize: 11, padding: "2px 8px", borderRadius: 10, fontWeight: 600,
          background: game.status === "lobby" ? "#e3f2fd" : "#f3e5f5",
          color: game.status === "lobby" ? "#1565c0" : "#6a1b9a",
        }}>
          {statusText}
        </span>
        {game.myRole && (
          <span style={{ fontSize: 12, fontWeight: 700, color: myRoleColor }}>
            {game.myRole}{game.hasSubmitted ? " ✓" : ""}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onJoin}
            style={btn(isMine ? "#1b5e20" : "#1565c0", "#fff", { padding: "5px 14px", fontSize: 13 })}
          >
            {isMine ? "Rejoin" : "Join"}
          </button>
          {isMine && onAbandon && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Abandon room ${game.code}? This cannot be undone.`)) onAbandon();
              }}
              style={btn("transparent", "#c62828", { padding: "5px 10px", fontSize: 13, border: "1px solid #ef9a9a" })}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 5 }}>
        {game.players.map((p, i) => (
          <span key={i} style={{
            fontSize: 11, padding: "1px 7px", borderRadius: 8, fontWeight: 600,
            background: p.role === "HUNTER" ? "#ffebee" : p.role === "RUNNER" ? "#e3f2fd" : "#f5f5f5",
            color: p.role === "HUNTER" ? "#c62828" : p.role === "RUNNER" ? "#1565c0" : "#888",
          }}>
            {p.isBot ? "🤖 " : ""}{p.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function OnlineFlow({ onPlayLocal }) {
  // ── Navigation state ──────────────────────────────────────────────────────
  const [screen, setScreen] = useState("menu"); // menu | browse | join | lobby | game

  // ── Browse / lobby list state ─────────────────────────────────────────────
  const [myGames, setMyGames] = useState([]);
  const [openLobbies, setOpenLobbies] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);

  // ── Lobby state ───────────────────────────────────────────────────────────
  const [name, setName] = useState(() => localStorage.getItem("manhunt_name") ?? "");
  const [joinCode, setJoinCode] = useState(() => localStorage.getItem("manhunt_last_room") ?? "");
  const [room, setRoom] = useState(null);
  const [yourId, setYourId] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // ── Game state (set by server events) ────────────────────────────────────
  const [mapData, setMapData] = useState(null);
  const [myPlayer, setMyPlayer] = useState(null);
  const [visiblePlayers, setVisiblePlayers] = useState([]);
  const [turn, setTurn] = useState(1);
  const [turnLimit, setTurnLimit] = useState(20);
  const [headStartTurnsLeft, setHeadStartTurnsLeft] = useState(3);
  const [gameOver, setGameOver] = useState(null);
  const [playerCounts, setPlayerCounts] = useState({ hunters: 0, runners: 0 });
  const [catchNotices, setCatchNotices] = useState([]);
  const [perkNotices, setPerkNotices] = useState([]);
  const [perkBoxes, setPerkBoxes] = useState([]);
  const [lastTurnAt, setLastTurnAt] = useState(null);

  // ── Turn planning state ───────────────────────────────────────────────────
  const [localPath, setLocalPath] = useState([]);
  const [plannedFacing, setPlannedFacing] = useState(null); // null → use myPlayer.facing
  const [submitted, setSubmitted] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  // ── Animation state ───────────────────────────────────────────────────────
  const [animTick, setAnimTick] = useState(null);

  // ── Re-join on Socket.IO reconnect ───────────────────────────────────────
  // Socket.IO auto-reconnects with a new socket ID — re-announce ourselves
  // so the server updates the player's socketId in the room.
  useEffect(() => {
    if (!room?.code) return;
    const socket = getSocket();
    function onConnect() {
      socket.emit("join_room", { code: room.code, name, playerToken: getPlayerToken() });
    }
    socket.on("connect", onConnect);
    return () => socket.off("connect", onConnect);
  }, [room?.code, name]);

  // ── Socket event listeners ────────────────────────────────────────────────
  useEffect(() => {
    if (screen === "menu") return;
    const socket = getSocket();

    function onRoomJoined({ room, yourId }) {
      setRoom(room);
      setYourId(yourId);
      localStorage.setItem("manhunt_last_room", room.code);
      setScreen("lobby");
      setError("");
    }
    function onRoomState({ room }) { setRoom(room); }
    function onRoomError({ message }) { setError(message); }

    async function onGameStarted(state) {
      const mapInfo = MAPS.find((m) => m.key === state.mapKey);
      const resp = await fetch(mapInfo.file);
      const map = await resp.json();
      setMapData(map);
      setMyPlayer(state.yourPlayer);
      setVisiblePlayers(state.visiblePlayers);
      setTurn(state.turn);
      setHeadStartTurnsLeft(state.headStartTurnsLeft);
      setGameOver(state.gameOver);
      setPlayerCounts(state.playerCounts ?? { hunters: 0, runners: 0 });
      setTurnLimit(state.turnLimit ?? 20);
      setPerkBoxes(state.perkBoxes ?? []);
      setLastTurnAt(state.lastTurnAt ?? null);
      setLocalPath([]);
      setPlannedFacing(null);
      setSubmitted(false);
      setReadyCount(0);
      setAnimTick(null);
      setCatchNotices([]);
      setPerkNotices([]);
      setScreen("game");
    }

    function onTurnResult({ tickSnapshots, finalState, catches, perkNotices: notices }) {
      setAnimTick({ snapshots: tickSnapshots, currentIndex: 0, finalState, catches: catches ?? [], perkNotices: notices ?? [] });
    }

    function onReadyCount({ readyCount, totalCount }) {
      setReadyCount(readyCount);
      setTotalCount(totalCount);
    }

    function onGamesList({ myGames: mg, openLobbies: ol }) {
      setMyGames(mg ?? []);
      setOpenLobbies(ol ?? []);
      setLoadingGames(false);
    }

    socket.on("room_joined", onRoomJoined);
    socket.on("room_state", onRoomState);
    socket.on("room_error", onRoomError);
    socket.on("game_started", onGameStarted);
    socket.on("turn_result", onTurnResult);
    socket.on("ready_count", onReadyCount);
    socket.on("games_list", onGamesList);

    return () => {
      socket.off("room_joined", onRoomJoined);
      socket.off("room_state", onRoomState);
      socket.off("room_error", onRoomError);
      socket.off("game_started", onGameStarted);
      socket.off("turn_result", onTurnResult);
      socket.off("ready_count", onReadyCount);
      socket.off("games_list", onGamesList);
    };
  }, [screen]);

  // ── Animation stepper ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!animTick) return;

    if (animTick.currentIndex >= animTick.snapshots.length) {
      const { finalState, catches, perkNotices: notices } = animTick;
      setMyPlayer(finalState.yourPlayer);
      setVisiblePlayers(finalState.visiblePlayers);
      setTurn(finalState.turn);
      setHeadStartTurnsLeft(finalState.headStartTurnsLeft);
      setGameOver(finalState.gameOver);
      setPlayerCounts(finalState.playerCounts ?? { hunters: 0, runners: 0 });
      setPerkBoxes(finalState.perkBoxes ?? []);
      setLastTurnAt(finalState.lastTurnAt ?? null);
      setLocalPath([]);
      setPlannedFacing(null);
      setSubmitted(false);
      setAnimTick(null);

      if (catches?.length) {
        const ts = Date.now();
        const catchItems = catches.map((c, i) => ({ ...c, id: `${ts}-c${i}` }));
        setCatchNotices((prev) => [...prev, ...catchItems]);
        catchItems.forEach((n) => {
          setTimeout(() => setCatchNotices((prev) => prev.filter((x) => x.id !== n.id)), 4000);
        });
      }
      if (notices?.length) {
        const ts = Date.now();
        const perkItems = notices.map((n, i) => ({ ...n, id: `${ts}-p${i}` }));
        setPerkNotices((prev) => [...prev, ...perkItems]);
        perkItems.forEach((n) => {
          setTimeout(() => setPerkNotices((prev) => prev.filter((x) => x.id !== n.id)), 4000);
        });
      }
      return;
    }

    const timer = setTimeout(() => {
      setAnimTick((prev) => prev && { ...prev, currentIndex: prev.currentIndex + 1 });
    }, 300);

    return () => clearTimeout(timer);
  }, [animTick]);

  // ── Path planning ─────────────────────────────────────────────────────────

  // Returns the last actual position in the planned path (skipping look steps).
  function getLastPos() {
    for (let i = localPath.length - 1; i >= 0; i--) {
      if (!localPath[i].look) return { x: localPath[i].x, y: localPath[i].y };
    }
    return { x: myPlayer.x, y: myPlayer.y };
  }

  function tryAddStep(toX, toY) {
    if (!mapData || !myPlayer || submitted || animTick) return;
    if (myPlayer.role === "HUNTER" && headStartTurnsLeft > 0) return;

    const classInfo = CLASSES[myPlayer.classKey] ?? CLASSES.STANDARD;
    const lastPos = getLastPos();
    const dx = toX - lastPos.x;
    const dy = toY - lastPos.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return;

    const newFacing = Math.atan2(dy, dx) * (180 / Math.PI);
    const curFacing = plannedFacing ?? myPlayer.facing;
    const isLook = Math.abs(newFacing - curFacing) > 0.01;

    if (isLook) {
      // Turn in place — free, no stamina cost, doesn't count toward move limit.
      setLocalPath((prev) => [...prev, { look: true, facing: newFacing }]);
      setPlannedFacing(newFacing);
      return;
    }

    // It's a move step — check limits.
    const moveCount = localPath.filter((s) => !s.look).length;
    const hasFreeSprint = myPlayer.activePerks?.freeSprint === true;
    const effectiveMaxSteps = hasFreeSprint ? 10 : classInfo.maxSteps;
    if (moveCount >= effectiveMaxSteps) return;
    if (!canMoveTo(lastPos.x, lastPos.y, toX, toY, mapData)) return;
    if (!hasFreeSprint && plannedCost(myPlayer.classKey, moveCount + 1) > myPlayer.stamina) return;

    setLocalPath((prev) => [...prev, { x: toX, y: toY }]);
    setPlannedFacing(newFacing);
  }

  useEffect(() => {
    if (screen !== "game") return;
    const handler = (e) => {
      if (submitted || animTick) return;
      const dir = directions[e.key.toLowerCase()];
      if (!dir || !myPlayer) return;
      const last = getLastPos();
      tryAddStep(last.x + dir.dx, last.y + dir.dy);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [screen, myPlayer, localPath, plannedFacing, submitted, animTick, headStartTurnsLeft]);

  // ── Fetch games list when entering browse screen ──────────────────────────
  useEffect(() => {
    if (screen !== "browse") return;
    setLoadingGames(true);
    getSocket().emit("list_games", { playerToken: getPlayerToken() });
  }, [screen]);

  // ── Lobby actions ─────────────────────────────────────────────────────────
  function refreshGamesList() {
    setLoadingGames(true);
    getSocket().emit("list_games", { playerToken: getPlayerToken() });
  }

  function handleJoinFromBrowse(code) {
    if (!name.trim()) { setError("Enter your name first"); return; }
    localStorage.setItem("manhunt_name", name.trim());
    localStorage.setItem("manhunt_last_room", code);
    setError("");
    getSocket().emit("join_room", {
      code,
      name: name.trim(),
      playerToken: getPlayerToken(),
    });
  }

  function handleCreate() {
    if (!name.trim()) { setError("Enter your name first"); return; }
    localStorage.setItem("manhunt_name", name.trim());
    setError("");
    getSocket().emit("create_room", { name: name.trim(), playerToken: getPlayerToken() });
  }

  function handleJoin() {
    if (!name.trim()) { setError("Enter your name first"); return; }
    if (!joinCode.trim()) { setError("Enter a room code"); return; }
    localStorage.setItem("manhunt_name", name.trim());
    localStorage.setItem("manhunt_last_room", joinCode.trim().toUpperCase());
    setError("");
    getSocket().emit("join_room", {
      code: joinCode.trim().toUpperCase(),
      name: name.trim(),
      playerToken: getPlayerToken(),
    });
  }

  function handleRejoin() {
    const savedName = localStorage.getItem("manhunt_name") ?? "";
    const savedCode = localStorage.getItem("manhunt_last_room") ?? "";
    if (!savedName || !savedCode) return;
    setName(savedName);
    setJoinCode(savedCode);
    setError("");
    getSocket().emit("join_room", {
      code: savedCode,
      name: savedName,
      playerToken: getPlayerToken(),
    });
  }

  function handleLeave() {
    disconnectSocket();
    setRoom(null); setYourId(null); setMapData(null); setMyPlayer(null);
    setGameOver(null); setAnimTick(null); setScreen("menu"); setError("");
  }

  function copyCode() {
    navigator.clipboard.writeText(room.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleStartGame() {
    getSocket().emit("start_game");
  }

  function handleReady() {
    if (submitted) return;
    getSocket().emit("submit_path", { path: localPath });
    setSubmitted(true);
  }

  // ── Derived display values for the game board ──────────────────────────────
  const isAnimating = animTick !== null;

  const displayPlayers = useMemo(() => {
    if (!myPlayer) return [];
    if (isAnimating) {
      return animTick.snapshots[animTick.currentIndex] ?? [myPlayer, ...visiblePlayers];
    }
    return [myPlayer, ...visiblePlayers];
  }, [myPlayer, visiblePlayers, animTick, isAnimating]);

  const myDisplayPlayer = displayPlayers.find((p) => p.id === myPlayer?.id);

  const visionOpts = useMemo(() => {
    const perks = myPlayer?.activePerks ?? {};
    return {
      omniscience: (perks.omniscience ?? 0) > 0,
      rangeBonus: (perks.extendedVision ?? 0) > 0 ? 5 : 0,
    };
  }, [myPlayer?.activePerks]);

  const visible = useMemo(() => {
    if (!mapData || !myDisplayPlayer) return new Set();
    if (isAnimating) {
      return computeVisible(myDisplayPlayer.x, myDisplayPlayer.y, myDisplayPlayer.facing, mapData, visionOpts);
    }
    const playerWithPath = { ...myDisplayPlayer, path: localPath };
    return computeVisibleAlongPath(playerWithPath, mapData, visionOpts);
  }, [mapData, myDisplayPlayer, localPath, isAnimating, visionOpts]);

  const me = room?.players.find((p) => p.id === yourId);
  const isHost = me?.isHost ?? false;
  const allHaveRoles =
    room?.players.length >= 2 && room.players.every((p) => p.role !== null);

  // ── Screens ───────────────────────────────────────────────────────────────

  if (screen === "menu") {
    const savedName = localStorage.getItem("manhunt_name");
    const savedCode = localStorage.getItem("manhunt_last_room");
    return (
      <div style={{
        minHeight: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        background: "#111", fontFamily: "system-ui", color: "white", gap: 20,
      }}>
        <div style={{ fontSize: 12, letterSpacing: 6, color: "#555", textTransform: "uppercase" }}>
          tactical pursuit
        </div>
        <div style={{ fontSize: 64, fontWeight: 900, letterSpacing: -2 }}>MANHUNT</div>

        {savedName && savedCode && (
          <button onClick={handleRejoin} style={{
            ...btn("#1b5e20", "#fff"),
            width: 260, fontSize: 14, lineHeight: 1.4, padding: "12px 20px",
          }}>
            ↩ Rejoin as <b>{savedName}</b><br />
            <span style={{ fontWeight: 400, fontSize: 12, opacity: 0.85 }}>Room {savedCode}</span>
          </button>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 220 }}>
          <button onClick={onPlayLocal} style={btn("#222", "#fff", { border: "1px solid #444" })}>
            Play Locally
          </button>
          <button onClick={() => setScreen("browse")} style={btn("#1565c0", "#fff")}>
            Play Online
          </button>
        </div>
      </div>
    );
  }

  if (screen === "browse") {
    return (
      <div style={{ minHeight: "100vh", fontFamily: "system-ui", padding: 20, maxWidth: 560, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <button onClick={() => { setScreen("menu"); setError(""); }}
            style={btn("transparent", "#555", { border: "1px solid #ccc", padding: "6px 12px", fontSize: 13 })}>
            ← Back
          </button>
          <h2 style={{ margin: 0 }}>Game Lobby</h2>
          <button onClick={refreshGamesList} disabled={loadingGames}
            style={btn("transparent", "#555", { border: "1px solid #ccc", padding: "6px 12px", fontSize: 13, marginLeft: "auto" })}>
            {loadingGames ? "…" : "↻ Refresh"}
          </button>
        </div>

        {/* Name + create */}
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name" maxLength={20} />
          <button onClick={handleCreate} style={btn("#1565c0", "#fff")}>+ Create</button>
        </div>
        {error && <div style={{ color: "#ef5350", fontSize: 14, marginBottom: 12 }}>{error}</div>}

        {/* Your Games */}
        {myGames.length > 0 && (
          <div style={{ marginTop: 20, marginBottom: 24 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#333" }}>Your Games</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {myGames.map((g) => (
                <GameCard
                  key={g.code} game={g} isMine
                  onJoin={() => handleJoinFromBrowse(g.code)}
                  onAbandon={() => getSocket().emit("abandon_room", { code: g.code, playerToken: getPlayerToken() })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Open Lobbies */}
        <div style={{ marginTop: myGames.length ? 0 : 20 }}>
          <h3 style={{ margin: "0 0 10px", fontSize: 15, color: "#333" }}>Open Lobbies</h3>
          {loadingGames ? (
            <div style={{ color: "#999", fontSize: 14, padding: "12px 0" }}>Loading…</div>
          ) : openLobbies.length === 0 ? (
            <div style={{ color: "#999", fontSize: 14, padding: "12px 0" }}>
              No open lobbies right now — create one above!
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {openLobbies.map((g) => (
                <GameCard key={g.code} game={g} onJoin={() => handleJoinFromBrowse(g.code)} />
              ))}
            </div>
          )}
        </div>

        {/* Join by code fallback */}
        <div style={{ marginTop: 28, paddingTop: 20, borderTop: "1px solid #eee" }}>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>Have a code? Join directly:</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ ...inputStyle, flex: 1, fontFamily: "monospace", letterSpacing: 4, textTransform: "uppercase" }}
              value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="CODE" maxLength={5}
              onKeyDown={(e) => e.key === "Enter" && handleJoin()} />
            <button onClick={handleJoin} style={btn("#1565c0", "#fff")}>Join →</button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "join") {
    return (
      <div style={{
        minHeight: "100vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        fontFamily: "system-ui", padding: 24, gap: 12,
      }}>
        <h2 style={{ margin: 0 }}>Play Online</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 320 }}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Your name</label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alice" maxLength={20} autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
        </div>
        <button onClick={handleCreate} style={btn("#1565c0", "#fff", { width: 320, marginTop: 4 })}>
          Create Room
        </button>
        <div style={{ color: "#aaa", fontSize: 13, margin: "4px 0" }}>— or join existing —</div>
        <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 320 }}>
          <input style={{ ...inputStyle, flex: 1, fontFamily: "monospace", letterSpacing: 4, textTransform: "uppercase" }}
            value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="CODE" maxLength={5}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()} />
          <button onClick={handleJoin} style={btn("#1565c0", "#fff")}>Join →</button>
        </div>
        {error && <div style={{ color: "#ef5350", fontSize: 14 }}>{error}</div>}
        <button onClick={() => { setScreen("menu"); setError(""); }}
          style={btn("transparent", "#777", { border: "1px solid #ccc", marginTop: 8 })}>
          ← Back
        </button>
      </div>
    );
  }

  if (screen === "lobby" && room) {
    return (
      <div style={{ padding: 20, fontFamily: "system-ui", maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 12, color: "#888" }}>Room code</div>
            <div style={{ fontSize: 32, fontWeight: 900, fontFamily: "monospace", letterSpacing: 6 }}>
              {room.code}
            </div>
          </div>
          <button onClick={copyCode} style={btn(copied ? "#388e3c" : "#eee", copied ? "#fff" : "#333", { fontSize: 13 })}>
            {copied ? "Copied!" : "Copy code"}
          </button>
          <button onClick={handleLeave}
            style={btn("transparent", "#c62828", { border: "1px solid #c62828", marginLeft: "auto", fontSize: 13 })}>
            Leave
          </button>
        </div>

        <h3 style={{ marginTop: 0 }}>Players ({room.players.length}/6)</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
          {room.players.map((p) => {
            const isMe = p.id === yourId;
            const roleColor = p.role === "HUNTER"
              ? { bg: "#ffebee", fg: "#c62828" }
              : p.role === "RUNNER"
              ? { bg: "#e3f2fd", fg: "#1565c0" }
              : { bg: "#f5f5f5", fg: "#999" };

            return (
              <div key={p.id} style={{
                padding: 12,
                border: `1px solid ${isMe ? "#1565c0" : p.isBot ? "#bdbdbd" : "#ddd"}`,
                borderRadius: 8,
                background: isMe ? "#e8f4fd" : p.isBot ? "#fafafa" : "white",
                opacity: p.connected ? 1 : 0.5,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, minWidth: 80 }}>
                    {isMe ? `${p.name} (you)` : p.name}
                    {p.isHost && <span style={{ marginLeft: 6, fontSize: 11, color: "#888", fontWeight: 400 }}>HOST</span>}
                    {p.isBot && <span style={{ marginLeft: 6, fontSize: 11, color: "#555", fontWeight: 400, background: "#e0e0e0", padding: "1px 5px", borderRadius: 3 }}>BOT</span>}
                    {!p.connected && !p.isBot && <span style={{ marginLeft: 6, fontSize: 11, color: "#f57c00" }}>disconnected</span>}
                  </span>
                  {isMe ? (
                    <>
                      <select value={p.role ?? ""} onChange={(e) => getSocket().emit("update_player", { role: e.target.value || null })} style={{ fontSize: 13 }}>
                        <option value="">— pick role —</option>
                        <option value="HUNTER">Hunter</option>
                        <option value="RUNNER">Runner</option>
                      </select>
                      <select value={p.classKey} onChange={(e) => getSocket().emit("update_player", { classKey: e.target.value })} style={{ fontSize: 13 }}>
                        {Object.entries(CLASSES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
                      </select>
                      <input value={p.token} maxLength={1}
                        onChange={(e) => getSocket().emit("update_player", { token: e.target.value.toUpperCase().slice(0, 1) })}
                        style={{ width: 32, textAlign: "center", fontSize: 14, border: "1px solid #ccc", borderRadius: 4, padding: "2px 0" }} />
                    </>
                  ) : (
                    <>
                      <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: roleColor.bg, color: roleColor.fg, fontWeight: 600 }}>
                        {p.role ?? "no role"}
                      </span>
                      {p.role && <span style={{ fontSize: 13, color: "#666" }}>{CLASSES[p.classKey]?.name}</span>}
                      <div style={{
                        width: 28, height: 28, borderRadius: "50%",
                        background: p.role === "HUNTER" ? "#ef5350" : "#42a5f5",
                        color: "white", fontSize: 13, fontWeight: 700,
                        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}>{p.token}</div>
                      {p.isBot && isHost && (
                        <button onClick={() => getSocket().emit("remove_bot", { botId: p.id })}
                          style={{ marginLeft: "auto", fontSize: 13, padding: "2px 8px", borderRadius: 4, border: "1px solid #ccc", background: "white", cursor: "pointer", color: "#c62828" }}>
                          Remove
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {isHost && room.players.length < 6 && (
          <div style={{ marginBottom: 24, display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#555", fontWeight: 600 }}>Add bot:</span>
            <button onClick={() => getSocket().emit("add_bot", { role: "HUNTER" })}
              style={btn("#ffebee", "#c62828", { fontSize: 13, padding: "6px 14px", border: "1px solid #ef9a9a" })}>
              + Hunter Bot
            </button>
            <button onClick={() => getSocket().emit("add_bot", { role: "RUNNER" })}
              style={btn("#e3f2fd", "#1565c0", { fontSize: 13, padding: "6px 14px", border: "1px solid #90caf9" })}>
              + Runner Bot
            </button>
          </div>
        )}

        {isHost && (
          <div style={{ marginBottom: 24 }}>
            <h3 style={{ marginTop: 0 }}>Game settings</h3>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ fontSize: 14 }}>Map:{" "}
                <select value={room.mapKey} onChange={(e) => getSocket().emit("update_room", { mapKey: e.target.value })}>
                  {MAPS.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 14 }}>Turn limit:{" "}
                <select value={room.turnLimit} onChange={(e) => getSocket().emit("update_room", { turnLimit: Number(e.target.value) })}>
                  {[15, 20, 25, 30].map((n) => <option key={n} value={n}>{n} turns</option>)}
                </select>
              </label>
              <label style={{ fontSize: 14 }}>Head start:{" "}
                <select value={room.headStart} onChange={(e) => getSocket().emit("update_room", { headStart: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} turns</option>)}
                </select>
              </label>
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginBottom: 12, padding: "10px 14px", background: "#ffebee", color: "#c62828", borderRadius: 6, fontSize: 14 }}>
            {error}
          </div>
        )}

        {isHost ? (
          <button disabled={!allHaveRoles} onClick={handleStartGame}
            title={!allHaveRoles ? "All players must pick a role first" : ""}
            style={btn(allHaveRoles ? "#1565c0" : "#ccc", "white", {
              width: "100%", fontSize: 16, padding: "14px 0",
              cursor: allHaveRoles ? "pointer" : "not-allowed",
            })}>
            {allHaveRoles ? "Start Game" : "Waiting for all players to pick a role…"}
          </button>
        ) : (
          <div style={{ textAlign: "center", color: "#888", padding: 16 }}>
            Waiting for host to start the game…
          </div>
        )}
      </div>
    );
  }

  // ── Game screen ───────────────────────────────────────────────────────────
  if (screen === "game" && myPlayer && mapData) {
    if (gameOver) {
      const huntersWon = gameOver.winner === "HUNTER";
      return (
        <div style={{
          minHeight: "100vh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          background: huntersWon ? "#1a0000" : "#00141a",
          fontFamily: "system-ui", color: "white", gap: 16,
        }}>
          <div style={{ fontSize: 13, color: huntersWon ? "#ef9a9a" : "#80cbc4", textTransform: "uppercase", letterSpacing: 3 }}>
            Game Over
          </div>
          <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1 }}>
            {huntersWon ? "Hunters Win" : "Runners Win"}
          </div>
          <div style={{ fontSize: 16, color: "#bbb", marginTop: 4 }}>
            {huntersWon
              ? `All runners caught on turn ${gameOver.turn}`
              : `Survived all ${turnLimit} turns`}
          </div>
          <button onClick={handleLeave} style={{
            marginTop: 32, padding: "14px 36px", fontSize: 16, fontWeight: 700,
            background: huntersWon ? "#b71c1c" : "#00695c", color: "white",
            border: "none", borderRadius: 8, cursor: "pointer",
          }}>
            Back to Menu
          </button>
        </div>
      );
    }

    const playersAt = new Map();
    for (const p of displayPlayers) playersAt.set(`${p.x},${p.y}`, p);

    const canAct = !(myPlayer.role === "HUNTER" && headStartTurnsLeft > 0);
    const classInfo = CLASSES[myPlayer.classKey] ?? CLASSES.STANDARD;
    const moveCount = localPath.filter((s) => !s.look).length;
    const hasFreeSprint = myPlayer.activePerks?.freeSprint === true;
    const effectiveMaxSteps = hasFreeSprint ? 10 : classInfo.maxSteps;
    const stepsLeft = effectiveMaxSteps - moveCount;
    const staminaAfter = hasFreeSprint ? myPlayer.stamina : myPlayer.stamina - plannedCost(myPlayer.classKey, moveCount);

    const PERK_LABELS = {
      OMNISCIENCE: "All-Seeing",
      STAMINA_REFILL: "Full Stamina",
      EXTENDED_VISION: "Eagle Eye",
      FREE_SPRINT: "Sprint",
    };
    const activePerks = myPlayer.activePerks ?? {};

    return (
      <>
      {(catchNotices.length > 0 || perkNotices.length > 0) && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, display: "flex", flexDirection: "column", gap: 8,
          alignItems: "center", pointerEvents: "none",
        }}>
          {catchNotices.map((n) => (
            <div key={n.id} style={{
              background: "#b71c1c", color: "white",
              padding: "10px 22px", borderRadius: 8, fontWeight: 700,
              fontSize: 15, fontFamily: "system-ui",
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
            }}>
              {n.caughtBy} caught {n.name}!
            </div>
          ))}
          {perkNotices.map((n) => (
            <div key={n.id} style={{
              background: "#f5c400", color: "#1a1200",
              padding: "10px 22px", borderRadius: 8, fontWeight: 700,
              fontSize: 15, fontFamily: "system-ui",
              boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
            }}>
              {n.playerName} picked up {PERK_LABELS[n.perk] ?? n.perk}!
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 16, padding: 12, fontFamily: "system-ui" }}>
        {/* ── Map grid ──────────────────────────────────────────────────── */}
        <div>
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${mapData.width}, ${TILE_SIZE}px)`,
          }}>
            {mapData.tiles.flatMap((row, y) =>
              row.map((tile, x) => {
                const key = `${x},${y}`;
                const isVisible = visible.has(key);

                let bg = "#f3f3f3";
                if (tile === "BLOCK") bg = "#000";
                if (tile === "NETTLES") bg = "#f4a742";
                if (tile === "TREE") bg = "#4caf50";

                const occupant = playersAt.get(key);
                const isPerkBox = perkBoxes.some((b) => b.x === x && b.y === y);

                const plannedIndex =
                  !isAnimating && !submitted
                    ? localPath.filter((s) => !s.look).findIndex((s) => s.x === x && s.y === y)
                    : -1;
                const showPlanned = plannedIndex !== -1;

                if (isPerkBox) bg = "#f5c400";
                if (showPlanned) bg = myPlayer.role === "HUNTER" ? "#9c27b0" : "#00bcd4";

                return (
                  <div key={key} onClick={() => tryAddStep(x, y)} style={{
                    width: TILE_SIZE, height: TILE_SIZE, background: bg,
                    border: "1px solid #bdbdbd", position: "relative", cursor: "pointer",
                  }}>
                    {!isVisible && (
                      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)" }} />
                    )}
                    {showPlanned && !occupant && (
                      <div style={{
                        position: "absolute", inset: 0, display: "flex",
                        alignItems: "center", justifyContent: "center",
                        color: "white", fontSize: 12, fontWeight: 800, pointerEvents: "none",
                      }}>
                        {plannedIndex + 1}
                      </div>
                    )}
                    {occupant && (
                      <div title={`${occupant.name} (${occupant.role})`} style={{
                        position: "absolute", inset: 3, borderRadius: 999,
                        background: occupant.role === "HUNTER" ? "#ff2d2d" : "#1976d2",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "white", fontSize: 12, fontWeight: 800,
                        outline: occupant.id === myPlayer.id ? "2px solid white" : "none",
                      }}>
                        {occupant.token}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Controls */}
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => { setLocalPath([]); setPlannedFacing(null); }} disabled={submitted || isAnimating || localPath.length === 0}
              style={{ padding: "8px 14px", borderRadius: 6, cursor: "pointer" }}>
              Clear Path
            </button>
            <button onClick={handleReady} disabled={submitted || isAnimating}
              style={{
                padding: "8px 20px", borderRadius: 6, fontWeight: 700,
                cursor: submitted || isAnimating ? "default" : "pointer",
                background: submitted ? "#c8e6c9" : "#1565c0",
                color: submitted ? "#2e7d32" : "white", border: "none",
                opacity: isAnimating ? 0.5 : 1,
              }}>
              {submitted ? "✓ Waiting…" : canAct ? "Ready →" : "Pass turn →"}
            </button>
            {isAnimating && (
              <span style={{ fontSize: 13, color: "#888", alignSelf: "center" }}>
                Resolving… {animTick.currentIndex}/{animTick.snapshots.length}
              </span>
            )}
            {!isAnimating && submitted && (
              <span style={{ fontSize: 13, color: "#888", alignSelf: "center" }}>
                Waiting {readyCount}/{totalCount} ready
              </span>
            )}
          </div>

          {/* D-pad — shown when player can act and hasn't submitted */}
          {canAct && !submitted && !isAnimating && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: "#555", marginBottom: 8 }}>
                Steps left: <b>{stepsLeft}</b>
                {" · "}
                {hasFreeSprint
                  ? <span style={{ color: "#880e4f", fontWeight: 700 }}>Sprint (free)</span>
                  : <>Stamina: <b>{staminaAfter}/{classInfo.staminaMax}</b></>
                }
              </div>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 56px)",
                gridTemplateRows: "repeat(3, 56px)",
                gap: 4, width: "fit-content",
              }}>
                {[
                  { dx: -1, dy: -1, label: "↖", col: 1, row: 1 },
                  { dx:  0, dy: -1, label: "↑", col: 2, row: 1 },
                  { dx:  1, dy: -1, label: "↗", col: 3, row: 1 },
                  { dx: -1, dy:  0, label: "←", col: 1, row: 2 },
                  { dx:  1, dy:  0, label: "→", col: 3, row: 2 },
                  { dx: -1, dy:  1, label: "↙", col: 1, row: 3 },
                  { dx:  0, dy:  1, label: "↓", col: 2, row: 3 },
                  { dx:  1, dy:  1, label: "↘", col: 3, row: 3 },
                ].map(({ dx, dy, label, col, row }) => (
                  <button key={label}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      const last = getLastPos();
                      tryAddStep(last.x + dx, last.y + dy);
                    }}
                    style={{
                      gridColumn: col, gridRow: row,
                      width: 56, height: 56, fontSize: 22,
                      background: myPlayer.role === "HUNTER" ? "#4a0000" : "#002040",
                      color: "white", border: "none", borderRadius: 8,
                      cursor: "pointer", userSelect: "none", touchAction: "manipulation",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <div style={{ minWidth: 260 }}>
          <h3 style={{ marginTop: 0 }}>Manhunt – Online</h3>

          <div><b>Turn:</b> {turn} / {turnLimit}</div>
          {headStartTurnsLeft > 0 && (
            <div style={{ color: "#b71c1c", fontSize: 13, marginTop: 4 }}>
              Head start: {headStartTurnsLeft} turn{headStartTurnsLeft !== 1 ? "s" : ""} left
            </div>
          )}
          {!submitted && lastTurnAt && (() => {
            const deadline = new Date(lastTurnAt).getTime() + 24 * 60 * 60 * 1000;
            const msLeft = deadline - Date.now();
            const hLeft = Math.max(0, Math.floor(msLeft / 3600000));
            const mLeft = Math.max(0, Math.floor((msLeft % 3600000) / 60000));
            const urgent = msLeft < 3 * 3600000;
            return (
              <div style={{ fontSize: 12, marginTop: 4, color: urgent ? "#b71c1c" : "#666" }}>
                ⏱ Submit within {hLeft}h {mLeft}m or your turn is skipped
              </div>
            );
          })()}

          <div style={{ marginTop: 10, display: "flex", gap: 14, fontSize: 13, fontWeight: 600 }}>
            <span style={{ color: "#c62828" }}>
              &#9679; {playerCounts.hunters} {playerCounts.hunters === 1 ? "Hunter" : "Hunters"}
            </span>
            <span style={{ color: "#1565c0" }}>
              &#9679; {playerCounts.runners} {playerCounts.runners === 1 ? "Runner" : "Runners"}
            </span>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {myPlayer.name}{" "}
              <span style={{ color: myPlayer.role === "HUNTER" ? "#c62828" : "#1565c0", fontSize: 13 }}>
                {myPlayer.role}
              </span>
            </div>
            <div style={{ fontSize: 13, color: "#555" }}>
              {CLASSES[myPlayer.classKey]?.name} · {myPlayer.stamina}/{classInfo.staminaMax} stamina
            </div>
            {myPlayer.role === "HUNTER" && headStartTurnsLeft > 0 && (
              <div style={{ color: "#b71c1c", fontSize: 13, marginTop: 4 }}>
                Waiting for head start to end
              </div>
            )}
            {(activePerks.omniscience > 0 || activePerks.extendedVision > 0 || activePerks.freeSprint) && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {activePerks.omniscience > 0 && (
                  <div style={{ fontSize: 12, padding: "2px 7px", background: "#fff9c4", color: "#5d4037", borderRadius: 4, border: "1px solid #f5c400", fontWeight: 600 }}>
                    ★ All-Seeing ({activePerks.omniscience} turn{activePerks.omniscience !== 1 ? "s" : ""})
                  </div>
                )}
                {activePerks.extendedVision > 0 && (
                  <div style={{ fontSize: 12, padding: "2px 7px", background: "#e8f5e9", color: "#1b5e20", borderRadius: 4, border: "1px solid #66bb6a", fontWeight: 600 }}>
                    ★ Eagle Eye ({activePerks.extendedVision} turn{activePerks.extendedVision !== 1 ? "s" : ""})
                  </div>
                )}
                {activePerks.freeSprint && (
                  <div style={{ fontSize: 12, padding: "2px 7px", background: "#fce4ec", color: "#880e4f", borderRadius: 4, border: "1px solid #f48fb1", fontWeight: 600 }}>
                    ★ Sprint — 10 free steps this turn
                  </div>
                )}
              </div>
            )}
          </div>

          {visiblePlayers.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Visible players</div>
              {visiblePlayers.map((p) => (
                <div key={p.id} style={{ fontSize: 13, color: "#555", marginBottom: 4 }}>
                  <span style={{
                    display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                    background: p.role === "HUNTER" ? "#ff2d2d" : "#1976d2",
                    marginRight: 6,
                  }} />
                  {p.name} ({p.role})
                </div>
              ))}
            </div>
          )}

          <button onClick={handleLeave}
            style={btn("transparent", "#c62828", { border: "1px solid #c62828", fontSize: 13, marginTop: 24 })}>
            Leave Game
          </button>
        </div>
      </div>
      </>
    );
  }

  return null;
}
