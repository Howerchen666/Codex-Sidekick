import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { observationId } from "../packages/hook-recorder/metadata.mts";

async function chatHost(tabs = []) {
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/chat-tabs.ts"], bundle: true,
    platform: "node", format: "cjs", external: ["vscode"], write: false,
  });
  class TabInputCustom {
    constructor(uri, viewType = "chatgpt.conversationEditor") { this.uri = uri; this.viewType = viewType; }
  }
  const uri = (id, scheme = "openai-codex", authority = "route") => ({ scheme, authority, path: "/local/" + id });
  const calls = [];
  const api = {
    TabInputCustom,
    Uri: { from: (parts) => parts },
    window: { tabGroups: { all: tabs } },
    extensions: { getExtension: (id) => id === "openai.chatgpt" ? {
      activate: async () => calls.push(["activate"]),
    } : undefined },
    env: {
      uriScheme: "vscode-insiders",
      asExternalUri: async (uri) => {
        calls.push(["resolve", uri]);
        return { ...uri, query: "windowId=42" };
      },
      openExternal: async (uri) => { calls.push(["open", uri]); return true; },
    },
    commands: { executeCommand: async () => assert.fail("Chat selection should use the sidebar URI handler") },
  };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, { module, exports: module.exports,
    require: (name) => name === "vscode" ? api : require(name) });
  return { focusChatInSidebar: module.exports.focusChatInSidebar, TabInputCustom, uri, calls, api };
}

test("an existing Codex tab resolves a chat for sidebar navigation before metadata refresh", async () => {
  const { focusChatInSidebar, TabInputCustom, uri, calls, api } = await chatHost();
  const first = new TabInputCustom(uri("first-test-chat"));
  const second = new TabInputCustom(uri("second-test-chat"));
  const wrongEditor = new TabInputCustom(uri("second-test-chat"), "unrelated.customEditor");
  const wrongScheme = new TabInputCustom(uri("second-test-chat", "file"));
  const wrongAuthority = new TabInputCustom(uri("second-test-chat", "openai-codex", "other"));
  const wrongPath = new TabInputCustom({ scheme: "openai-codex", authority: "route", path: "/other/second-test-chat" });
  api.window.tabGroups.all = [
      { viewColumn: 1, tabs: [{ input: first }, { input: wrongEditor }, { input: wrongScheme }, { input: wrongAuthority }, { input: wrongPath }] },
      { viewColumn: 2, tabs: [{ input: second }] },
  ];
  assert.equal(await focusChatInSidebar(observationId("second-test-chat")), "invoked");
  assert.equal(calls[2][0], "open");
  assert.equal(calls[2][1].authority, "openai.chatgpt");
  assert.equal(calls[2][1].path, "/local/second-test-chat");
  assert.equal(await focusChatInSidebar(observationId("missing-test-chat")), "unavailable");
  assert.equal(calls.length, 3);
});

test("a chat opens its exact sidebar deep link bound to the current VS Code window", async () => {
  const { focusChatInSidebar, calls } = await chatHost();
  const id = "01999999-1234-7000-8000-123456789abc";
  assert.equal(await focusChatInSidebar(observationId(id), id), "invoked");
  assert.deepEqual(calls.map(([method]) => method), ["activate", "resolve", "open"]);
  assert.equal(calls[1][1].scheme, "vscode-insiders");
  assert.equal(calls[1][1].authority, "openai.chatgpt");
  assert.equal(calls[1][1].path, "/local/" + id);
  assert.equal(calls[1][1].query, undefined);
  assert.equal(calls[2][1].query, "windowId=42");
});

test("unresolved, mismatched, and route-shaped IDs cannot open a different conversation", async () => {
  const { focusChatInSidebar, calls } = await chatHost();
  assert.equal(await focusChatInSidebar(observationId("target")), "unavailable");
  assert.equal(await focusChatInSidebar(observationId("target"), "another-chat"), "unavailable");
  for (const id of ["../target", "target?prompt=send", "target#fragment", "target/other", "a".repeat(129)]) {
    assert.equal(await focusChatInSidebar(observationId(id), id), "unavailable");
  }
  assert.equal(calls.length, 0);
});

test("unavailable Codex and failed links do not report a dispatched navigation request", async () => {
  const { focusChatInSidebar, api, calls } = await chatHost();
  api.env.openExternal = async () => false;
  assert.equal(await focusChatInSidebar(observationId("target"), "target"), "unavailable");
  api.env.openExternal = async () => { throw new Error("URI handler unavailable"); };
  await assert.rejects(focusChatInSidebar(observationId("target"), "target"), /URI handler unavailable/);
  calls.length = 0;
  api.extensions.getExtension = () => undefined;
  assert.equal(await focusChatInSidebar(observationId("target"), "target"), "unavailable");
  assert.equal(calls.length, 0);
});
