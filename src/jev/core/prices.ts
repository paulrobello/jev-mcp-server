/**
 * The lab's one assumed price, and the discipline for costing a Jev call.
 *
 * Every fallback estimate imports JEV_INPUT_USD_PER_M; the literal lives here and nowhere
 * else. A cost that crossed a process boundary (SSE event, session entry, usage object) is
 * only money once finiteCost has passed it: a string cost summed with `+` concatenates,
 * which is how a ledger total once became "00.0001".
 */

/** Jev's list price when the endpoint reports no cost. USD per 1M input tokens; output is free. */
export const JEV_INPUT_USD_PER_M = 0.042;

/** The labels meta.cost carries. "mock" covers the offline backend's known-zero answers. */
export type JevCostSource = "reported" | "estimated" | "mock" | "unknown";

export interface LabelledCost {
  /** USD, or null when no trustworthy cost exists. Never a string. */
  amount: number | null;
  source: JevCostSource;
}

/** Money is a finite nonnegative number. Anything else — a string, NaN, negative — is never summed. */
export function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Cost one call's usage: the endpoint's cost when it is real money, else the input-token estimate. */
export function labelUsageCost(
  usage: { input_tokens?: unknown; cost?: unknown } | undefined,
): LabelledCost {
  const reported = finiteCost(usage?.cost);
  if (reported !== null) return { amount: reported, source: "reported" };
  const input = finiteCost(usage?.input_tokens);
  if (input !== null) return { amount: (input * JEV_INPUT_USD_PER_M) / 1e6, source: "estimated" };
  return { amount: null, source: "unknown" };
}

/** Trust the core's labelled meta.cost when it survives the wire, else price the usage. */
export function labelEventCost(meta: unknown, usage: unknown): LabelledCost {
  const cost = (meta as { cost?: unknown } | undefined)?.cost;
  if (cost !== null && typeof cost === "object") {
    const { amount, source } = cost as { amount?: unknown; source?: unknown };
    if (source === "unknown") return { amount: null, source: "unknown" };
    const passed = finiteCost(amount);
    if (passed !== null && (source === "reported" || source === "estimated" || source === "mock")) {
      return { amount: passed, source };
    }
  }
  return labelUsageCost(usage as { input_tokens?: unknown; cost?: unknown } | undefined);
}
