export function inBounds(x, y, map) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function blocksVision(tile) {
  return tile === "BLOCK" || tile === "TREE";
}

export function tileBlocksMove(tile) {
  return tile === "BLOCK" || tile === "NETTLES" || tile === "TREE";
}

export function canMoveTo(fromX, fromY, toX, toY, map) {
  if (!inBounds(toX, toY, map)) return false;

  const targetTile = map.tiles[toY][toX];
  if (tileBlocksMove(targetTile)) return false;

  const dx = toX - fromX;
  const dy = toY - fromY;

  if (dx === 0 || dy === 0) return true;

  const side1X = fromX + dx;
  const side1Y = fromY;
  const side2X = fromX;
  const side2Y = fromY + dy;

  if (!inBounds(side1X, side1Y, map) || !inBounds(side2X, side2Y, map)) {
    return false;
  }

  const side1Tile = map.tiles[side1Y][side1X];
  const side2Tile = map.tiles[side2Y][side2X];

  if (tileBlocksMove(side1Tile) || tileBlocksMove(side2Tile)) {
    return false;
  }

  return true;
}
