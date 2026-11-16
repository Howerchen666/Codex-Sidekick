import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { observationId } from "../packages/hook-recorder/metadata.mts";
import { receive, send, VERSION } from "../packages/neo-bridge/protocol.mts";

test("the bridge resolves known chat IDs privately and rejects forged targets", async (t) => {
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/bridge.ts"], bundle: true, platform: "node", format: "cjs",
    external: ["./titles.mts"], write: false,
  });
  const threadId = "01999999-1234-7000-8000-123456789abc";
  const session = observationId(threadId);
  const workspace = observationId("/another/project");
  const recentChat = { session, workspace, title: "A recent chat", at: new Date().toISOString() };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, AbortController, setTimeout, clearTimeout,
    require: (name) => name === "./titles.mts" ? { readCodexMetadata: async () => ({
      titles: new Map(), recentChats: [recentChat], chatResources: new Map([[session, { threadId, workspace }]]),
    }) } : require(name),
  });
  const dir = await mkdtemp("/tmp/sk-select-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const stop = module.exports.startBridge({
    workspace: "Fixture", workspacePath: dir, log: join(dir, "missing.ndjson"),
    run: async () => "unavailable", error: (error) => assert.fail(String(error)),
    focusChat: async (...args) => { calls.push(args); return "invoked"; },
  }, dir);
  t.after(stop);
  const { readdir } = await import("node:fs/promises");
  const socketName = (await readdir(dir)).find((name) => name.endsWith(".sock"));
  const peer = createConnection(join(dir, socketName));
  t.after(() => peer.destroy());
  const messages = [];
  receive(peer, (message) => messages.push(message));
  peer.on("error", (error) => assert.fail(error.message));
  await new Promise((resolve) => peer.once("connect", resolve));
  send(peer, { type: "hello", version: VERSION });
  async function until(check) {
    const deadline = Date.now() + 3500;
    while (!check()) {
      if (Date.now() > deadline) assert.fail("Timed out waiting for bridge");
      await delay(10);
    }
  }
  await until(() => messages.some((message) => message.recentChats?.length));
  assert.equal(JSON.stringify(messages).includes(threadId), false);
  assert.equal(JSON.stringify(messages).includes("chatResources"), false);
  for (const [id, target, expected] of [
    [1, { session, workspace }, "invoked"],
    [2, { session, workspace: observationId("/forged/project") }, "unavailable"],
    [3, { session: observationId("unlisted-chat"), workspace }, "unavailable"],
  ]) {
    send(peer, { type: "command", id, action: "focusChat", target });
    await until(() => messages.some((message) => message.type === "result" && message.id === id));
    assert.equal(messages.find((message) => message.type === "result" && message.id === id).outcome, expected);
  }
  assert.deepEqual(calls, [[session, threadId]]);
});
