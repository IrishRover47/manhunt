export const TILE_SIZE = 22;
export const BASE_MAX_STEPS = 6;
export const MAX_VISION_DISTANCE = 12;

export const directions = {
  w: { dx: 0, dy: -1, angle: -90 },
  s: { dx: 0, dy: 1, angle: 90 },
  a: { dx: -1, dy: 0, angle: 180 },
  d: { dx: 1, dy: 0, angle: 0 },
  q: { dx: -1, dy: -1, angle: -135 },
  e: { dx: 1, dy: -1, angle: -45 },
  z: { dx: -1, dy: 1, angle: 135 },
  c: { dx: 1, dy: 1, angle: 45 },
};

export const CLASSES = {
  STANDARD: { name: "Standard", staminaMax: 24, maxSteps: 6 },
  SPRINTER: { name: "Sprinter", staminaMax: 20, maxSteps: 8 },
  ENDURANCE: { name: "Endurance", staminaMax: 20, maxSteps: 6 },
};

export const MAPS = [
  { key: "open26", name: "Open Test 26x26", file: "/manhunt_map_open_26.json" },
  { key: "test26", name: "Obstacle Test 26x26", file: "/manhunt_map_test_26.json" },
];
