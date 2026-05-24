import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { MAX_PENDING } from "./types.ts";
import type { HandlerContext } from "./types.ts";

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(
  err: { name: string; data?: unknown } | undefined,
): string {
  if (!err) return "unknown";
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`;
  }
  return err.name;
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_PENDING) {
    const [firstKey] = map.keys();
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(
  name: string,
  ctx: { disabledMetrics: Set<string> },
): boolean {
  return !ctx.disabledMetrics.has(name);
}

/**
 * Returns `true` if the trace type is not in the disabled set.
 * Valid names are `"session"`, `"llm"`, and `"tool"`.
 */
export function isTraceEnabled(
  name: string,
  ctx: { disabledTraces: Set<string> },
): boolean {
  return !ctx.disabledTraces.has(name);
}

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via `handleSessionCreated`.
 */
export function accumulateSessionTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID);
  if (!existing) return;
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + 1,
    agent: existing.agent,
  });
}

type MetadataPart = {
  metadata?: Record<string, unknown>;
};

function metadataValue(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Captures trace context smuggled through opencode text-part metadata.
 * opencode server plugins do not receive HTTP request headers, but text part
 * metadata is available in the chat.message hook before LLM/tool events begin.
 */
export function captureAtelierTraceContext(
  sessionID: string,
  parts: unknown[],
  ctx: HandlerContext,
) {
  for (const part of parts) {
    const metadata = (part as MetadataPart).metadata;
    if (!metadata) continue;
    const traceparent =
      metadataValue(metadata, "traceparent") ??
      metadataValue(metadata, "atelier.traceparent");
    if (!traceparent) continue;
    const carrier: Record<string, string> = { traceparent };
    const tracestate =
      metadataValue(metadata, "tracestate") ??
      metadataValue(metadata, "atelier.tracestate");
    if (tracestate) carrier.tracestate = tracestate;
    const parentContext = propagation.extract(ROOT_CONTEXT, carrier);
    setBoundedMap(ctx.sessionParentContexts, sessionID, parentContext);
    return parentContext;
  }
  return ctx.sessionParentContexts.get(sessionID);
}

export function ensureSessionTotals(
  sessionID: string,
  ctx: HandlerContext,
  input?: { startMs?: number; agent?: string },
) {
  const existing = ctx.sessionTotals.get(sessionID);
  if (existing) {
    if (input?.agent && existing.agent === "unknown")
      existing.agent = input.agent;
    return existing;
  }
  const totals = {
    startMs: input?.startMs ?? Date.now(),
    tokens: 0,
    cost: 0,
    messages: 0,
    agent: input?.agent ?? "unknown",
  };
  setBoundedMap(ctx.sessionTotals, sessionID, totals);
  return totals;
}

export function ensureSessionSpan(
  sessionID: string,
  ctx: HandlerContext,
  input?: { startTime?: number; agent?: string; isSubagent?: boolean },
) {
  const existing = ctx.sessionSpans.get(sessionID);
  if (existing) return existing;
  if (!isTraceEnabled("session", ctx)) return undefined;

  const parentContext =
    ctx.sessionParentContexts.get(sessionID) ?? context.active();
  const sessionSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}session`,
    {
      startTime: input?.startTime,
      attributes: {
        "openinference.span.kind": "agent",
        "session.id": sessionID,
        "agent.name": input?.agent ?? "unknown",
        "session.is_subagent": input?.isSubagent ?? false,
        ...ctx.commonAttrs,
      },
    },
    parentContext,
  );
  setBoundedMap(ctx.sessionSpans, sessionID, sessionSpan);
  return sessionSpan;
}
