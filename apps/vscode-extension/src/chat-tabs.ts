import * as vscode from "vscode";
import { observationId } from "../../../packages/hook-recorder/metadata.mts";
import { CODEX_EXTENSION_ID } from "./commands.mts";

const CODEX_EDITOR = "chatgpt.conversationEditor";
const CODEX_SCHEME = "openai-codex";
const CODEX_AUTHORITY = "route";

export async function focusChatInSidebar(session: string, threadId?: string): Promise<"invoked" | "unavailable"> {
  // An existing tab can resolve an observed chat before the next metadata refresh.
  if (threadId === undefined) {
    for (const group of vscode.window.tabGroups.all) {
      const tab = group.tabs.find(({ input }) => input instanceof vscode.TabInputCustom &&
        input.viewType === CODEX_EDITOR && input.uri.scheme === CODEX_SCHEME &&
        input.uri.authority === CODEX_AUTHORITY && /^\/local\/[^/]+$/.test(input.uri.path) &&
        observationId(input.uri.path.slice("/local/".length)) === session);
      if (tab?.input instanceof vscode.TabInputCustom) {
        threadId = tab.input.uri.path.slice("/local/".length);
        break;
      }
    }
  }
  // Only IDs resolved locally from Codex metadata or a known tab reach this path. Do not
  // interpret an ID as a route, query, or command supplied by the deck.
  if (!threadId || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || observationId(threadId) !== session) return "unavailable";
  const codex = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
  if (!codex) return "unavailable";
  await codex.activate();

  // Codex's URI handler focuses the sidebar and navigates it to this route.
  // asExternalUri binds the link to this VS Code window. Preserve its result.
  const uri = await vscode.env.asExternalUri(vscode.Uri.from({
    scheme: vscode.env.uriScheme, authority: CODEX_EXTENSION_ID, path: `/local/${threadId}`,
  }));
  return await vscode.env.openExternal(uri) ? "invoked" : "unavailable";
}
