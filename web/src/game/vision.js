import { MAX_VISION_DISTANCE } from "./constants.js";
import { inBounds, blocksVision } from "./map.js";

export function computeVisible(px, py, facingAngle, map, { rangeBonus = 0, omniscience = false } = {}) {
  if (omniscience) {
    const all = new Set();
    for (let y = 0; y < map.height; y++)
      for (let x = 0; x < map.width; x++)
        all.add(`${x},${y}`);
    return all;
  }

  const maxDist = MAX_VISION_DISTANCE + rangeBonus;
  const visible = new Set();
  const rad = (facingAngle * Math.PI) / 180;
  const fx = Math.cos(rad);
  const fy = Math.sin(rad);
  const cosHalfFov = Math.cos(Math.PI / 4);

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const vx = x - px;
      const vy = y - py;
      const dist = Math.hypot(vx, vy);

      if (dist > maxDist) continue;

      if (dist === 0) {
        visible.add(`${x},${y}`);
        continue;
      }

      // Always see all 8 immediately adjacent tiles regardless of facing.
      if (dist <= Math.SQRT2 + 0.01) {
        visible.add(`${x},${y}`);
        continue;
      }

      const dot = (vx * fx + vy * fy) / dist;
      if (dot < cosHalfFov) continue;

      const steps = Math.ceil(dist);
      let blocked = false;

      for (let i = 0; i <= steps; i++) {
        const rx = Math.round(px + (vx * i) / steps);
        const ry = Math.round(py + (vy * i) / steps);
        if (!inBounds(rx, ry, map)) break;

        const tile = map.tiles[ry][rx];
        if (blocksVision(tile) && !(rx === x && ry === y)) {
          blocked = true;
          break;
        }
      }

      if (!blocked) visible.add(`${x},${y}`);
    }
  }

  return visible;
}

export function computeVisibleAlongPath(player, map, visionOpts = {}) {
  const union = new Set();

  computeVisible(player.x, player.y, player.facing, map, visionOpts).forEach((k) => union.add(k));

  let prev = { x: player.x, y: player.y };
  let facing = player.facing;

  for (const step of player.path) {
    if (step.look) {
      facing = step.facing;
      computeVisible(prev.x, prev.y, facing, map, visionOpts).forEach((k) => union.add(k));
      continue;
    }

    const dx = step.x - prev.x;
    const dy = step.y - prev.y;

    if (dx === 1 && dy === 0) facing = 0;
    else if (dx === -1 && dy === 0) facing = 180;
    else if (dx === 0 && dy === 1) facing = 90;
    else if (dx === 0 && dy === -1) facing = -90;
    else if (dx === 1 && dy === 1) facing = 45;
    else if (dx === -1 && dy === 1) facing = 135;
    else if (dx === 1 && dy === -1) facing = -45;
    else if (dx === -1 && dy === -1) facing = -135;

    computeVisible(step.x, step.y, facing, map, visionOpts).forEach((k) => union.add(k));
    prev = step;
  }

  return union;
}
