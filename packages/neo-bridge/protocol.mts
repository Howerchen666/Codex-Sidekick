import { constants, fstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";

export const ACTIONS = ["openSidebar", "newChat", "newPanel"] as const;
export type Control = typeof ACTIONS[number];
export type ChatTarget = { session: string; workspace: string };
export type RecentChat = ChatTarget & { title: string; at: string };
export const VERSION = 1;

export function isChatTarget(value: unknown): value is ChatTarget {
  if (!value || typeof value !== "object") return false;
  const { session, workspace } = value as Record<string, unknown>;
  const digest = /^[a-f0-9]{16}$/;
  return typeof session === "string" && digest.test(session) &&
    typeof workspace === "string" && digest.test(workspace);
}
const LIMIT = 32_768;
export const root = () => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Sidekick requires a local macOS user");
  return join("/tmp", "codex-sidekick-" + uid);
};
export const endpointName = /^ide-[0-9]+-[a-f0-9]{12}\.sock$/;

export function ensureRoot(dir = root()): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const fd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const s = fstatSync(fd);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) {
      throw new Error("Unsafe Sidekick runtime directory");
    }
  } finally { closeSync(fd); }
}

export function isControl(value: unknown): value is Control {
  return ACTIONS.some((name) => name === value);
}

export function send(socket: Socket, msg: object): void {
  const frame = JSON.stringify(msg) + "\n";
  if (socket.destroyed || socket.writableLength + Buffer.byteLength(frame) > LIMIT) {
    socket.destroy();
    return;
  }
  socket.write(frame);
}

export function receive(socket: Socket, onMessage: (msg: Record<string, unknown>) => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let eol: number;
    while ((eol = pending.indexOf("\n")) >= 0) {
      if (eol > LIMIT) { socket.destroy(); return; }
      const line = pending.slice(0, eol);
      pending = pending.slice(eol + 1);
      let value: unknown;
      try { value = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { socket.destroy(); return; }
      onMessage(value as Record<string, unknown>);
      if (socket.destroyed) return;
    }
    if (pending.length > LIMIT) socket.destroy();
  });
}
