import { canMoveTo } from "./game/map.js";
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

// BFS: returns the first step from (x,y) toward (tx,ty), or null if unreachable.
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

// Best step that maximises minimum distance from a list of enemies.
function fleeStep(x, y, enemies, map) {
  let best = null, bestScore = -Infinity;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (!canMoveTo(x, y, nx, ny, map)) continue;
    const minDist = Math.min(...enemies.map((e) => manhattan(nx, ny, e.x, e.y)));
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

// Returns a path array for the bot player. Uses room player for cross-turn memory.
export function chooseBotPath(room, playerId) {
  const gs = room.gameState;
  if (!gs) return [];
  const { map } = gs;

  const gsPlayer = gs.players.find((p) => p.id === playerId);
  const roomPlayer = room.players.find((p) => p.id === playerId);
  if (!gsPlayer || !roomPlayer) return [];

  const classInfo = CLASSES[gsPlayer.classKey] ?? CLASSES.STANDARD;
  if (!roomPlayer.botMemory) roomPlayer.botMemory = {};
  const mem = roomPlayer.botMemory; // { [enemyId]: {x, y} }

  // Only see what this bot can actually see — no cheating.
  const visKeys = computeVisible(gsPlayer.x, gsPlayer.y, gsPlayer.facing, map);
  const visibleEnemies = gs.players.filter(
    (p) => p.role !== gsPlayer.role && visKeys.has(`${p.x},${p.y}`)
  );

  // Update memory with any newly spotted enemies.
  for (const e of visibleEnemies) mem[e.id] = { x: e.x, y: e.y };

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
        // Move toward last-known position; clear entry once arrived.
        const knownId = Object.keys(mem)[0];
        if (knownId) {
          const pos = mem[knownId];
          if (cx === pos.x && cy === pos.y) {
            delete mem[knownId];
            next = wander(cx, cy, map);
          } else {
            next = stepToward(cx, cy, pos.x, pos.y, map);
          }
        } else {
          next = wander(cx, cy, map);
        }
      }
    } else {
      // RUNNER: flee visible hunters; otherwise wander.
      next = visibleEnemies.length
        ? fleeStep(cx, cy, visibleEnemies, map)
        : wander(cx, cy, map);
    }

    if (!next) break;
    path.push(next);
    cx = next.x;
    cy = next.y;
  }

  return path;
}
