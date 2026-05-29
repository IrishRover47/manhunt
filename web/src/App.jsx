import { useEffect, useMemo, useState } from "react";
import { TILE_SIZE, CLASSES, MAPS, directions } from "./game/constants.js";
import { canMoveTo } from "./game/map.js";
import { computeVisible, computeVisibleAlongPath } from "./game/vision.js";
import { plannedCost, recoveryFor } from "./game/stamina.js";
import { findSpawn } from "./game/spawn.js";
import { resolveTurn } from "./game/resolver.js";
import { OnlineFlow } from "./OnlineFlow.jsx";

export default function App() {
  const [gameMode, setGameMode] = useState("menu"); // "menu" | "local"

  const [map, setMap] = useState(null);
  const [error, setError] = useState("");
  const [startPos, setStartPos] = useState({ x: 13, y: 13 });
  const [selectedMapKey, setSelectedMapKey] = useState("test26");

  const [turn, setTurn] = useState(1);
  const [headStartTurnsLeft, setHeadStartTurnsLeft] = useState(3);

  const [players, setPlayers] = useState([]);
  const [activeId, setActiveId] = useState("R1");
  const [gameStarted, setGameStarted] = useState(false);
  const [runnerCount, setRunnerCount] = useState(1);
  const [privacyMode, setPrivacyMode] = useState(true);
  const [handover, setHandover] = useState(null);
  const [gameOver, setGameOver] = useState(null);
  const [turnLimit, setTurnLimit] = useState(20);
  const [animTick, setAnimTick] = useState(null);

  const [setupPlayers, setSetupPlayers] = useState([
    { id: "H", name: "Hunter", token: "H", role: "HUNTER", classKey: "STANDARD" },
    { id: "R1", name: "Runner 1", token: "R", role: "RUNNER", classKey: "STANDARD" },
  ]);

  // Returns the first player who still needs to plan this turn (runners before hunter).
  function getNextPlanner(currentPlayers, currentHeadStart) {
    const eligible = currentPlayers.filter(
      (p) => !(p.role === "HUNTER" && currentHeadStart > 0) && !p.ready
    );
    const runners = eligible.filter((p) => p.role === "RUNNER");
    const hunters = eligible.filter((p) => p.role === "HUNTER");
    return [...runners, ...hunters][0] ?? null;
  }

  function startGameFromSetup() {
    if (!map) return;

    const hunterSetup = setupPlayers.find((p) => p.id === "H");
    const runnerSetups = setupPlayers.filter((p) => p.role === "RUNNER");

    const hunterInfo = CLASSES[hunterSetup.classKey] ?? CLASSES.STANDARD;

    const initialPlayers = [
      {
        id: hunterSetup.id,
        name: hunterSetup.name,
        token: hunterSetup.token,
        role: "HUNTER",
        classKey: hunterSetup.classKey,
        x: startPos.x,
        y: startPos.y,
        facing: 0,
        stamina: hunterInfo.staminaMax,
        path: [],
        ready: false,
      },
    ];

    for (const runner of runnerSetups) {
      const info = CLASSES[runner.classKey] ?? CLASSES.STANDARD;
      const spawn = findSpawn(initialPlayers, map, startPos, 3);

      initialPlayers.push({
        id: runner.id,
        name: runner.name,
        token: runner.token,
        role: "RUNNER",
        classKey: runner.classKey,
        x: spawn.x,
        y: spawn.y,
        facing: 180,
        stamina: info.staminaMax,
        path: [],
        ready: false,
      });
    }

    const firstPlanner = getNextPlanner(initialPlayers, 3);
    const firstId = firstPlanner?.id ?? runnerSetups[0]?.id ?? "H";

    setPlayers(initialPlayers);
    setTurn(1);
    setHeadStartTurnsLeft(3);
    setActiveId(firstId);
    setGameStarted(true);

    if (privacyMode && firstPlanner) {
      setHandover({ toId: firstId, toPlayer: firstPlanner });
    }
  }

  function canActThisTurn(p) {
    return !(p.role === "HUNTER" && headStartTurnsLeft > 0);
  }

  function setPlayerReady(playerId, readyValue) {
    setPlayers((prev) =>
      prev.map((p) => (p.id === playerId ? { ...p, ready: readyValue } : p))
    );
  }

  // Used by the Ready button. In privacy mode, also queues the handover screen.
  function handleReadyActive() {
    const updatedPlayers = players.map((p) =>
      p.id === activeId ? { ...p, ready: true } : p
    );
    setPlayers(updatedPlayers);

    if (privacyMode) {
      const next = getNextPlanner(updatedPlayers, headStartTurnsLeft);
      if (next) {
        setHandover({ toId: next.id, toPlayer: next });
      }
    }
  }

  function handleReveal() {
    setActiveId(handover.toId);
    setHandover(null);
  }

  function updateRunnerCount(count) {
    const clamped = Math.max(1, Math.min(5, Number(count) || 1));
    setRunnerCount(clamped);

    setSetupPlayers((prev) => {
      const hunter = prev.find((p) => p.id === "H") || {
        id: "H",
        name: "Hunter",
        token: "H",
        role: "HUNTER",
        classKey: "STANDARD",
      };

      const runners = [];
      for (let i = 1; i <= clamped; i++) {
        const existing = prev.find((p) => p.id === `R${i}`);
        runners.push(
          existing || {
            id: `R${i}`,
            name: `Runner ${i}`,
            token: `${i}`,
            role: "RUNNER",
            classKey: "STANDARD",
          }
        );
      }

      return [hunter, ...runners];
    });
  }

  function updateSetupPlayer(playerId, field, value) {
    setSetupPlayers((prev) =>
      prev.map((p) =>
        p.id === playerId
          ? {
              ...p,
              [field]:
                field === "token" ? value.toUpperCase().slice(0, 1) : value,
            }
          : p
      )
    );
  }

  function clearPath(playerId) {
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, path: [] } : p)));
  }

  function setPlayerClass(playerId, classKey) {
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== playerId) return p;
        const info = CLASSES[classKey] ?? CLASSES.STANDARD;
        return {
          ...p,
          classKey,
          stamina: Math.min(info.staminaMax, p.stamina),
          path: p.path.slice(0, info.maxSteps),
        };
      })
    );
  }

  function tryAddStepForActive(toX, toY) {
    if (!map) return;
    const p = activePlayer;
    if (!p) return;
    if (p.ready) return;
    if (!canActThisTurn(p)) return;

    const classInfo = CLASSES[p.classKey] ?? CLASSES.STANDARD;
    const maxSteps = classInfo.maxSteps;
    if (p.path.length >= maxSteps) return;

    const last = p.path.length ? p.path[p.path.length - 1] : { x: p.x, y: p.y };

    const dx = toX - last.x;
    const dy = toY - last.y;

    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) return;
    if (dx === 0 && dy === 0) return;
    if (!canMoveTo(last.x, last.y, toX, toY, map)) return;

    const nextPlannedSteps = p.path.length + 1;
    const nextCost = plannedCost(p.classKey, nextPlannedSteps);
    if (nextCost > p.stamina) return;

    let angle = p.facing;
    if (dx === 1 && dy === 0) angle = 0;
    else if (dx === -1 && dy === 0) angle = 180;
    else if (dx === 0 && dy === 1) angle = 90;
    else if (dx === 0 && dy === -1) angle = -90;
    else if (dx === 1 && dy === 1) angle = 45;
    else if (dx === -1 && dy === 1) angle = 135;
    else if (dx === 1 && dy === -1) angle = -45;
    else if (dx === -1 && dy === -1) angle = -135;

    setPlayers((prev) =>
      prev.map((q) =>
        q.id !== p.id
          ? q
          : {
              ...q,
              facing: angle,
              path: [...q.path, { x: toX, y: toY }],
            }
      )
    );
  }

  const allEligiblePlayersReady =
    players.length > 0 &&
    players.filter((p) => canActThisTurn(p)).every((p) => p.ready);

  useEffect(() => {
    (async () => {
      try {
        const selectedMap = MAPS.find((m) => m.key === selectedMapKey) ?? MAPS[0];
        const r = await fetch(selectedMap.file, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
        const data = await r.json();
        setMap(data);

        const hx = data.start?.hunter?.x ?? 13;
        const hy = data.start?.hunter?.y ?? 13;
        const start = { x: hx, y: hy };
        setStartPos(start);

        setPlayers([]);
        setTurn(1);
        setHeadStartTurnsLeft(3);
        setActiveId("R1");
        setGameStarted(false);
        setHandover(null);
        setGameOver(null);
        setAnimTick(null);
      } catch (e) {
        setError(String(e?.message || e));
      }
    })();
  }, [selectedMapKey]);

  const activePlayer = players.find((p) => p.id === activeId);

  useEffect(() => {
    const handler = (e) => {
      if (!map) return;
      const dir = directions[e.key.toLowerCase()];
      if (!dir) return;

      const p = activePlayer;
      if (!p) return;
      if (p.ready) return;
      if (!canActThisTurn(p)) return;

      const last = p.path.length ? p.path[p.path.length - 1] : { x: p.x, y: p.y };
      const nx = last.x + dir.dx;
      const ny = last.y + dir.dy;

      tryAddStepForActive(nx, ny);
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [map, activePlayer, headStartTurnsLeft]);

  function restartGame() {
    setGameStarted(false);
    setPlayers([]);
    setTurn(1);
    setHeadStartTurnsLeft(3);
    setActiveId("R1");
    setHandover(null);
    setGameOver(null);
    setAnimTick(null);
  }

  function addRunner() {
    if (!map) return;

    setPlayers((prev) => {
      const currentRunnerCount = prev.filter((p) => p.id.startsWith("R")).length;
      if (currentRunnerCount >= 5) return prev;

      const used = new Set(prev.map((p) => p.id));
      let n = 1;
      while (used.has(`R${n}`) && n <= 5) n++;
      if (n > 5) return prev;

      const spawn = findSpawn(prev, map, startPos, 3);

      return [
        ...prev,
        {
          id: `R${n}`,
          name: `Runner ${n}`,
          token: `${n}`,
          role: "RUNNER",
          classKey: "STANDARD",
          x: spawn.x,
          y: spawn.y,
          facing: 180,
          stamina: CLASSES.STANDARD.staminaMax,
          path: [],
          ready: false,
        },
      ];
    });
  }

  function handleResolveTurn() {
    if (!map) return;
    const { players: finalPlayers, tickSnapshots } = resolveTurn(players, map, headStartTurnsLeft);
    const newHeadStart = Math.max(0, headStartTurnsLeft - 1);
    const newTurn = turn + 1;
    // Start animation; the useEffect below applies final state once all frames play.
    setAnimTick({ snapshots: tickSnapshots, currentIndex: 0, finalPlayers, newHeadStart, newTurn });
  }

  // Step through animation frames at 300 ms each, then commit the final resolved state.
  useEffect(() => {
    if (!animTick) return;

    if (animTick.currentIndex >= animTick.snapshots.length) {
      const { finalPlayers, newHeadStart, newTurn } = animTick;
      setPlayers(finalPlayers);
      setTurn(newTurn);
      setHeadStartTurnsLeft(newHeadStart);
      setAnimTick(null);

      const allCaught = finalPlayers.every((p) => p.role === "HUNTER");
      if (allCaught) {
        setGameOver({ winner: "HUNTER", turn: newTurn });
      } else if (newTurn > turnLimit) {
        setGameOver({ winner: "RUNNER", turn: newTurn });
      } else if (privacyMode) {
        const next = getNextPlanner(finalPlayers, newHeadStart);
        if (next) setHandover({ toId: next.id, toPlayer: next });
      }
      return;
    }

    const timer = setTimeout(() => {
      setAnimTick((prev) => prev && { ...prev, currentIndex: prev.currentIndex + 1 });
    }, 300);

    return () => clearTimeout(timer);
  }, [animTick]);

  // During animation use the current frame's positions; otherwise use settled state.
  const isAnimating = animTick !== null;
  const displayPlayers = isAnimating
    ? (animTick.snapshots[animTick.currentIndex] ?? players)
    : players;
  const activeDisplayPlayer = displayPlayers.find((p) => p.id === activeId);

  const visible = useMemo(() => {
    if (!map || !activeDisplayPlayer) return new Set();
    // During animation just show vision from current position (no path lookahead).
    if (isAnimating) {
      return computeVisible(
        activeDisplayPlayer.x,
        activeDisplayPlayer.y,
        activeDisplayPlayer.facing,
        map
      );
    }
    return computeVisibleAlongPath(activeDisplayPlayer, map);
  }, [map, activeDisplayPlayer, isAnimating]);

  // During animation reveal everyone (it's the shared replay moment).
  // In privacy mode outside animation, hide opponents not in vision.
  function shouldShowToken(p) {
    if (!privacyMode || isAnimating) return true;
    if (p.id === activeId) return true;
    return visible.has(`${p.x},${p.y}`);
  }

  // Hand off to the online flow for menu + multiplayer screens.
  if (gameMode !== "local") {
    return <OnlineFlow onPlayLocal={() => setGameMode("local")} />;
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: "crimson", fontFamily: "system-ui" }}>
        Error: {error}
      </div>
    );
  }

  if (!map) {
    return <div style={{ padding: 16, fontFamily: "system-ui" }}>Loading map…</div>;
  }

  if (!gameStarted) {
    return (
      <div style={{ padding: 20, fontFamily: "system-ui", maxWidth: 900 }}>
        <h2>Manhunt Setup</h2>

        <div style={{ marginBottom: 12 }}>
          <label>
            <b>Map:</b>{" "}
            <select
              value={selectedMapKey}
              onChange={(e) => setSelectedMapKey(e.target.value)}
            >
              {MAPS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label>
            <b>Number of runners:</b>{" "}
            <select
              value={runnerCount}
              onChange={(e) => updateRunnerCount(e.target.value)}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label>
            <b>Turn limit:</b>{" "}
            <select
              value={turnLimit}
              onChange={(e) => setTurnLimit(Number(e.target.value))}
            >
              {[15, 20, 25].map((n) => (
                <option key={n} value={n}>
                  {n} turns
                </option>
              ))}
            </select>
          </label>
          <span style={{ marginLeft: 10, fontSize: 13, color: "#777" }}>
            Runners win if they survive this many turns
          </span>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {setupPlayers.map((p) => (
            <div
              key={p.id}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 12,
                background: "white",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8 }}>
                {p.role === "HUNTER" ? "Hunter" : p.name}
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label>
                  Name:{" "}
                  <input
                    value={p.name}
                    onChange={(e) =>
                      updateSetupPlayer(p.id, "name", e.target.value)
                    }
                  />
                </label>

                <label>
                  Token:{" "}
                  <input
                    value={p.token}
                    maxLength={1}
                    onChange={(e) =>
                      updateSetupPlayer(p.id, "token", e.target.value)
                    }
                    style={{ width: 32, textAlign: "center" }}
                  />
                </label>

                <label>
                  Class:{" "}
                  <select
                    value={p.classKey}
                    onChange={(e) =>
                      updateSetupPlayer(p.id, "classKey", e.target.value)
                    }
                  >
                    {Object.entries(CLASSES).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16 }}>
          <label>
            <input
              type="checkbox"
              checked={privacyMode}
              onChange={(e) => setPrivacyMode(e.target.checked)}
            />
            {" "}Hotseat privacy mode (hide opponent positions, handover screen between players)
          </label>
        </div>

        <div style={{ marginTop: 20 }}>
          <button onClick={startGameFromSetup}>Start Game</button>
        </div>
      </div>
    );
  }

  // Game-over screen — hunters win (all caught) or runners win (turn limit survived).
  if (gameOver) {
    const huntersWon = gameOver.winner === "HUNTER";
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: huntersWon ? "#1a0000" : "#00141a",
          fontFamily: "system-ui",
          color: "white",
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: huntersWon ? "#ef9a9a" : "#80cbc4",
            textTransform: "uppercase",
            letterSpacing: 3,
          }}
        >
          Game Over
        </div>
        <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1 }}>
          {huntersWon ? "Hunters Win" : "Runners Win"}
        </div>
        <div style={{ fontSize: 16, color: "#bbb", marginTop: 4 }}>
          {huntersWon
            ? `All runners caught on turn ${gameOver.turn - 1}`
            : `Survived all ${turnLimit} turns`}
        </div>
        <button
          onClick={restartGame}
          style={{
            marginTop: 32,
            padding: "14px 36px",
            fontSize: 16,
            fontWeight: 700,
            background: huntersWon ? "#b71c1c" : "#00695c",
            color: "white",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Play Again
        </button>
      </div>
    );
  }

  // Handover screen — shown between planning phases when privacy mode is on.
  if (handover) {
    const { toPlayer } = handover;
    const isHunter = toPlayer.role === "HUNTER";
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#111",
          fontFamily: "system-ui",
          color: "white",
          gap: 20,
        }}
      >
        <div
          style={{
            fontSize: 13,
            color: "#888",
            textTransform: "uppercase",
            letterSpacing: 3,
          }}
        >
          Pass device to
        </div>
        <div style={{ fontSize: 52, fontWeight: 800, lineHeight: 1 }}>
          {toPlayer.name}
        </div>
        <div
          style={{
            fontSize: 13,
            color: isHunter ? "#ef9a9a" : "#90caf9",
            textTransform: "uppercase",
            letterSpacing: 3,
          }}
        >
          {toPlayer.role}
        </div>
        <button
          onClick={handleReveal}
          style={{
            marginTop: 24,
            padding: "14px 36px",
            fontSize: 16,
            fontWeight: 700,
            background: isHunter ? "#b71c1c" : "#0d47a1",
            color: "white",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          I'm {toPlayer.name} — Reveal Board
        </button>
        <button
          onClick={restartGame}
          style={{
            marginTop: 8,
            padding: "8px 20px",
            fontSize: 13,
            background: "transparent",
            color: "#555",
            border: "1px solid #333",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Restart Game
        </button>
      </div>
    );
  }

  const playersAt = new Map();
  for (const p of displayPlayers) {
    playersAt.set(`${p.x},${p.y}`, p);
  }

  return (
    <div style={{ display: "flex", gap: 16, padding: 12, fontFamily: "system-ui" }}>
      <div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${map.width}, ${TILE_SIZE}px)`,
          }}
        >
          {map.tiles.flatMap((row, y) =>
            row.map((tile, x) => {
              const key = `${x},${y}`;
              const isVisible = visible.has(key);

              let bg = "#f3f3f3";
              if (tile === "BLOCK") bg = "#000000";
              if (tile === "NETTLES") bg = "#f4a742";
              if (tile === "TREE") bg = "#4caf50";

              const occupant = playersAt.get(key);
              const showOccupant = occupant && shouldShowToken(occupant);

              const plannedIndex =
                !isAnimating && activeDisplayPlayer && !activeDisplayPlayer.ready
                  ? activeDisplayPlayer.path.findIndex((s) => s.x === x && s.y === y)
                  : -1;

              const showPlanned = plannedIndex !== -1;

              if (showPlanned) {
                bg = activeDisplayPlayer.role === "HUNTER" ? "#9c27b0" : "#00bcd4";
              }

              return (
                <div
                  key={key}
                  onClick={() => tryAddStepForActive(x, y)}
                  style={{
                    width: TILE_SIZE,
                    height: TILE_SIZE,
                    background: bg,
                    border: "1px solid #bdbdbd",
                    position: "relative",
                    cursor: "pointer",
                  }}
                >
                  {!isVisible && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(0,0,0,0.35)",
                      }}
                    />
                  )}
                  {showPlanned && !showOccupant && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontSize: 12,
                        fontWeight: 800,
                        pointerEvents: "none",
                      }}
                    >
                      {plannedIndex + 1}
                    </div>
                  )}
                  {showOccupant && (
                    <div
                      title={`${occupant.name} (${occupant.role})`}
                      style={{
                        position: "absolute",
                        inset: 3,
                        borderRadius: 999,
                        background:
                          occupant.role === "HUNTER" ? "#ff2d2d" : "#1976d2",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "white",
                        fontSize: 12,
                        fontWeight: 800,
                      }}
                    >
                      {occupant.token || (occupant.role === "HUNTER" ? "H" : "R")}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={handleResolveTurn} disabled={!allEligiblePlayersReady || isAnimating}>
            Resolve Turn
          </button>

          <button onClick={restartGame} disabled={isAnimating}>Restart Game</button>

          {!privacyMode && <button onClick={addRunner} disabled={isAnimating}>Add Runner</button>}

          {activePlayer && (
            <>
              <button
                onClick={() => clearPath(activePlayer.id)}
                disabled={activePlayer.ready || isAnimating}
              >
                Clear Path
              </button>

              <button
                onClick={handleReadyActive}
                disabled={activePlayer.ready || !canActThisTurn(activePlayer) || isAnimating}
              >
                Ready
              </button>

              {!privacyMode && (
                <button
                  onClick={() => setPlayerReady(activePlayer.id, false)}
                  disabled={!activePlayer.ready || !canActThisTurn(activePlayer) || isAnimating}
                >
                  Unready
                </button>
              )}
            </>
          )}
        </div>

        {isAnimating && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#888" }}>
            Resolving turn…{" "}
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {animTick.currentIndex}/{animTick.snapshots.length}
            </span>
          </div>
        )}

        {activePlayer && !activePlayer.ready && canActThisTurn(activePlayer) && (
          <div style={{ marginTop: 14 }}>
            {(() => {
              const info = CLASSES[activePlayer.classKey] ?? CLASSES.STANDARD;
              const stepsLeft = info.maxSteps - activePlayer.path.length;
              const cost = plannedCost(activePlayer.classKey, activePlayer.path.length);
              const staminaAfter = activePlayer.stamina - cost;
              return (
                <div style={{ fontSize: 12, color: "#555", marginBottom: 8 }}>
                  Steps left: <b>{stepsLeft}</b>
                  {" · "}Stamina: <b>{staminaAfter}/{info.staminaMax}</b>
                  {" · "}{activePlayer.name}
                </div>
              );
            })()}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 56px)",
                gridTemplateRows: "repeat(3, 56px)",
                gap: 4,
                width: "fit-content",
              }}
            >
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
                <button
                  key={label}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    const last = activePlayer.path.length
                      ? activePlayer.path[activePlayer.path.length - 1]
                      : { x: activePlayer.x, y: activePlayer.y };
                    tryAddStepForActive(last.x + dx, last.y + dy);
                  }}
                  style={{
                    gridColumn: col,
                    gridRow: row,
                    width: 56,
                    height: 56,
                    fontSize: 22,
                    background: activePlayer.role === "HUNTER" ? "#4a0000" : "#002040",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    userSelect: "none",
                    touchAction: "manipulation",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ minWidth: 380 }}>
        <h3 style={{ marginTop: 0 }}>Manhunt – Hotseat</h3>

        <div>
          <b>Turn:</b> {turn} / {turnLimit}
          {turn > turnLimit * 0.75 && turn <= turnLimit && (
            <span style={{ marginLeft: 8, color: "#e65100", fontSize: 13 }}>
              ({turnLimit - turn} left)
            </span>
          )}
        </div>
        <div>
          <b>Head start turns left:</b> {headStartTurnsLeft}
        </div>

        <div style={{ marginTop: 10 }}>
          <label>
            <b>Map:</b>{" "}
            <select
              value={selectedMapKey}
              onChange={(e) => setSelectedMapKey(e.target.value)}
            >
              {MAPS.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <label>
            <input
              type="checkbox"
              checked={privacyMode}
              onChange={(e) => setPrivacyMode(e.target.checked)}
            />
            {" "}Privacy mode
          </label>
        </div>

        {privacyMode ? (
          <div style={{ marginTop: 10, color: "#555" }}>
            <b>Planning:</b> {activePlayer?.name}{" "}
            <span style={{ color: activePlayer?.role === "HUNTER" ? "#b71c1c" : "#1565c0" }}>
              ({activePlayer?.role})
            </span>
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <label>
              <b>Planning for:</b>{" "}
              <select value={activeId} onChange={(e) => setActiveId(e.target.value)}>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.role})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <p style={{ marginTop: 10, color: "#555" }}>
          WASD / Q E Z C to move. Click adjacent squares to build a path.
        </p>

        <h4>Players</h4>
        <div style={{ display: "grid", gap: 10 }}>
          {players
            .filter((p) => !privacyMode || p.id === activeId)
            .map((p) => {
              const info = CLASSES[p.classKey] ?? CLASSES.STANDARD;
              const maxSteps = info.maxSteps;
              const cost = plannedCost(p.classKey, p.path.length);
              const recIfEndNow = recoveryFor(p.classKey, p.path.length);

              return (
                <div
                  key={p.id}
                  style={{
                    padding: 10,
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    background: p.id === activeId ? "#fafafa" : "white",
                    color: "#111",
                  }}
                >
                  <div style={{ fontWeight: 800 }}>
                    {p.name} — {p.role}
                  </div>

                  <div style={{ marginTop: 4, color: p.ready ? "#2e7d32" : "#8a6d3b" }}>
                    {canActThisTurn(p)
                      ? p.ready
                        ? "Ready"
                        : "Not Ready"
                      : "Waiting (head start)"}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: 12,
                      flexWrap: "wrap",
                      marginTop: 6,
                    }}
                  >
                    <div>Pos: {p.x}, {p.y}</div>
                    <div>Stamina: {p.stamina}/{info.staminaMax}</div>
                    <div>Planned: {p.path.length}/{maxSteps}</div>
                  </div>

                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <label>
                      Class:{" "}
                      <select
                        value={p.classKey}
                        onChange={(e) => setPlayerClass(p.id, e.target.value)}
                      >
                        {Object.entries(CLASSES).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Token:{" "}
                      <input
                        value={p.token || ""}
                        maxLength={1}
                        onChange={(e) => {
                          const value = e.target.value.toUpperCase().slice(0, 1);
                          setPlayers((prev) =>
                            prev.map((q) =>
                              q.id === p.id ? { ...q, token: value } : q
                            )
                          );
                        }}
                        style={{ width: 32, textAlign: "center" }}
                      />
                    </label>
                  </div>

                  <div style={{ marginTop: 6, color: "#333" }}>
                    Stamina cost: <b>{cost}</b>{" "}
                    • Recovery if done now: <b>{recIfEndNow}</b>
                  </div>

                  {p.role === "HUNTER" && headStartTurnsLeft > 0 && (
                    <div style={{ color: "#b71c1c", marginTop: 6 }}>
                      Hunter cannot move yet (head start)
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
