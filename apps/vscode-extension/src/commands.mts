import type { Control } from "../../../packages/neo-bridge/protocol.mts";

export const CODEX_EXTENSION_ID = "openai.chatgpt";

/** The only Codex commands Sidekick will ever run. No caller-supplied IDs or arguments. */
export const COMMANDS = {
  openSidebar: "chatgpt.openSidebar",
  newChat: "chatgpt.newChat",
  newPanel: "chatgpt.newCodexPanel",
} as const satisfies Record<Control, string>;

type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

interface Host {
  getCodex(): { readonly isActive: boolean; readonly version: string; readonly publicExportType: string | null } | undefined;
  getCommands(): PromiseLike<readonly string[]>;
  execute(command: CommandId): PromiseLike<unknown>;
}

export function createCommands(host: Host) {
  /** Which of the allowlisted commands the installed Codex extension has registered. */
  async function inspect() {
    const registered = new Set(await host.getCommands());
    const extension = host.getCodex();
    return {
      extension: extension ? { installed: true, ...extension } : { installed: false },
      commands: Object.fromEntries(Object.entries(COMMANDS).map(([name, id]) => [name, {
        id, registered: Boolean(extension) && registered.has(id),
      }])),
    } as const;
  }

  async function run(action: Control): Promise<"invoked" | "unavailable"> {
    if (!Object.hasOwn(COMMANDS, action)) return "unavailable";
    const id = COMMANDS[action];
    if (!host.getCodex() || !(await host.getCommands()).includes(id)) return "unavailable";
    await host.execute(id);
    return "invoked";
  }

  return { inspect, run };
}
