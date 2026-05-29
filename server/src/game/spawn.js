import { tileBlocksMove } from "./map.js";

export function randChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function isAdjacent(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

export function isOccupied(x, y, list) {
  return list.some((p) => p.x === x && p.y === y);
}

export function inSpawnRadius(x, y, cx, cy, r) {
  return Math.max(Math.abs(x - cx), Math.abs(y - cy)) <= r;
}

export function findSpawn(occupiedList, mapData, center, radius = 3) {
  const candidates = [];
  for (let y = 0; y < mapData.height; y++) {
    for (let x = 0; x < mapData.width; x++) {
      if (!inSpawnRadius(x, y, center.x, center.y, radius)) continue;
      const tile = mapData.tiles[y][x];
      if (tileBlocksMove(tile)) continue;
      if (isOccupied(x, y, occupiedList)) continue;
      candidates.push({ x, y });
    }
  }
  return candidates.length ? randChoice(candidates) : center;
}
