import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { observationId } from "../packages/hook-recorder/metadata.mts";

test("chat selection reuses the matching native resource and leaves unmatched chats alone", async () => {
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/chat-tabs.ts"], bundle: true,
    platform: "node", format: "cjs", external: ["vscode"], write: false,
  });
  class TabInputCustom {
    constructor(uri, viewType = "chatgpt.conversationEditor") { this.uri = uri; this.viewType = viewType; }
  }
  const uri = (id, scheme = "openai-codex") => ({ scheme, path: "/local/" + id });
  const first = new TabInputCustom(uri("first-test-chat"));
  const second = new TabInputCustom(uri("second-test-chat"));
  const wrongEditor = new TabInputCustom(uri("second-test-chat"), "unrelated.customEditor");
  const wrongScheme = new TabInputCustom(uri("second-test-chat", "file"));
  const calls = [];
  const api = {
    TabInputCustom,
    window: { tabGroups: { all: [
      { viewColumn: 1, tabs: [{ input: first }, { input: wrongEditor }, { input: wrongScheme }] },
      { viewColumn: 2, tabs: [{ input: second }] },
    ] } },
    commands: { executeCommand: async (...args) => calls.push(args) },
  };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, { module, exports: module.exports,
    require: (name) => name === "vscode" ? api : require(name) });
  const { focusChatTab } = module.exports;
  assert.equal(await focusChatTab(observationId("second-test-chat")), "invoked");
  assert.equal(calls[0][0], "vscode.openWith");
  assert.strictEqual(calls[0][1], second.uri);
  assert.equal(calls[0][2], "chatgpt.conversationEditor");
  assert.equal(calls[0][3].viewColumn, 2);
  assert.equal(calls[0][3].preserveFocus, false);
  assert.equal(await focusChatTab(observationId("missing-test-chat")), "unavailable");
  assert.equal(calls.length, 1);
});
