import { describe, expect, it } from "vitest";
import {
  buildHumanizedPointerPath,
  buildHumanizedScrollDeltas,
  interactionDelay,
  jitterInteractionTarget,
} from "../../src/main/services/interaction-policy.js";

describe("seeded interaction policy", () => {
  it("builds a deterministic bounded pointer curve ending at the target", () => {
    const first = buildHumanizedPointerPath(424242, 1, { x: 20, y: 30 }, { x: 820, y: 460 });
    const repeat = buildHumanizedPointerPath(424242, 1, { x: 20, y: 30 }, { x: 820, y: 460 });
    expect(repeat).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(32);
    expect(first.at(-1)).toMatchObject({ x: 820, y: 460 });
    expect(first.every((point) => point.x >= 0 && point.y >= 0 && point.delayMs >= 5 && point.delayMs <= 13)).toBe(true);
    expect(new Set(first.map((point) => `${point.x},${point.y}`)).size).toBeGreaterThan(5);
  });

  it("changes path characteristics across profile seeds and action counters", () => {
    const base = buildHumanizedPointerPath(10, 1, { x: 0, y: 0 }, { x: 500, y: 300 });
    expect(buildHumanizedPointerPath(11, 1, { x: 0, y: 0 }, { x: 500, y: 300 })).not.toEqual(base);
    expect(buildHumanizedPointerPath(10, 2, { x: 0, y: 0 }, { x: 500, y: 300 })).not.toEqual(base);
  });

  it("jitters only inside the safe central area", () => {
    const target = jitterInteractionTarget(99, 3, { x: 100, y: 200 }, { width: 20, height: 10 });
    expect(Math.abs(target.x - 100)).toBeLessThanOrEqual(3.2);
    expect(Math.abs(target.y - 200)).toBeLessThanOrEqual(1.6);
    expect(jitterInteractionTarget(99, 3, { x: 100, y: 200 }, { width: 20, height: 10 })).toEqual(target);
  });

  it("produces a multi-step wheel gesture with an exact signed total", () => {
    for (const amount of [500, -731, 1]) {
      const deltas = buildHumanizedScrollDeltas(77, 4, amount);
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      expect(deltas.reduce((sum, value) => sum + value, 0)).toBe(amount);
      expect(deltas.every((value) => Math.sign(value) === Math.sign(amount))).toBe(true);
    }
  });

  it("keeps deterministic delays within their declared bounds", () => {
    const delay = interactionDelay(123, 7, 8, 18, 55);
    expect(delay).toBeGreaterThanOrEqual(18);
    expect(delay).toBeLessThanOrEqual(55);
    expect(interactionDelay(123, 7, 8, 18, 55)).toBe(delay);
  });
});
