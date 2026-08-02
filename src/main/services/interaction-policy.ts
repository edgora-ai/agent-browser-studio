// Deterministic, bounded interaction policy for native CDP input. The same
// profile seed produces repeatable timing/path characteristics while each
// action advances an explicit counter. No page script or global prototype is
// modified by this module.

export interface InteractionPoint {
  x: number;
  y: number;
  delayMs: number;
}

function mix(seed: number, action: number, lane: number): number {
  let value = (seed ^ Math.imul(action + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function unit(seed: number, action: number, lane: number): number {
  return mix(seed, action, lane) / 0x100000000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildHumanizedPointerPath(
  seed: number,
  action: number,
  start: { x: number; y: number },
  target: { x: number; y: number },
): InteractionPoint[] {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return [{ x: target.x, y: target.y, delayMs: 8 }];

  const steps = clamp(Math.round(distance / 42) + 8 + Math.floor(unit(seed, action, 0) * 5), 8, 32);
  const normalX = -dy / distance;
  const normalY = dx / distance;
  const bend = (unit(seed, action, 1) * 2 - 1) * clamp(distance * 0.14, 8, 72);
  const forwardA = 0.24 + unit(seed, action, 2) * 0.14;
  const forwardB = 0.64 + unit(seed, action, 3) * 0.14;
  const controlA = {
    x: start.x + dx * forwardA + normalX * bend,
    y: start.y + dy * forwardA + normalY * bend,
  };
  const controlB = {
    x: start.x + dx * forwardB - normalX * bend * 0.45,
    y: start.y + dy * forwardB - normalY * bend * 0.45,
  };

  const points: InteractionPoint[] = [];
  for (let index = 1; index <= steps; index++) {
    const linear = index / steps;
    const t = linear * linear * (3 - 2 * linear);
    const inverse = 1 - t;
    const x = inverse ** 3 * start.x + 3 * inverse ** 2 * t * controlA.x +
      3 * inverse * t ** 2 * controlB.x + t ** 3 * target.x;
    const y = inverse ** 3 * start.y + 3 * inverse ** 2 * t * controlA.y +
      3 * inverse * t ** 2 * controlB.y + t ** 3 * target.y;
    points.push({
      x: index === steps ? target.x : Math.max(0, Math.round(x * 10) / 10),
      y: index === steps ? target.y : Math.max(0, Math.round(y * 10) / 10),
      // Pace distinct points across compositor frames. Faster bursts can be
      // coalesced while an otherwise valid managed window is occluded.
      delayMs: 22 + Math.floor(unit(seed, action, 10 + index) * 17),
    });
  }
  return points;
}

export function jitterInteractionTarget(
  seed: number,
  action: number,
  center: { x: number; y: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, Math.min(6, bounds.width * 0.16));
  const maxY = Math.max(0, Math.min(6, bounds.height * 0.16));
  return {
    x: Math.round((center.x + (unit(seed, action, 40) * 2 - 1) * maxX) * 10) / 10,
    y: Math.round((center.y + (unit(seed, action, 41) * 2 - 1) * maxY) * 10) / 10,
  };
}

export function buildHumanizedScrollDeltas(seed: number, action: number, amount: number): number[] {
  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.max(1, Math.round(Math.abs(amount)));
  const desiredSteps = clamp(5 + Math.floor(unit(seed, action, 50) * 7), 5, 11);
  const steps = Math.max(1, Math.min(magnitude, desiredSteps));
  const weights = Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / (steps + 1);
    return Math.sin(Math.PI * t) * (0.88 + unit(seed, action, 60 + index) * 0.24);
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const remaining = magnitude - steps;
  const rawExtras = weights.map((weight) => remaining * weight / totalWeight);
  const units = rawExtras.map((value) => 1 + Math.floor(value));
  let undistributed = magnitude - units.reduce((sum, value) => sum + value, 0);
  const remainderOrder = rawExtras
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < undistributed; index++) {
    units[remainderOrder[index % remainderOrder.length].index] += 1;
  }
  return units.map((value) => sign * value);
}

export function interactionDelay(seed: number, action: number, lane: number, minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.round(minMs));
  const max = Math.max(min, Math.round(maxMs));
  return min + Math.floor(unit(seed, action, lane) * (max - min + 1));
}
