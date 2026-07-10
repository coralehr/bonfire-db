/**
 * U-shape ordering (acceptance #5): against a fixture with a KNOWN salience
 * ranking (rank = input position), the emission puts rank 1 first, rank 2
 * last, rank 3 second, rank 4 second-to-last — highest salience at both edges,
 * the tail in the middle — and is deterministic (a pure function of order).
 */
import { describe, expect, test } from "bun:test";
import { orderUShape } from "./ushape.js";

describe("orderUShape", () => {
  test("known 5-rank fixture: [r1..r5] emits [r1, r3, r5, r4, r2]", () => {
    expect(orderUShape(["r1", "r2", "r3", "r4", "r5"])).toEqual(["r1", "r3", "r5", "r4", "r2"]);
  });

  test("known 6-rank fixture: even tail joins the back half in reverse", () => {
    expect(orderUShape(["r1", "r2", "r3", "r4", "r5", "r6"])).toEqual([
      "r1",
      "r3",
      "r5",
      "r6",
      "r4",
      "r2"
    ]);
  });

  test("highest salience sits at BOTH edges for every n >= 2", () => {
    for (let n = 2; n <= 9; n += 1) {
      const ranked = Array.from({ length: n }, (_, i) => `r${i + 1}`);
      const shaped = orderUShape(ranked);
      expect(shaped[0]).toBe("r1");
      expect(shaped[shaped.length - 1]).toBe("r2");
      expect(shaped).toHaveLength(n);
      expect([...shaped].sort()).toEqual([...ranked].sort());
    }
  });

  test("degenerate inputs: empty and singleton pass through", () => {
    expect(orderUShape([])).toEqual([]);
    expect(orderUShape(["only"])).toEqual(["only"]);
  });

  test("deterministic and non-mutating", () => {
    const ranked = ["a", "b", "c", "d"];
    const first = orderUShape(ranked);
    const second = orderUShape(ranked);
    expect(first).toEqual(second);
    expect(ranked).toEqual(["a", "b", "c", "d"]);
  });
});
