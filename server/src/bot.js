import { canMoveTo, tileBlocksMove } from "./game/map.js";
import { computeVisible } from "./game/vision.js";
import { plannedCost } from "./game/stamina.js";
import { CLASSES } from "./game/constants.js";

const DIRS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],           [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

// BFS: returns first step from (x,y) toward (tx,ty), or null if unreachable.
function stepToward(x, y, tx, ty, map) {
  if (x === tx && y === ty) return null;
  const queue = [[x, y, null]];
  const visited = new Set([`${x},${y}`]);
  while (queue.length) {
    const [cx, cy, first] = queue.shift();
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      if (!canMoveTo(cx, cy, nx, ny, map)) continue;
      const step = first ?? { x: nx, y: ny };
      if (nx === tx && ny === ty) return step;
      visited.add(key);
      queue.push([nx, ny, step]);
    }
  }
  return null;
}

// Greedy 1-step flee: maximises min-distance from a list of threat positions.
function fleeStep(x, y, threats, map) {
  let best = null, bestScore = -Infinity;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (!canMoveTo(x, y, nx, ny, map)) continue;
    const minDist = Math.min(...threats.map((e) => manhattan(nx, ny, e.x, e.y)));
    if (minDist > bestScore) { bestScore = minDist; best = { x: nx, y: ny }; }
  }
  return best;
}

// Random valid step.
function wander(x, y, map) {
  const opts = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (canMoveTo(x, y, nx, ny, map)) opts.push({ x: nx, y: ny });
  }
  return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
}

// BFS flood-fill: return the reachable tile that maximises min-manhattan-distance
// from all threat positions. Runners use this to pick a safe destination for the
// whole turn rather than making greedy 1-step decisions.
function bestFleeDest(x, y, threats, map) {
  const visited = new Set([`${x},${y}`]);
  const queue = [[x, y]];
  let bestTile = { x, y };
  let bestScore = Math.min(...threats.map((e) => manhattan(x, y, e.x, e.y)));

  while (queue.length) {
    const [cx, cy] = queue.shift();
    const score = Math.min(...threats.map((e) => manhattan(cx, cy, e.x, e.y)));
    if (score > bestScore) { bestScore = score; bestTile = { x: cx, y: cy }; }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      const key = `${nx},${ny}`;
      if (!visited.has(key) && canMoveTo(cx, cy, nx, ny, map)) {
        visited.add(key);
        queue.push([nx, ny]);
      }
    }
  }
  return bestTile;
}

// Pick a patrol waypoint at least half the map's span away from (x, y).
// Hunters use this to sweep the map when they have no intel on runners.
function pickPatrolTarget(x, y, map) {
  const minDist = Math.floor(Math.min(map.width, map.height) / 2);
  const far = [];
  const fallback = [];
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (tileBlocksMove(map.tiles[ty][tx])) continue;
      if (tx === x && ty === y) continue;
      const d = manhattan(x, y, tx, ty);
      if (d >= minDist) far.push({ x: tx, y: ty });
      else fallback.push({ x: tx, y: ty });
    }
  }
  const pool = far.length ? far : fallback;
  return pool[Math.floor(Math.random() * pool.length)] ?? { x, y };
}

// Returns a path array for the bot player. Uses roomPlayer.botMemory for
// cross-turn state (last-known enemy positions + hunter patrol target).
export function chooseBotPath(room, playerId) {
  const gs = room.gameState;
  if (!gs) return [];
  const { map } = gs;

  const gsPlayer = gs.players.find((p) => p.id === playerId);
  const roomPlayer = room.players.find((p) => p.id === playerId);
  if (!gsPlayer || !roomPlayer) return [];

  console.log(`[bot] chooseBotPath ${playerId} role=${gsPlayer.role} x=${gsPlayer.x} y=${gsPlayer.y} stamina=${gsPlayer.stamina}`);

  const classInfo = CLASSES[gsPlayer.classKey] ?? CLASSES.STANDARD;
  if (!roomPlayer.botMemory) roomPlayer.botMemory = {};
  const mem = roomPlayer.botMemory;
  // "_patrol" is a reserved key for hunter patrol waypoints; all other keys are
  // enemy player IDs mapped to their last-known {x, y} position.

  const visKeys = computeVisible(gsPlayer.x, gsPlayer.y, gsPlayer.facing, map);
  const visibleEnemies = gs.players.filter(
    (p) => p.role !== gsPlayer.role && visKeys.has(`${p.x},${p.y}`)
  );

  for (const e of visibleEnemies) mem[e.id] = { x: e.x, y: e.y };

  // For runners: compute a safe destination once for the whole turn.
  // For hunters: destination changes per-step (chasing / patrolling).
  let runnerDest = null;
  if (gsPlayer.role === "RUNNER") {
    const threats = visibleEnemies.length
      ? visibleEnemies
      : Object.entries(mem)
          .filter(([k]) => k !== "_patrol")
          .map(([, pos]) => pos);
    if (threats.length) {
      runnerDest = bestFleeDest(gsPlayer.x, gsPlayer.y, threats, map);
    }
  }

  const path = [];
  let cx = gsPlayer.x, cy = gsPlayer.y;

  for (let step = 0; step < classInfo.maxSteps; step++) {
    if (plannedCost(gsPlayer.classKey, step + 1) > gsPlayer.stamina) break;

    let next = null;

    if (gsPlayer.role === "HUNTER") {
      if (visibleEnemies.length) {
        // Chase the nearest visible runner.
        const target = visibleEnemies.reduce((a, b) =>
          manhattan(cx, cy, a.x, a.y) <= manhattan(cx, cy, b.x, b.y) ? a : b
        );
        next = stepToward(cx, cy, target.x, target.y, map);
      } else {
        // Move toward last-known enemy position; clear once arrived.
        const knownId = Object.keys(mem).find((k) => k !== "_patrol");
        if (knownId) {
          const pos = mem[knownId];
          if (cx === pos.x && cy === pos.y) {
            delete mem[knownId];
          } else {
            next = stepToward(cx, cy, pos.x, pos.y, map);
          }
        }
        // No intel — patrol toward a distant waypoint.
        if (!next) {
          if (!mem._patrol || (cx === mem._patrol.x && cy === mem._patrol.y)) {
            mem._patrol = pickPatrolTarget(cx, cy, map);
          }
          next = stepToward(cx, cy, mem._patrol.x, mem._patrol.y, map)
            ?? wander(cx, cy, map);
        }
      }
    } else {
      // RUNNER: navigate toward the pre-computed safe destination.
      if (runnerDest) {
        next = stepToward(cx, cy, runnerDest.x, runnerDest.y, map)
          ?? fleeStep(cx, cy,
              visibleEnemies.length
                ? visibleEnemies
                : Object.entries(mem).filter(([k]) => k !== "_patrol").map(([, p]) => p),
              map);
      } else {
        next = wander(cx, cy, map);
      }
    }

    if (!next) break;
    path.push(next);
    cx = next.x;
    cy = next.y;
  }

  return path;
}
