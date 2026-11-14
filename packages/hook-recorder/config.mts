import { EVENTS } from "./events.mts";

function quoteShellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function hookConfig(options: { node: string; recorder: string; log: string; workspace: string }) {
  const { node, recorder, log, workspace } = options;
  const hooks = Object.fromEntries(EVENTS.map((event) => [
    event, [{ hooks: [{
      type: "command", timeout: 1,
      command: [node, recorder, log, workspace, event].map(quoteShellArgument).join(" "),
    }] }],
  ]));
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

export function isManagedHookGroup(group: unknown, event: typeof EVENTS[number], log: string, workspace: string): boolean {
  if (!group || typeof group !== "object" || Object.keys(group).length !== 1 || !("hooks" in group) ||
      !Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const hook = group.hooks[0];
  if (!hook || typeof hook !== "object" || Object.keys(hook).length !== 3 || hook.type !== "command" ||
      hook.timeout !== 1 || typeof hook.command !== "string") return false;
  const ending = [log, workspace, event].map(quoteShellArgument).join(" ");
  if (!hook.command.endsWith(" " + ending)) return false;
  const prefix = hook.command.slice(0, -(ending.length + 1));
  const recorder = quoteShellArgument(log.slice(0, log.lastIndexOf("/") + 1) + "record-");
  const marker = " " + recorder.slice(0, -1);
  const offset = prefix.lastIndexOf(marker);
  return offset > 0 && /^'[^']*(?:'"'"'[^']*)*'$/.test(prefix.slice(0, offset)) &&
    /^[a-f0-9]{16}\.mjs'$/.test(prefix.slice(offset + marker.length));
}
