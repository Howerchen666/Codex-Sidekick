import * as vscode from "vscode";
import { observationId } from "../../../packages/hook-recorder/metadata.mts";

const CODEX_EDITOR = "chatgpt.conversationEditor";
const CODEX_SCHEME = "openai-codex";

export async function focusChatTab(session: string): Promise<"invoked" | "unavailable"> {
  // Reuse a resource from VS Code's public tab list. A sidebar chat does not have
  // a tab resource, and Codex does not document a way to construct one.
  for (const group of vscode.window.tabGroups.all) {
    const tab = group.tabs.find(({ input }) => input instanceof vscode.TabInputCustom &&
      input.viewType === CODEX_EDITOR && input.uri.scheme === CODEX_SCHEME &&
      observationId(input.uri.path.split("/").at(-1)) === session);
    const input = tab?.input;
    if (input instanceof vscode.TabInputCustom) {
      await vscode.commands.executeCommand("vscode.openWith", input.uri, input.viewType,
        { viewColumn: group.viewColumn, preserveFocus: false });
      return "invoked";
    }
  }
  return "unavailable";
}
