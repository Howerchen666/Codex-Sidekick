import { lstatSync, readdirSync, watch } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { ensureRoot, endpointName, isChatTarget, receive, root, send, VERSION, type ChatTarget, type Control, type RecentChat } from "../../../packages/neo-bridge/protocol.mts";
import { availableWindow, isAccountUsage, usageExpiresAt, type AccountUsage } from "../../../packages/account-usage/usage.mts";
import { EVENTS } from "../../../packages/hook-recorder/events.mts";
import { chatTitle, isTokenCount } from "../../../packages/hook-recorder/metadata.mts";
import { observationFor, type TokenSample } from "../../../packages/hook-recorder/observations.mts";

export type Session = ReturnType<typeof observationFor> & { title?: string; usage?: TokenSample };
type ChatTile = ChatTarget & { title?: string; at: string; activity?: Session };
export type DeckState =
  | { mode: "offline" | "multiple" }
  | { mode: "connected"; workspace: string; feed: boolean; sessions: Session[]; chatTabs?: boolean; usage?: AccountUsage; recentChats?: RecentChat[] };

export function chatTiles(state: DeckState): ChatTile[] {
  if (state.mode !== "connected") return [];
  const tiles: ChatTile[] = [];
  const matched = new Set<string>();
  const bySession = new Map(state.sessions.map((row) => [row.session, row]));
  for (const chat of state.recentChats ?? []) {
    if (matched.has(chat.session)) continue;
    matched.add(chat.session);
    const activity = bySession.get(chat.session);
    tiles.push({ ...chat, activity, at: activity && activity.at > chat.at ? activity.at : chat.at });
  }
  for (const activity of state.sessions) {
    if (matched.has(activity.session) || (state.recentChats && activity.observation === "Unknown")) continue;
    matched.add(activity.session);
    tiles.push({ ...activity, activity });
  }
  return tiles.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
}

function isRecentChat(value: unknown): value is RecentChat {
  if (!isChatTarget(value)) return false;
  const { title, at } = value as Partial<RecentChat>;
  return typeof title === "string" && chatTitle(title) === title && typeof at === "string" &&
    Number.isFinite(Date.parse(at)) && Date.parse(at) <= Date.now() + 60_000;
}

function isSession(value: unknown): value is Session {
  if (!isChatTarget(value)) return false;
  const row = value as Record<string, unknown>;
  const sample = row.usage as Partial<TokenSample> | undefined;
  return (row.title === undefined || chatTitle(row.title) === row.title) &&
    (sample === undefined || (sample !== null && typeof sample.at === "string" &&
      Number.isFinite(Date.parse(sample.at)) && isTokenCount(sample.tokens))) &&
    typeof row.at === "string" && Number.isFinite(Date.parse(row.at)) &&
    EVENTS.some((e) => e === row.event) && typeof row.expiresAt === "number" && Number.isFinite(row.expiresAt);
}

