import { BASE_MAX_STEPS } from "./constants.js";

export function plannedCost(playerClassKey, stepsPlanned) {
  if (playerClassKey === "SPRINTER") {
    if (stepsPlanned <= 6) return stepsPlanned;
    return 6 + 2 * (stepsPlanned - 6);
  }
  return stepsPlanned;
}

export function stepExecutionCost(playerClassKey, executedStepNumber) {
  if (playerClassKey === "SPRINTER" && executedStepNumber >= 7) return 2;
  return 1;
}

export function recoveryFor(playerClassKey, squaresMoved) {
  let base = Math.max(0, BASE_MAX_STEPS - squaresMoved);
  if (playerClassKey === "ENDURANCE" && squaresMoved >= 1 && squaresMoved <= 4) {
    base += 1;
  }
  return base;
}
