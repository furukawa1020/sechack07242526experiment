export const CONDITION_CODES = ["A", "B", "C", "D"] as const;

export type ConditionCode = (typeof CONDITION_CODES)[number];
export type ProcessingLocation = "cloud" | "local";
export type PresentationMode = "label" | "puffer";

export type ConditionDefinition = Readonly<{
  processing: ProcessingLocation;
  presentation: PresentationMode;
}>;

/**
 * The four experimental conditions are protocol constants. Do not make this
 * mapping configurable: changing it changes the experiment itself.
 */
export const CONDITIONS = {
  A: { processing: "cloud", presentation: "label" },
  B: { processing: "local", presentation: "label" },
  C: { processing: "local", presentation: "puffer" },
  D: { processing: "cloud", presentation: "puffer" },
} as const satisfies Readonly<Record<ConditionCode, ConditionDefinition>>;

export const ORDER_CODES = ["ABDC", "BCAD", "CDBA", "DACB"] as const;

export type OrderCode = (typeof ORDER_CODES)[number];
export type SequenceIndex = 0 | 1 | 2 | 3;

export const SEQUENCE_INDICES = [0, 1, 2, 3] as const satisfies readonly SequenceIndex[];

export interface OrderDesignValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly positionCounts: Readonly<Record<ConditionCode, readonly number[]>>;
  readonly adjacentPairs: readonly string[];
}

export interface OrderUsageRecord {
  readonly orderCode: OrderCode;
  readonly result: "ok" | "aborted" | "error" | null;
  readonly presentationsStarted: number;
}

export interface OrderAllocationOptions {
  readonly includeAbortedInOrderBalancing: boolean;
  /** A value in the half-open interval [0, 1), injectable for deterministic tests. */
  readonly random?: () => number;
}

export function isConditionCode(value: unknown): value is ConditionCode {
  return typeof value === "string" && CONDITION_CODES.some((code) => code === value);
}

export function isOrderCode(value: unknown): value is OrderCode {
  return typeof value === "string" && ORDER_CODES.some((code) => code === value);
}

export function conditionsForOrder(orderCode: OrderCode): readonly ConditionCode[] {
  return Object.freeze([...orderCode].map((code) => {
    if (!isConditionCode(code)) {
      throw new Error(`Invalid condition code in order: ${code}`);
    }
    return code;
  }));
}

export function validateOrderDesign(orders: readonly string[]): OrderDesignValidation {
  const errors: string[] = [];
  const positionCounts: Record<ConditionCode, number[]> = {
    A: [0, 0, 0, 0],
    B: [0, 0, 0, 0],
    C: [0, 0, 0, 0],
    D: [0, 0, 0, 0],
  };
  const adjacentPairs: string[] = [];

  if (orders.length !== CONDITION_CODES.length) {
    errors.push(`Expected 4 orders, received ${orders.length}.`);
  }

  for (const order of orders) {
    const codes = [...order];
    if (codes.length !== CONDITION_CODES.length) {
      errors.push(`Order ${order} must contain exactly 4 conditions.`);
      continue;
    }

    const uniqueCodes = new Set(codes);
    if (
      uniqueCodes.size !== CONDITION_CODES.length
      || CONDITION_CODES.some((code) => !uniqueCodes.has(code))
    ) {
      errors.push(`Order ${order} must contain A, B, C and D exactly once.`);
      continue;
    }

    codes.forEach((code, position) => {
      if (isConditionCode(code)) {
        const counts = positionCounts[code];
        counts[position] = (counts[position] ?? 0) + 1;
      }
    });

    for (let position = 0; position < codes.length - 1; position += 1) {
      adjacentPairs.push(`${codes[position] ?? ""}${codes[position + 1] ?? ""}`);
    }
  }

  for (const code of CONDITION_CODES) {
    if (positionCounts[code].some((count) => count !== 1)) {
      errors.push(`Condition ${code} must occur exactly once in every position.`);
    }
  }

  const expectedPairs = CONDITION_CODES.flatMap((first) =>
    CONDITION_CODES.filter((second) => second !== first).map((second) => `${first}${second}`),
  );
  const pairCounts = new Map<string, number>();
  for (const pair of adjacentPairs) {
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }
  if (
    adjacentPairs.length !== expectedPairs.length
    || expectedPairs.some((pair) => pairCounts.get(pair) !== 1)
  ) {
    errors.push("The design must contain each of the 12 directed adjacent pairs exactly once.");
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    positionCounts: Object.freeze({
      A: Object.freeze(positionCounts.A),
      B: Object.freeze(positionCounts.B),
      C: Object.freeze(positionCounts.C),
      D: Object.freeze(positionCounts.D),
    }),
    adjacentPairs: Object.freeze(adjacentPairs),
  });
}

export function assertBalancedOrderDesign(orders: readonly string[]): asserts orders is readonly OrderCode[] {
  const validation = validateOrderDesign(orders);
  if (!validation.valid) {
    throw new Error(`Invalid experiment order design: ${validation.errors.join(" ")}`);
  }
  if (
    orders.some((order) => !isOrderCode(order))
    || ORDER_CODES.some((order) => !orders.includes(order))
  ) {
    throw new Error("Experiment orders must be exactly ABDC, BCAD, CDBA and DACB.");
  }
}

export function countOrderUsage(
  records: readonly OrderUsageRecord[],
  includeAbortedInOrderBalancing: boolean,
): Readonly<Record<OrderCode, number>> {
  const counts: Record<OrderCode, number> = {
    ABDC: 0,
    BCAD: 0,
    CDBA: 0,
    DACB: 0,
  };

  for (const record of records) {
    const countsAsUsed = record.result === "ok"
      || (
        includeAbortedInOrderBalancing
        && record.result === "aborted"
        && record.presentationsStarted > 0
      );
    if (countsAsUsed) {
      counts[record.orderCode] += 1;
    }
  }

  return Object.freeze(counts);
}

export function allocateOrder(
  records: readonly OrderUsageRecord[],
  options: OrderAllocationOptions,
): OrderCode {
  const counts = countOrderUsage(records, options.includeAbortedInOrderBalancing);
  const minimum = Math.min(...ORDER_CODES.map((order) => counts[order]));
  const candidates = ORDER_CODES.filter((order) => counts[order] === minimum);
  const random = options.random ?? Math.random;
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("The random source must return a finite value in [0, 1)." );
  }
  const selected = candidates[Math.floor(sample * candidates.length)];
  if (selected === undefined) {
    throw new Error("No order is available for allocation.");
  }
  return selected;
}

export function orderImbalanceAfterSelection(
  records: readonly OrderUsageRecord[],
  selectedOrder: OrderCode,
  includeAbortedInOrderBalancing: boolean,
): number {
  const counts = { ...countOrderUsage(records, includeAbortedInOrderBalancing) };
  counts[selectedOrder] += 1;
  const values = ORDER_CODES.map((order) => counts[order]);
  return Math.max(...values) - Math.min(...values);
}

assertBalancedOrderDesign(ORDER_CODES);
