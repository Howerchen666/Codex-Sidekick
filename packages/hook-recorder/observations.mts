import { EVENTS } from "./events.mts";
import { isTokenCount } from "./metadata.mts";

type EventName = typeof EVENTS[number];
type RecordRow = { at: string; event: EventName; session: string; workspace: string; requestTokens?: number };
export type TokenSample = { at: string; tokens: number };
type Label = "Session observed" | "Working observed" | "Model request returned" |
  "Approval requested" | "Stop observed" | "Interrupt observed" | "Session end observed" | "Unknown";

const labels: Record<EventName, { label: Label; freshMs: number }> = {
  SessionStart: { label: "Session observed", freshMs: 120_000 },
  UserPromptSubmit: { label: "Working observed", freshMs: 120_000 },
  PreModelRequest: { label: "Working observed", freshMs: 120_000 },
  PostModelRequest: { label: "Model request returned", freshMs: 120_000 },
  PermissionRequest: { label: "Approval requested", freshMs: 15_000 },
  Stop: { label: "Stop observed", freshMs: 120_000 },
  Interrupt: { label: "Interrupt observed", freshMs: 120_000 },
  SessionEnd: { label: "Session end observed", freshMs: 120_000 },
};

export function parseObservations(raw: string): RecordRow[] {
  const rows: RecordRow[] = [];
  // The writer uses one append per line. Ignore an incomplete trailing line.
  for (const line of raw.split("\n").slice(0, -1)) {
    if (!line) continue;
    try {
      const data: unknown = JSON.parse(line);
      if (typeof data !== "object" || data === null) continue;
      const row = data as Record<string, unknown>;
      const event = EVENTS.find((name) => name === row.event);
      const opaque = /^[a-f0-9]{16}$/;
      if (!event || typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) ||
          typeof row.session !== "string" || !opaque.test(row.session) ||
          typeof row.workspace !== "string" || !opaque.test(row.workspace)) continue;
      const { at, session, workspace, requestTokens } = row;
      rows.push({ at, event, session, workspace,
        ...(event === "PostModelRequest" && isTokenCount(requestTokens) ? { requestTokens } : {}),
      });
    } catch { /* damaged row; no evidence */ }
  }
  return rows;
}

export function observationFor(row: RecordRow, now: number, sourceAvailable: boolean) {
  const rule = labels[row.event];
  const expiresAt = Date.parse(row.at) + rule.freshMs;
  const current = sourceAvailable && now < expiresAt;
  return { ...row, observation: current ? rule.label : "Unknown" as const, expiresAt };
}

export function summarize(rows: readonly RecordRow[], now: number, sourceAvailable: boolean) {
  const latest = new Map<string, RecordRow>();
  const usage = new Map<string, TokenSample>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (at > now) continue;
    const key = row.workspace + ":" + row.session;
    const previous = latest.get(key);
    if (!previous || Date.parse(previous.at) <= at) latest.set(key, row);
    const sample = usage.get(key);
    if (row.event === "PostModelRequest" && isTokenCount(row.requestTokens) &&
        (!sample || Date.parse(sample.at) <= at)) usage.set(key, { at: row.at, tokens: row.requestTokens });
  }
  return [...latest].map(([key, row]) => ({ ...observationFor(row, now, sourceAvailable), usage: usage.get(key) }));
}
