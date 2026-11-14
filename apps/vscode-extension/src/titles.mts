import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { projectAccountUsage, type AccountUsage } from "../../../packages/account-usage/usage.mts";
import { chatTitle, observationId } from "../../../packages/hook-recorder/metadata.mts";
import type { RecentChat } from "../../../packages/neo-bridge/protocol.mts";

async function codexExecutable(): Promise<string | undefined> {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const candidates = new Set(["/opt/homebrew/bin/codex", "/usr/local/bin/codex",
    ...directories.map((dir) => join(dir, "codex"))]);
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try another installation */ }
  }
}

export async function readCodexMetadata(options: {
  workspace: string;
  sessions: ReadonlySet<string>;
  signal: AbortSignal;
  includeUsage: boolean;
  includeRecent?: boolean;
}) {
  const { workspace, sessions, signal, includeUsage, includeRecent } = options;
  const executable = await codexExecutable();
  if (!executable || signal.aborted) return;
  const cwd = await realpath(workspace);
  if (signal.aborted) return;

  // Read chat metadata and account limits through the documented App Server methods.
  return new Promise<{ titles: Map<string, string>; recentChats?: RecentChat[]; usage?: AccountUsage } | undefined>((resolve) => {
    const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      cwd: "/", stdio: ["pipe", "pipe", "ignore"], signal,
    });
    const titles = new Map<string, string>();
    let buffer = "";
    let received = 0;
    let closed = false;
    let titlesDone = sessions.size === 0;
    let usageDone = !includeUsage;
    let recentDone = !includeRecent;
    let recentChats: RecentChat[] | undefined;
    let usage: AccountUsage | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      child.kill();
      resolve({ titles, usage, recentChats });
    };
    const settle = () => { if (titlesDone && usageDone && recentDone) finish(); };
    const timer = setTimeout(finish, 6000);
    const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
    child.on("error", () => finish());
    child.on("exit", () => finish());
    child.stdin.on("error", () => finish());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (closed) return;
      received += Buffer.byteLength(chunk);
      if (received > 512_000) { finish(); return; }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const { id, result, error } = JSON.parse(line);
          if (id === 0) {
            if (error) { finish(); return; }
            send({ method: "initialized" });
            if (!titlesDone) send({ id: 1, method: "thread/list", params: {
              cwd, sourceKinds: ["vscode"], sortKey: "updated_at", useStateDbOnly: true, limit: 48,
            } });
            if (includeUsage) send({ id: 3, method: "account/rateLimits/read" });
            if (includeRecent) send({ id: 4, method: "thread/list", params: {
              sourceKinds: ["vscode", "cli", "appServer"], modelProviders: [], currentAccountOnly: true,
              sortKey: "updated_at", useStateDbOnly: true, limit: 12,
            } });
            settle();
          } else if (id === 1 || id === 2) {
            if (error || !Array.isArray(result?.data)) {
              titlesDone = true;
              settle();
              continue;
            }
            for (const row of result.data) {
              const key = observationId(row?.id);
              const title = chatTitle(row?.name);
              if (!key || !sessions.has(key) || !title || typeof row.cwd !== "string" || !isAbsolute(row.cwd)) continue;
              const fromWorkspace = relative(cwd, row.cwd);
              if (isAbsolute(fromWorkspace) || fromWorkspace === ".." || fromWorkspace.startsWith(".." + sep)) continue;
              titles.set(key, title);
            }
            if (id === 1 && [...sessions].some((session) => !titles.has(session))) {
              send({ id: 2, method: "thread/list", params: {
                cwd, sourceKinds: ["vscode"], sortKey: "updated_at", useStateDbOnly: true, limit: 48, archived: true,
              } });
            } else titlesDone = true;
            settle();
          } else if (id === 3 && includeUsage) {
            usage = error ? undefined : projectAccountUsage(result);
            usageDone = true;
            settle();
          } else if (id === 4 && includeRecent) {
            if (!error && Array.isArray(result?.data)) {
              const seen = new Set<string>();
              recentChats = [];
              for (const row of result.data) {
                const session = observationId(row?.id);
                const workspace = typeof row?.cwd === "string" && isAbsolute(row.cwd) ? observationId(row.cwd) : undefined;
                const ms = row?.updatedAt * 1000;
                if (!session || !workspace || seen.has(session) || row?.ephemeral || row?.archived ||
                    typeof row?.updatedAt !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > Date.now() + 60_000) continue;
                seen.add(session);
                recentChats.push({ session, workspace, title: chatTitle(row.name) ?? "Untitled chat", at: new Date(ms).toISOString() });
                if (recentChats.length === 12) break;
              }
            }
            recentDone = true;
            settle();
          }
        } catch { finish(); return; }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "codex_sidekick", version: "1.4.0" } } });
  });
}
