import { describe, expect, it } from "vitest";

import {
  allocateOrder,
  assertBalancedOrderDesign,
  CONDITIONS,
  CONDITION_CODES,
  conditionsForOrder,
  countOrderUsage,
  isConditionCode,
  isOrderCode,
  ORDER_CODES,
  orderImbalanceAfterSelection,
  validateOrderDesign,
  type OrderCode,
  type OrderUsageRecord,
} from "../../../src/shared/conditions.js";

describe("experimental conditions", () => {
  it("locks the A-D mapping required by the protocol", () => {
    expect(CONDITIONS).toEqual({
      A: { processing: "cloud", presentation: "label" },
      B: { processing: "local", presentation: "label" },
      C: { processing: "local", presentation: "puffer" },
      D: { processing: "cloud", presentation: "puffer" },
    });
    expect(CONDITION_CODES).toEqual(["A", "B", "C", "D"]);
  });

  it("uses exactly the four protocol orders", () => {
    expect(ORDER_CODES).toEqual(["ABDC", "BCAD", "CDBA", "DACB"]);
    expect(conditionsForOrder("ABDC")).toEqual(["A", "B", "D", "C"]);
    expect(() => conditionsForOrder("ABXC" as OrderCode)).toThrow(
      "Invalid condition code in order: X",
    );
    expect(isConditionCode("C")).toBe(true);
    expect(isConditionCode("X")).toBe(false);
    expect(isConditionCode(1)).toBe(false);
    expect(isOrderCode("CDBA")).toBe(true);
    expect(isOrderCode("ABCD")).toBe(false);
  });

  it("balances every position and every directed adjacent pair", () => {
    const result = validateOrderDesign(ORDER_CODES);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    for (const code of CONDITION_CODES) {
      expect(result.positionCounts[code]).toEqual([1, 1, 1, 1]);
    }
    expect(new Set(result.adjacentPairs).size).toBe(12);
    expect(result.adjacentPairs).toEqual(expect.arrayContaining([
      "AB", "AC", "AD", "BA", "BC", "BD",
      "CA", "CB", "CD", "DA", "DB", "DC",
    ]));
    expect(() => assertBalancedOrderDesign(ORDER_CODES)).not.toThrow();
  });

  it("reports malformed and unbalanced designs", () => {
    expect(validateOrderDesign(["ABC"]).errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Expected 4 orders"),
      expect.stringContaining("exactly 4"),
      expect.stringContaining("exactly once in every position"),
      expect.stringContaining("12 directed"),
    ]));
    expect(validateOrderDesign(["AAAA", "BCAD", "CDBA", "DACB"]).valid).toBe(false);
    expect(validateOrderDesign(["ABCD", "ABCD", "DCBA", "DCBA"]).errors).toContain(
      "The design must contain each of the 12 directed adjacent pairs exactly once.",
    );
    expect(() => assertBalancedOrderDesign(["ABCD", "BCDA", "CDAB", "DABC"]))
      .toThrow("Invalid experiment order design");
  });

  it("rejects a balanced design that is not the fixed protocol order set", () => {
    const renamedBalancedDesign = ["BADC", "ACBD", "CDAB", "DBCA"] as const;
    expect(validateOrderDesign(renamedBalancedDesign).valid).toBe(true);
    expect(() => assertBalancedOrderDesign(renamedBalancedDesign))
      .toThrow("Experiment orders must be exactly ABDC, BCAD, CDBA and DACB.");
  });
});

describe("order allocation", () => {
  const records: readonly OrderUsageRecord[] = [
    { orderCode: "ABDC", result: "ok", presentationsStarted: 4 },
    { orderCode: "ABDC", result: "aborted", presentationsStarted: 1 },
    { orderCode: "BCAD", result: "aborted", presentationsStarted: 0 },
    { orderCode: "CDBA", result: "error", presentationsStarted: 2 },
    { orderCode: "DACB", result: null, presentationsStarted: 1 },
  ];

  it("counts completed, eligible aborted, and interrupted in-progress sessions", () => {
    expect(countOrderUsage(records, true)).toEqual({ ABDC: 2, BCAD: 0, CDBA: 0, DACB: 1 });
    expect(countOrderUsage(records, false)).toEqual({ ABDC: 1, BCAD: 0, CDBA: 0, DACB: 0 });
  });

  it("chooses only among least-used orders and supports deterministic ties", () => {
    expect(allocateOrder(records, {
      includeAbortedInOrderBalancing: true,
      random: () => 0,
    })).toBe("BCAD");
    expect(allocateOrder(records, {
      includeAbortedInOrderBalancing: true,
      random: () => 0.999,
    })).toBe("CDBA");
    expect(ORDER_CODES).toContain(
      allocateOrder([], {
        includeAbortedInOrderBalancing: true,
      }),
    );
    expect(orderImbalanceAfterSelection([], "ABDC", true)).toBe(1);
  });

  it("rejects a broken random source", () => {
    expect(() => allocateOrder([], {
      includeAbortedInOrderBalancing: true,
      random: () => 1,
    })).toThrow(RangeError);
    expect(() => allocateOrder([], {
      includeAbortedInOrderBalancing: true,
      random: () => Number.NaN,
    })).toThrow(RangeError);
  });
});
