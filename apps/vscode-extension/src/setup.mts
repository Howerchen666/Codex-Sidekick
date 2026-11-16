import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { EVENTS } from "../../../packages/hook-recorder/events.mts";
import { hookConfig, isManagedHookGroup } from "../../../packages/hook-recorder/config.mts";

const execFileAsync = promisify(execFile);

export class SetupError extends Error {}

let nodeLookup: Promise<string> | undefined;

function nodeExecutable(): Promise<string> {
  // Reuse the validated choice for this extension session. A cold-start timeout
  // must not make repeated setup switch runtimes and propose replacing hooks.
  nodeLookup ??= findNodeExecutable().catch((error) => {
    nodeLookup = undefined;
    throw error;
  });
  return nodeLookup;
}

async function findNodeExecutable(): Promise<string> {
  const pathDirectories = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const candidates = new Set([
    "/opt/homebrew/bin/node", "/opt/homebrew/opt/node@22/bin/node", "/usr/local/bin/node",
    ...pathDirectories.map((directory) => join(directory, "node")),
  ]);
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["-p", "process.versions.node"],
        { timeout: 2000, cwd: "/" });
      const version = stdout.trim();
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      const [major, minor] = version.split(".").map(Number);
      if (major > 22 || (major === 22 && minor >= 18)) return candidate;
    } catch { /* try the next installation */ }
  }
  throw new SetupError("Sidekick couldn't find Node.js 22.18 or later. Install it and reopen VS Code.");
}

function mergeConfig(existing: string, generated: string, log: string, workspace: string) {
  const object = (value: unknown): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value));
  try {
    const original: unknown = JSON.parse(existing);
    if (!object(original) || (original.hooks !== undefined && !object(original.hooks))) return;
    const hooks = { ...(original.hooks as Record<string, unknown> | undefined) };
    const fresh = JSON.parse(generated).hooks;
    for (const event of EVENTS) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups)) return;
      const managed = groups.filter((group) => isManagedHookGroup(group, event, log, workspace));
      if (managed.length === 1 && isDeepStrictEqual(managed[0], fresh[event][0])) continue;
      let replaced = false;
      const updated = groups.flatMap((group) => {
        if (!isManagedHookGroup(group, event, log, workspace)) return [group];
        if (replaced) return [];
        replaced = true;
        return fresh[event];
      });
      if (!replaced) updated.push(...fresh[event]);
      hooks[event] = updated;
    }
    const merged = { ...original, hooks };
    return { content: JSON.stringify(merged, null, 2) + "\n", configured: isDeepStrictEqual(original, merged) };
  } catch { return; }
}

/** The label passed to every user-level hook. The recorder hashes it into the `workspace` field. */
export const SCOPE = "*";

/** Where Codex reads user-level configuration, including hooks.json. */
export function codexHome(): string {
  const configured = process.env.CODEX_HOME;
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".codex");
}

/**
 * The single log every user-level hook writes and the bridge reads. A fixed path under
 * the extension's storage, so nothing has to be remembered between VS Code sessions.
 */
export function activityLogPath(storageRoot: string): string {
  return join(storageRoot, "activity", "all.ndjson");
}

/** Install hooks that record activity from every local Codex session, whatever its project. */
export async function setupActivity(options: { codexHome: string; storage: string; recorder: string }) {
  const workspace = SCOPE;
  const storage = join(options.storage, "activity");
  const log = activityLogPath(options.storage);
  const body = await readFile(options.recorder);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const recorder = join(storage, `record-${digest}.mjs`);
  const configDir = options.codexHome;
  const configPath = join(configDir, "hooks.json");
  const node = await nodeExecutable();
  const content = hookConfig({ node, recorder, log, workspace });

  await mkdir(storage, { recursive: true, mode: 0o700 });
  const privateDir = await lstat(storage);
  if (!privateDir.isDirectory() || privateDir.uid !== process.getuid?.() || (privateDir.mode & 0o077) !== 0) {
    throw new SetupError("Sidekick's activity storage must be private to your Mac account.");
  }
  await writeFile(recorder, body, { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(recorder);
    if (!info.isFile() || !(await readFile(recorder)).equals(body)) throw new SetupError("Sidekick couldn't verify its activity recorder.");
  });
  await writeFile(log, "", { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const info = await lstat(log);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
      throw new SetupError("Sidekick's activity log must be a private file owned by your Mac account.");
    }
  });

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(configDir)).isDirectory()) {
    throw new SetupError("Sidekick couldn't find your Codex configuration folder.");
  }

  // Publish a complete file without replacing a configuration another process created.
  const scratch = await mkdtemp(join(dirname(configPath), ".sidekick-"));
  let result = { content, configured: true, merged: false, created: true };
  try {
    const draft = join(scratch, "hooks.json");
    await writeFile(draft, content, { mode: 0o600 });
    await link(draft, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(configPath);
    const merged = info.isFile() && info.size < 1024 * 1024
      ? mergeConfig(await readFile(configPath, "utf8"), content, log, workspace)
      : undefined;
    result = merged ? { ...merged, merged: true, created: false } : { content, configured: false, merged: false, created: false };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { log, ...result };
}