export function connectDeck(onState: (state: DeckState) => void, dir = root()) {
  type Link = { socket: Socket; state?: Extract<DeckState, { mode: "connected" }> };
  const sockets = new Map<string, Link>();
  const retryAfter = new Map<string, number>();
  const pending = new Map<number, { socket: Socket; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  let watcher: ReturnType<typeof watch> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let expire: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let sequence = 0;
  let rendered = "";

  function update() {
    clearTimeout(expire);
    if (closed) return;
    const connected = [...sockets.values()].flatMap((item) => item.state ? [item.state] : []);
    let state: DeckState = { mode: connected.length > 1 ? "multiple" : "offline" };
    if (connected.length === 1) {
      const item = connected[0];
      const now = Date.now();
      const sessions = item.sessions.filter((row) => Date.parse(row.at) <= now)
        .map((row) => ({ ...row, ...observationFor(row, now, item.feed) }))
        .sort((a, b) => b.at.localeCompare(a.at));
      const quotaExpiry = item.usage ? usageExpiresAt(item.usage, now) : Infinity;
      const next = Math.min(...sessions.filter((r) => r.observation !== "Unknown").map((r) => r.expiresAt),
        quotaExpiry > now ? quotaExpiry : Infinity);
      if (Number.isFinite(next)) expire = setTimeout(update, Math.max(1, next - now));
      const fiveHour = availableWindow(item.usage, item.usage?.fiveHour, now);
      const weekly = availableWindow(item.usage, item.usage?.weekly, now);
      const usage = item.usage && (fiveHour || weekly) ? { at: item.usage.at, fiveHour, weekly } : undefined;
      state = { ...item, sessions, usage };
    }
    const serialized = JSON.stringify(state);
    if (serialized !== rendered) { rendered = serialized; onState(state); }
  }

  function scan() {
    if (closed) return;
    try {
      ensureRoot(dir);
      if (!watcher) {
        watcher = watch(dir, { persistent: false }, () => scan());
        watcher.on("error", () => { watcher?.close(); watcher = undefined; schedule(); });
      }
      const names = readdirSync(dir).filter((n) => endpointName.test(n)).slice(0, 32);
      for (const name of retryAfter.keys()) if (!names.includes(name)) retryAfter.delete(name);
      for (const name of names) {
        if (sockets.has(name) || (retryAfter.get(name) ?? 0) > Date.now()) continue;
        const path = join(dir, name);
        try {
          const info = lstatSync(path);
          if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) continue;
        } catch { continue; }
        const socket = createConnection(path);
        const item: Link = { socket };
        sockets.set(name, item);
        socket.setTimeout(1500, () => socket.destroy());
        socket.on("connect", () => send(socket, { type: "hello", version: VERSION }));
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
          sockets.delete(name);
          if (!closed) retryAfter.set(name, Date.now() + 1000);
          for (const [id, entry] of pending) if (entry.socket === socket) finish(id, false);
          update();
          schedule();
        });
        receive(socket, (msg) => {
          if (msg.type === "state" && typeof msg.workspace === "string" && typeof msg.feed === "boolean" &&
              Array.isArray(msg.sessions) && msg.sessions.length <= 12 && msg.sessions.every(isSession)) {
            socket.setTimeout(0);
            item.state = {
              mode: "connected", workspace: msg.workspace.slice(0, 80), feed: msg.feed,
              sessions: msg.sessions, chatTabs: msg.chatTabs === true, usage: isAccountUsage(msg.usage) ? msg.usage : undefined,
              recentChats: Array.isArray(msg.recentChats) && msg.recentChats.length <= 12 &&
                msg.recentChats.every(isRecentChat) ? msg.recentChats : undefined,
            };
            update();
          } else if (msg.type === "result" && typeof msg.id === "number" && pending.get(msg.id)?.socket === socket) {
            finish(msg.id, msg.outcome === "invoked");
          } else socket.destroy();
        });
      }
    } catch { schedule(); }
    update();
  }

  function schedule() {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = undefined; scan(); }, 1500);
  }

  function finish(id: number, ok: boolean) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(ok);
  }

  function dispatch(action: Control | "focusChat", target?: ChatTarget): Promise<boolean> {
    const candidates = [...sockets.values()].filter((item) => item.state && !item.socket.destroyed);
    if (closed || candidates.length !== 1 || pending.size > 0) return Promise.resolve(false);
    const { socket, state } = candidates[0];
    if (action === "focusChat" && (!state?.chatTabs || !target || !(
      state.recentChats?.some((row) => row.session === target.session && row.workspace === target.workspace) ||
      (state.feed && state.sessions.some((row) => row.session === target.session && row.workspace === target.workspace))
    ))) return Promise.resolve(false);
    const id = ++sequence;
    return new Promise((resolve) => {
      // A chat deep link can wait for VS Code's first-use confirmation dialog.
      const timeout = action === "focusChat" ? 30_000 : 1800;
      pending.set(id, { socket, resolve, timer: setTimeout(() => finish(id, false), timeout) });
      send(socket, { type: "command", id, action, target });
    });
  }

  scan();
  return {
    command: (action: Control) => dispatch(action),
    focusChat: (target: ChatTarget) => dispatch("focusChat", target),
    close() {
      closed = true;
      watcher?.close();
      clearTimeout(retry);
      clearTimeout(expire);
      for (const id of pending.keys()) finish(id, false);
      for (const item of sockets.values()) item.socket.destroy();
    },
  };
}
