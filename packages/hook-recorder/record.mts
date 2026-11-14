import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { EVENTS } from "./events.mts";
import { isTokenCount, observationId } from "./metadata.mts";
export { EVENTS } from "./events.mts";

type EventName = typeof EVENTS[number];
interface Observation {
  at: string;
  event: EventName;
  session: string;
  workspace: string;
  requestTokens?: number;
}

const MAX_INPUT = 1024 * 1024;
// When the log passes MAX_LOG, keep only its newest KEEP_LOG bytes. Only each session's
// latest event matters to the display, so history is disposable and the glow never stalls.
const MAX_LOG = 512 * 1024;
const KEEP_LOG = 64 * 1024;

function isEvent(value: unknown): value is EventName {
  return typeof value === "string" && EVENTS.some((event) => value === event);
}

/** `scope` is an opaque label from the hook command; it is hashed, never stored. */
export function projectObservation(input: unknown, scope: string): Observation | undefined {
  if (typeof input !== "object" || input === null) return;
  const row = input as Record<string, unknown>;
  if (!isEvent(row.hook_event_name) || typeof row.cwd !== "string" || !isAbsolute(row.cwd)) return;
  const session = observationId(row.session_id);
  if (!session) return;
  const workspace = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  const usage = row.hook_event_name === "PostModelRequest" ? row.token_usage : undefined;
  const total = usage && typeof usage === "object" ? (usage as Record<string, unknown>).total_tokens : undefined;
  return {
    at: new Date().toISOString(), event: row.hook_event_name,
    session, workspace,
    ...(isTokenCount(total) ? { requestTokens: total } : {}),
  };
}

function appendObservation(path: string, observation: Observation): void {
  // Setup pre-creates the file. Never create or follow a replacement symlink.
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o077) === 0) {
      let kept = "";
      if (info.size >= MAX_LOG) {
        const tail = Buffer.alloc(KEEP_LOG);
        const read = readSync(fd, tail, 0, KEEP_LOG, info.size - KEEP_LOG);
        const text = tail.subarray(0, read).toString("utf8");
        kept = text.slice(text.indexOf("\n") + 1); // drop the partial first line
        ftruncateSync(fd, 0);
      }
      writeSync(fd, kept + JSON.stringify(observation) + "\n");
    }
  } finally {
    closeSync(fd);
  }
}

async function capture(path: string, scope: string, expected: EventName): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size <= MAX_INPUT) chunks.push(bytes);
  }
  if (size > MAX_INPUT) return;
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const event = projectObservation(payload, scope);
  if (event?.event === expected) appendObservation(path, event);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , log, scope, event] = process.argv;
  try {
    if (log && scope && isEvent(event)) await capture(log, scope, event);
  } catch {
    // Observational only: leave the Codex operation unchanged if capture fails.
  } finally {
    if (event === "Stop") process.stdout.write("{}\n");
  }
}
