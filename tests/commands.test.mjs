import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, createCommands } from "../apps/vscode-extension/src/commands.mts";

test("installed and active only reports which allowlisted commands are registered", async () => {
  const codex = createCommands({
    getCodex: () => ({ isActive: true, version: "1.0.0", publicExportType: "undefined" }),
    getCommands: async () => [COMMANDS.openSidebar, "chatgpt.internal.approve"],
    execute: async () => assert.fail("inspection may not execute commands"),
  });
  const report = await codex.inspect();
  assert.equal(report.commands.openSidebar.registered, true);
  assert.equal(report.commands.newChat.registered, false);
  assert.deepEqual(Object.keys(report.commands), ["openSidebar", "newChat", "newPanel"]);
  assert.deepEqual(report, { extension: { installed: true, isActive: true, version: "1.0.0", publicExportType: "undefined" },
    commands: { openSidebar: { id: "chatgpt.openSidebar", registered: true },
      newChat: { id: "chatgpt.newChat", registered: false }, newPanel: { id: "chatgpt.newCodexPanel", registered: false } } });
});

test("control fails closed when missing, unregistered, or outside the allowlist", async () => {
  const calls = [];
  let present = false;
  let registered = [COMMANDS.openSidebar];
  const codex = createCommands({
    getCodex: () => present ? { isActive: false, version: "1.0.0", publicExportType: null } : undefined,
    getCommands: async () => registered,
    execute: async (...args) => calls.push(args),
  });
  assert.equal((await codex.inspect()).commands.openSidebar.registered, false);
  assert.equal(await codex.run("openSidebar"), "unavailable");
  present = true;
  assert.equal(await codex.run("newChat"), "unavailable");
  assert.equal(await codex.run("approve"), "unavailable");
  assert.equal(await codex.run("toString"), "unavailable");
  assert.equal(await codex.run("openCommandMenu"), "unavailable");
  assert.equal(await codex.run("openSidebar"), "invoked");
  registered = [COMMANDS.newChat];
  assert.equal(await codex.run("newChat"), "invoked");
  assert.deepEqual(calls, [[COMMANDS.openSidebar], [COMMANDS.newChat]]);
});

test("a rejected VS Code command is not reported as invoked", async () => {
  const codex = createCommands({
    getCodex: () => ({ isActive: true, version: "1.0.0", publicExportType: "undefined" }),
    getCommands: async () => [COMMANDS.openSidebar],
    execute: async () => { throw new Error("host error"); },
  });
  await assert.rejects(codex.run("openSidebar"), /host error/);
});
