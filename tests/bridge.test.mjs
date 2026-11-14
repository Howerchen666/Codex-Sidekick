import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { receive, send } from "../packages/neo-bridge/protocol.mts";
import { chatTiles, connectDeck } from "../apps/streamdeck-plugin/src/link.mts";
import { watchFeed } from "../packages/hook-recorder/feed.mts";
import { isAnimated, sessionArt } from "../apps/streamdeck-plugin/src/art.mts";
import { observationFor } from "../packages/hook-recorder/observations.mts";

async function until(check) {
  const end = Date.now() + 3500;
  while (!check()) {
    if (Date.now() >= end) assert.fail("Timed out waiting for state");
    await wait(25);
  }
}

test("Neo transport binds controls to one connected window and reconnects without replay", async (t) => {
  const dir = await mkdtemp("/tmp/sk-link-");
  t.after(() => rm(dir, { force: true, recursive: true }));
  const calls = [];
  const endpoints = [];
  async function serve(name, workspace) {
    const socketPath = join(dir, `ide-${process.pid}-${name}.sock`);
    const connections = new Set();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => connections.delete(socket));
      receive(socket, (msg) => {
        if (msg.type === "hello") send(socket, { type: "state", workspace, feed: true, sessions: [] });
        else {
          calls.push([workspace, msg.action]);
          send(socket, { type: "result", id: msg.id, outcome: "invoked" });
        }
      });
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    await chmod(socketPath, 0o600);
    const close = () => {
      for (const socket of connections) socket.destroy();
      server.close();
    };
    endpoints.push(close);
    return close;
  }
  const first = await serve("aaaaaaaaaaaa", "A");
  let state;
  const deck = connectDeck((next) => { state = next; }, dir);
  t.after(() => { deck.close(); for (const close of endpoints) close(); });
  await until(() => state?.mode === "connected");
  assert.equal(await deck.command("newChat"), true);
  const second = await serve("bbbbbbbbbbbb", "B");
  await until(() => state?.mode === "multiple");
  assert.equal(await deck.command("newPanel"), false);
  first();
  second();
  await until(() => state?.mode === "offline");
  assert.equal(await deck.command("openSidebar"), false);
  await serve("cccccccccccc", "C");
  await until(() => state?.mode === "connected" && state.workspace === "C");
  assert.equal(await deck.command("openSidebar"), true);
  assert.deepEqual(calls, [["A", "newChat"], ["C", "openSidebar"]]);
});

test("feed shows an approval observation, then falls back to Unknown on loss", async (t) => {
  const dir = await mkdtemp("/tmp/sk-feed-");
  t.after(() => rm(dir, { force: true, recursive: true }));
  const path = join(dir, "events.ndjson");
  await writeFile(path, "", { mode: 0o600 });
  let state = { mode: "connected", workspace: "test", feed: false, sessions: [] };
  const close = watchFeed(path, (sessions, feed) => { state = { ...state, sessions, feed }; });
  t.after(close);
  await until(() => state.feed);
  await appendFile(path, JSON.stringify({
    at: new Date().toISOString(), event: "PermissionRequest", session: "a".repeat(16), workspace: "b".repeat(16),
  }) + "\n");
  await until(() => state.sessions[0]?.observation === "Approval requested");
  await rm(path);
  await until(() => state.sessions[0]?.observation === "Unknown");
});

test("recent chat keys work before hooks and only show live tints from actual observations", async (t) => {
  const dir = await mkdtemp("/tmp/sk-recent-");
  t.after(() => rm(dir, { force: true, recursive: true }));
  const now = Date.now();
  const chat = { title: "Across projects", session: "a".repeat(16), workspace: "b".repeat(16),
    at: new Date(now - 1000).toISOString() };
  const { session, workspace } = chat;
  const target = { session, workspace };
  let peer;
  let focused;
  const bridge = createServer((connection) => {
    peer = connection;
    receive(peer, (msg) => {
      if (msg.type === "hello") send(peer, { type: "state", workspace: "New folder", feed: false, chatTabs: true,
        sessions: [], recentChats: [chat] });
      if (msg.type === "command" && msg.action === "focusChat") {
        focused = msg.target;
        send(peer, { type: "result", id: msg.id, outcome: "invoked" });
      }
    });
  });
  const socket = join(dir, `ide-${process.pid}-aabbccddeeff.sock`);
  await new Promise((resolve, reject) => bridge.listen(socket, resolve).once("error", reject));
  await chmod(socket, 0o600);
  let state;
  const deck = connectDeck((next) => { state = next; }, dir);
  t.after(() => { deck.close(); peer?.destroy(); bridge.close(); });
  await until(() => state?.mode === "connected");
  assert.match(sessionArt(0, state, now), /Across/);
  assert.equal(isAnimated(0, state, now), false);
  assert.equal(await deck.focusChat(target), true);
  assert.deepEqual(focused, target);
  assert.equal(await deck.focusChat({ ...target, session: "c".repeat(16) }), false);
  assert.equal(chatTiles(state)[0].activity, undefined);
  const activity = observationFor({ ...target, workspace: "d".repeat(16), at: new Date(now).toISOString(),
    event: "PreModelRequest" }, now, true);
  send(peer, { type: "state", workspace: "New folder", feed: true, chatTabs: true, sessions: [activity], recentChats: [chat] });
  await until(() => isAnimated(0, state, now));
  assert.equal(chatTiles(state).length, 1);
  assert.match(sessionArt(0, state, now), /#479BEF/);
  send(peer, { type: "state", workspace: "New folder", feed: false, chatTabs: true, sessions: [], recentChats: [chat] });
  await until(() => !state.feed);
  assert.match(sessionArt(0, state, now), /Across/);
  assert.equal(isAnimated(0, state, now), false);
});
