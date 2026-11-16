import { chmodSync, readdirSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { summarize } from "../../../packages/hook-recorder/observations.mts";
import { watchFeed } from "../../../packages/hook-recorder/feed.mts";
import type { AccountUsage } from "../../../packages/account-usage/usage.mts";
import { readCodexMetadata, type ChatResource } from "./titles.mts";
import { endpointName, ensureRoot, isChatTarget, isControl, receive, root, send, VERSION, type Control, type RecentChat } from "../../../packages/neo-bridge/protocol.mts";

/** True when a bridge from another running VS Code window is already listening. */
export function otherBridgeRunning(dir = root()): boolean {
  try {
    return readdirSync(dir).some((name) => {
      if (!endpointName.test(name)) return false;
      const pid = Number(name.split("-")[1]);
      if (pid === process.pid) return false;
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    });
  } catch { return false; }
}

export function startBridge(options: {
  workspace: string;
  workspacePath?: string;
  log: string;
  run: (action: Control) => Promise<string>;
  focusChat?: (session: string, threadId?: string) => Promise<string>;
  error: () => void;
}, dir = root()): () => void {
  ensureRoot(dir);
  const path = join(dir, `ide-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
  const clients = new Set<Socket>();
  const subscribers = new Set<Socket>();
  const abort = new AbortController();
  const titles = new Map<string, string>();
  let chatResources = new Map<string, ChatResource>();
  let rows: ReturnType<typeof summarize> = [];
  let recentChats: RecentChat[] | undefined;
  let feed = false;
  let metadataPending: ReturnType<typeof setTimeout> | undefined;
  let readingMetadata = false;
  let usage: AccountUsage | undefined;
  let usageRefresh: ReturnType<typeof setTimeout> | undefined;
  let lastUsageLookup = 0;
  let lastLookup = 0;
  let attemptedRetry = "";
  let rendered = "";
  const snapshot = () => ({
    type: "state", workspace: options.workspace, feed, usage, recentChats, chatTabs: Boolean(options.focusChat),
    sessions: rows.map((row) => ({ ...row, title: titles.get(row.session) })),
  });
  const publish = () => {
    const state = snapshot();
    const serialized = JSON.stringify(state);
    if (serialized === rendered) return;
    rendered = serialized;
    for (const client of subscribers) send(client, state);
  };
  const scheduleMetadata = () => {
    const workspace = options.workspacePath;
    if (!workspace || !subscribers.size || metadataPending || readingMetadata || abort.signal.aborted) return;
    metadataPending = setTimeout(async () => {
      metadataPending = undefined;
      if (!subscribers.size || abort.signal.aborted) return;
      readingMetadata = true;
      lastLookup = Date.now();
      const sessions = new Set(rows.map((row) => row.session));
      const lookupState = rows;
      const includeUsage = Date.now() - lastUsageLookup >= 60_000;
      if (includeUsage) lastUsageLookup = Date.now();
      try {
        const found = await readCodexMetadata({ workspace, sessions, signal: abort.signal, includeUsage, includeRecent: true });
        if (found && !abort.signal.aborted) {
          for (const key of titles.keys()) if (!sessions.has(key)) titles.delete(key);
          for (const [key, value] of found.titles) titles.set(key, value);
          if (found.recentChats) recentChats = found.recentChats;
          chatResources = found.chatResources;
        }
        if (includeUsage && !abort.signal.aborted) usage = found?.usage;
        if (!abort.signal.aborted) publish();
      } catch {
        if (includeUsage && !abort.signal.aborted) { usage = undefined; publish(); }
      } finally {
        readingMetadata = false;
        clearTimeout(usageRefresh);
        if (subscribers.size && !abort.signal.aborted) {
          usageRefresh = setTimeout(scheduleMetadata, Math.max(1000, lastUsageLookup + 60_000 - Date.now()));
        }
        const unnamed = lookupState.filter((row) => !titles.has(row.session) &&
          Date.now() - Date.parse(row.at) < 30_000).map((row) => row.session).sort().join(",");
        if (lookupState !== rows || (unnamed && unnamed !== attemptedRetry)) {
          attemptedRetry = unnamed;
          scheduleMetadata();
        }
      }
    }, Math.max(250, lastLookup + 8000 - Date.now()));
  };
  const closeFeed = watchFeed(options.log, (state, available) => {
    rows = state.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
    feed = available;
    publish();
    scheduleMetadata();
  });
  const server = createServer((socket) => {
    if (clients.size >= 4) { socket.destroy(); return; }
    clients.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clients.delete(socket);
      subscribers.delete(socket);
      if (!subscribers.size) {
        clearTimeout(usageRefresh);
        clearTimeout(metadataPending);
        metadataPending = undefined;
      }
    });
    let ready = false;
    let busy = false;
    socket.setTimeout(1500, () => { if (!ready) socket.destroy(); });
    receive(socket, (msg) => {
      if (!ready) {
        if (msg.type !== "hello" || msg.version !== VERSION) { socket.destroy(); return; }
        ready = true;
        subscribers.add(socket);
        socket.setTimeout(0);
        send(socket, snapshot());
        scheduleMetadata();
        return;
      }
      if (msg.type !== "command" || typeof msg.id !== "number" || !Number.isSafeInteger(msg.id)) {
        socket.destroy();
        return;
      }
      const action = msg.action;
      let invoke: () => Promise<string>;
      if (isControl(action)) invoke = () => options.run(action);
      else if (action === "focusChat" && isChatTarget(msg.target)) {
        const { session, workspace } = msg.target;
        const matches = (row: { session: string; workspace: string }) => row.session === session && row.workspace === workspace;
        invoke = async () => {
          if (!recentChats?.some(matches) && !(feed && rows.some(matches))) return "unavailable";
          const resource = chatResources.get(session);
          return await options.focusChat?.(session, resource?.workspace === workspace ? resource.threadId : undefined) ?? "unavailable";
        };
      } else { socket.destroy(); return; }
      const id = msg.id;
      if (busy) { send(socket, { type: "result", id, outcome: "busy" }); return; }
      busy = true;
      void invoke().then((outcome) => send(socket, { type: "result", id, outcome }),
        () => send(socket, { type: "result", id, outcome: "error" })).finally(() => { busy = false; });
    });
  });
  server.on("error", options.error);
  server.listen(path, () => {
    try { chmodSync(path, 0o600); } catch { options.error(); server.close(); }
  });
  return () => {
    abort.abort();
    clearTimeout(metadataPending);
    clearTimeout(usageRefresh);
    closeFeed();
    for (const client of clients) client.destroy();
    server.close();
    try { unlinkSync(path); } catch { /* Node also removes its listening socket */ }
  };
}
