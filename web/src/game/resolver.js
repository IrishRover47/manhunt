import { CLASSES } from "./constants.js";
import { canMoveTo } from "./map.js";
import { stepExecutionCost, recoveryFor } from "./stamina.js";
import { isAdjacent, randChoice } from "./spawn.js";

export function resolveTurn(players, map, headStartTurnsLeft) {
  const state = players.map((p) => ({
    ...p,
    movedSquaresThisTurn: 0,
    staminaSpentThisTurn: 0,
    stepIndex: 0,
    stopped: false,
    nextRole: p.role,
  }));

  const tickSnapshots = [];

  const maxTicks = Math.max(
    ...state.map((p) => (CLASSES[p.classKey] ?? CLASSES.STANDARD).maxSteps)
  );

  const byId = (id) => state.find((s) => s.id === id);
  const canMoveThisTurn = (p) => !(p.role === "HUNTER" && headStartTurnsLeft > 0);

  for (let tick = 0; tick < maxTicks; tick++) {
    const proposed = new Map();

    for (const p of state) {
      if (p.stopped) {
        proposed.set(p.id, null);
        continue;
      }
      if (!canMoveThisTurn(p)) {
        proposed.set(p.id, null);
        p.stopped = true;
        continue;
      }

      const classInfo = CLASSES[p.classKey] ?? CLASSES.STANDARD;

      // Look steps are instantaneous: apply facing change now, advance index, no tick cost.
      while (p.stepIndex < p.path.length && p.path[p.stepIndex]?.look) {
        p.facing = p.path[p.stepIndex].facing;
        p.stepIndex += 1;
      }

      if (p.stepIndex >= p.path.length) {
        proposed.set(p.id, null);
        continue;
      }
      // Gate on actual moves taken, not stepIndex (look steps don't count).
      if (p.movedSquaresThisTurn >= classInfo.maxSteps) {
        proposed.set(p.id, null);
        p.stopped = true;
        continue;
      }

      const nextExecutedStepNumber = p.movedSquaresThisTurn + 1;
      const cost = stepExecutionCost(p.classKey, nextExecutedStepNumber);
      if (p.stamina < cost) {
        proposed.set(p.id, null);
        p.stopped = true;
        continue;
      }

      const nextMove = { ...p.path[p.stepIndex] };

      if (!canMoveTo(p.x, p.y, nextMove.x, nextMove.y, map)) {
        proposed.set(p.id, null);
        p.stopped = true;
        continue;
      }

      proposed.set(p.id, nextMove);
    }

    const ids = state.map((p) => p.id);
    const swapped = new Set();

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = byId(ids[i]);
        const b = byId(ids[j]);
        const ap = proposed.get(a.id);
        const bp = proposed.get(b.id);
        if (!ap || !bp) continue;

        if (ap.x === b.x && ap.y === b.y && bp.x === a.x && bp.y === a.y) {
          swapped.add(a.id);
          swapped.add(b.id);
        }
      }
    }

    for (const id of swapped) {
      const p = byId(id);
      p.stopped = true;
      proposed.set(id, null);
    }

    // Block moves into squares occupied by players who aren't also moving away this tick.
    // A player whose proposal is null is stationary (done, blocked, or in head-start).
    for (const p of state) {
      const mv = proposed.get(p.id);
      if (!mv) continue;
      const stationaryOccupant = state.find(
        (q) => q.id !== p.id && q.x === mv.x && q.y === mv.y && !proposed.get(q.id)
      );
      if (stationaryOccupant) {
        proposed.set(p.id, null);
        p.stopped = true;
      }
    }

    const destGroups = new Map();
    for (const p of state) {
      const mv = proposed.get(p.id);
      if (!mv) continue;
      const key = `${mv.x},${mv.y}`;
      if (!destGroups.has(key)) destGroups.set(key, []);
      destGroups.get(key).push(p.id);
    }

    const winners = new Set();
    const losersStop = new Set();

    for (const [, group] of destGroups.entries()) {
      if (group.length === 1) {
        winners.add(group[0]);
        continue;
      }

      const contenders = group.map(byId);
      const allRunners = contenders.every((c) => c.role === "RUNNER");

      if (allRunners) {
        for (const id of group) losersStop.add(id);
        continue;
      }

      const maxStam = Math.max(...contenders.map((c) => c.stamina));
      let best = contenders.filter((c) => c.stamina === maxStam);

      if (best.length > 1) {
        const minMoved = Math.min(...best.map((c) => c.movedSquaresThisTurn));
        best = best.filter((c) => c.movedSquaresThisTurn === minMoved);
      }

      const winner = best.length === 1 ? best[0] : randChoice(best);
      winners.add(winner.id);

      for (const id of group) {
        if (id !== winner.id) losersStop.add(id);
      }
    }

    for (const p of state) {
      if (p.stopped) continue;

      const mv = proposed.get(p.id);
      if (!mv) continue;

      if (!winners.has(p.id)) {
        if (losersStop.has(p.id)) p.stopped = true;
        continue;
      }

      const executedStepNumber = p.movedSquaresThisTurn + 1;
      const cost = stepExecutionCost(p.classKey, executedStepNumber);

      const moveDx = mv.x - p.x;
      const moveDy = mv.y - p.y;
      p.x = mv.x;
      p.y = mv.y;
      p.facing = Math.atan2(moveDy, moveDx) * 180 / Math.PI;
      p.stamina = Math.max(0, p.stamina - cost);
      p.staminaSpentThisTurn += cost;
      p.movedSquaresThisTurn += 1;
      p.stepIndex += 1;
    }

    for (const id of losersStop) {
      const p = byId(id);
      if (p) p.stopped = true;
    }

    // Headstart hunters can't tag; all other hunters can, even if their last
    // step was blocked (e.g. by trying to step onto the runner's square).
    const hunters = state.filter((p) => p.role === "HUNTER" && canMoveThisTurn(p));
    const runners = state.filter((p) => p.role === "RUNNER");

    const tagEvents = [];
    for (const h of hunters) {
      for (const r of runners) {
        if (isAdjacent(h, r)) tagEvents.push({ hunterId: h.id, runnerId: r.id });
      }
    }

    if (tagEvents.length) {
      const byRunner = new Map();
      for (const e of tagEvents) {
        if (!byRunner.has(e.runnerId)) byRunner.set(e.runnerId, []);
        byRunner.get(e.runnerId).push(e.hunterId);
      }

      for (const [runnerId, hunterIds] of byRunner.entries()) {
        const r = byId(runnerId);
        const hs = hunterIds.map(byId).filter(Boolean);

        let best = hs;
        const maxStam = Math.max(...best.map((h) => h.stamina));
        best = best.filter((h) => h.stamina === maxStam);

        if (best.length > 1) {
          const minMoved = Math.min(...best.map((h) => h.movedSquaresThisTurn));
          best = best.filter((h) => h.movedSquaresThisTurn === minMoved);
        }

        const creditedHunter = best.length === 1 ? best[0] : randChoice(best);
        creditedHunter.stopped = true;
        r.stopped = true;
        r.nextRole = "HUNTER";
      }
    }

    // Snapshot positions after this tick so the client can animate step-by-step.
    tickSnapshots.push(
      state.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        facing: p.facing,
        role: p.nextRole,   // reflect tagging conversions immediately
        token: p.token,
        name: p.name,
        classKey: p.classKey,
        path: [],           // no planned path during animation
      }))
    );

    const anyoneActive = state.some((p) => {
      if (p.stopped) return false;
      if (!canMoveThisTurn(p)) return false;
      if (p.stepIndex >= p.path.length) return false;
      // Remaining path has only look steps — they'll be consumed next tick.
      if (p.path.slice(p.stepIndex).every((s) => s.look)) return true;
      const classInfo = CLASSES[p.classKey] ?? CLASSES.STANDARD;
      if (p.movedSquaresThisTurn >= classInfo.maxSteps) return false;
      const nextStepNum = p.movedSquaresThisTurn + 1;
      const cost = stepExecutionCost(p.classKey, nextStepNum);
      return p.stamina >= cost;
    });

    if (!anyoneActive) break;
  }

  const resolved = state.map((p) => {
    const classInfo = CLASSES[p.classKey] ?? CLASSES.STANDARD;
    const rec = recoveryFor(p.classKey, p.movedSquaresThisTurn);

    return {
      id: p.id,
      name: p.name,
      token: p.token,
      role: p.nextRole,
      classKey: p.classKey,
      x: p.x,
      y: p.y,
      facing: p.facing,
      stamina: Math.min(classInfo.staminaMax, p.stamina + rec),
      path: [],
      ready: false,
    };
  });

  return { players: resolved, tickSnapshots };
}
