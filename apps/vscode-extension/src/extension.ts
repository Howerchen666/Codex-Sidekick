import * as vscode from "vscode";
import { otherBridgeRunning, startBridge } from "./bridge.js";
import { focusChatTab } from "./chat-tabs.js";
import { SetupError, activityLogPath, codexHome, setupActivity } from "./setup.mts";
import { CODEX_EXTENSION_ID, createCommands } from "./commands.mts";
import type { Control } from "../../../packages/neo-bridge/protocol.mts";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Codex Sidekick");
  const codex = createCommands({
    getCodex() {
      const extension = vscode.extensions.getExtension<unknown>(CODEX_EXTENSION_ID);
      if (!extension) return undefined;
      const manifestVersion: unknown = extension.packageJSON?.version;
      const api = extension.isActive ? extension.exports : undefined;
      return {
        isActive: extension.isActive,
        version: typeof manifestVersion === "string" ? manifestVersion : "unknown",
        publicExportType: extension.isActive ? (api === null ? "null" : typeof api) : null,
      };
    },
    getCommands: () => vscode.commands.getCommands(true),
    execute: (id) => vscode.commands.executeCommand(id),
  });
  const log = (record: object) => output.appendLine(JSON.stringify({ at: new Date().toISOString(), ...record }));

  const handle = async (action: Control) => {
    try {
      const outcome = await codex.run(action);
      log({ event: "command", action, outcome });
      if (outcome === "unavailable") {
        void vscode.window.showWarningMessage("This Codex action is unavailable in this window. Check that the OpenAI Codex extension is enabled.");
      }
      return outcome;
    } catch {
      log({ event: "command", action, outcome: "error" });
      void vscode.window.showWarningMessage("VS Code couldn’t run that Codex action. Try it in the Codex sidebar.");
      return "error";
    }
  };

  const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
  const preference = folder ? "neo:" + folder.uri.toString() : "";
  let stopBridge: (() => void) | undefined;

  const canConnect = () => {
    const folders = vscode.workspace.workspaceFolders;
    return process.platform === "darwin" && !vscode.env.remoteName &&
      vscode.workspace.isTrusted && folder?.uri.scheme === "file" &&
      folders?.length === 1 && folders[0].uri.toString() === folder.uri.toString();
  };

  const refresh = () => {
    stopBridge?.();
    stopBridge = undefined;
    if (!canConnect() || !folder || !context.globalState.get(preference)) return;
    const error = () => log({ event: "neo", outcome: "bridge-error" });
    try {
      stopBridge = startBridge({
        workspace: folder.name,
        workspacePath: folder.uri.fsPath,
        log: activityLogPath(context.globalStorageUri.fsPath),
        run: handle,
        focusChat: async (session) => {
          if (!canConnect()) return "unavailable";
          const outcome = await focusChatTab(session);
          if (outcome === "unavailable") {
            await codex.run("openSidebar");
            void vscode.window.showInformationMessage(
              "Select the chat in Codex’s recent chats list. This Codex version has no supported command for choosing a specific sidebar chat.",
            );
          }
          return outcome;
        },
        error,
      });
    } catch { error(); }
  };
  refresh();

  const version = String(context.extension.packageJSON?.version ?? "0");
  const showDraft = async (content: string, merged: boolean) => {
    const draft = await vscode.workspace.openTextDocument({ language: "json", content });
    await vscode.window.showTextDocument(draft);
    void vscode.window.showInformationMessage(merged
      ? "Review the updated hook configuration in this draft. Copy it into ~/.codex/hooks.json, then review and trust the Sidekick hooks in Codex Settings → Hooks."
      : "Merge the Sidekick entries from this draft into ~/.codex/hooks.json, replacing older Sidekick entries if present. Then review and trust the hooks in Codex Settings → Hooks.");
  };

  /** Install the user-level hooks. `auto` runs are quiet unless the user has something to do. */
  const setUpActivity = async (auto: boolean): Promise<boolean> => {
    try {
      const result = await setupActivity({
        codexHome: codexHome(), storage: context.globalStorageUri.fsPath,
        recorder: context.asAbsolutePath("dist/recorder.mjs"),
      });
      if (!result.configured) {
        // An existing hooks.json is never overwritten. Offer the merged draft once per version.
        if (!auto) await showDraft(result.content, result.merged);
        else if (!context.globalState.get("draft-offered:" + version)) {
          await context.globalState.update("draft-offered:" + version, true);
          const choice = await vscode.window.showInformationMessage(
            "Sidekick needs to add its hooks to your existing ~/.codex/hooks.json.", "Review draft");
          if (choice) await showDraft(result.content, result.merged);
        }
      } else if (!auto || result.created) {
        void vscode.window.showInformationMessage("Review and trust the Sidekick hooks in Codex Settings → Hooks, then send a message.");
      }
      if (!auto && folder && canConnect()) {
        await context.globalState.update(preference, true);
        refresh();
      }
      return true;
    } catch (error) {
      log({ event: "activity-setup", outcome: "error" });
      if (!auto) {
        void vscode.window.showErrorMessage(error instanceof SetupError ? error.message :
          "Sidekick couldn’t set up chat activity. Check that VS Code can write to your Codex folder.");
      }
      return false;
    }
  };

  /**
   * First run in a trusted local folder: connect it and install the hooks. A folder the
   * user has switched off stays off, and a window never takes over from one that is already
   * connected, because two connected windows would make the keys unavailable.
   */
  const autoConfigure = async () => {
    if (!folder || !canConnect() || !vscode.extensions.getExtension(CODEX_EXTENSION_ID)) return;
    if (context.globalState.get(preference) === undefined && !otherBridgeRunning()) {
      await context.globalState.update(preference, true);
      refresh();
    }
    const key = "activity-setup:" + version;
    // Only a completed setup is remembered, so a failure is retried on the next start.
    if (!context.globalState.get(key) && await setUpActivity(true)) await context.globalState.update(key, true);
  };
  void autoConfigure();

  context.subscriptions.push(
    output,
    { dispose: () => stopBridge?.() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => { stopBridge?.(); stopBridge = undefined; }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { refresh(); void autoConfigure(); }),
    vscode.commands.registerCommand("codexSidekick.toggleNeo", async () => {
      if (!canConnect()) {
        void vscode.window.showWarningMessage("Open a trusted local folder in VS Code to connect Sidekick.");
        return;
      }
      const enabled = !context.globalState.get(preference);
      await context.globalState.update(preference, enabled);
      refresh();
      void vscode.window.showInformationMessage(enabled ? "Sidekick is enabled for this workspace." : "Sidekick is disabled for this workspace.");
    }),
    vscode.commands.registerCommand("codexSidekick.setupActivity", async () => { await setUpActivity(false); }),
    vscode.commands.registerCommand("codexSidekick.probe", async () => {
      try {
        const report = await codex.inspect();
        log({ event: "capabilities", vscode: vscode.version, remote: Boolean(vscode.env.remoteName), ...report });
        output.show(true);
        return report;
      } catch {
        log({ event: "capabilities", outcome: "error" });
        output.show(true);
        return undefined;
      }
    }),
    vscode.commands.registerCommand("codexSidekick.openSidebar", () => handle("openSidebar")),
    vscode.commands.registerCommand("codexSidekick.newChat", () => handle("newChat")),
  );
}
