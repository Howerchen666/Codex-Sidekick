import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { build } from "esbuild";
import { observationId } from "../packages/hook-recorder/metadata.mts";

test("title lookup recovers archived chats after reload and retains active names", async () => {
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/titles.mts"], bundle: true,
    platform: "node", format: "cjs", write: false,
  });
  const requests = [];
  const metadata = (id, name) => ({
    id, name, cwd: "/fixture", preview: "private prompt excluded from result",
  });
  function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    let killed = false;
    child.kill = () => {
      if (killed) return false;
      killed = true;
      setImmediate(() => child.emit("exit", 0));
      return true;
    };
    child.stdin.on("data", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      if (!Object.hasOwn(request, "id")) return;
      let result;
      if (request.method === "initialize") result = {};
      else if (request.method === "account/rateLimits/read") {
        result = { rateLimits: { limitId: "codex", primary: { usedPercent: 41, windowDurationMins: 300 } } };
      } else if (request.method === "thread/list" && !request.params.cwd) {
        const recent = (id, title, cwd = "/another/project") =>
          ({ ...metadata(id, title), cwd, updatedAt: Math.floor(Date.now() / 1000) });
        result = { data: [recent("other-workspace", "Another project"), recent("unnamed", null),
          recent("archived", "Archived title"), recent("invalid", "Invalid path", "relative"),
          recent("other-workspace", "Duplicate")] };
        result.data[2].archived = true;
      } else result = {
        data: request.params.archived
          ? [metadata("old-session", "Archived name"), metadata("unrelated-session", "Unrelated name")]
          : [metadata("current-session", "Current name")],
      };
      setImmediate(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
    });
    return child;
  }
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, setTimeout, clearTimeout,
    require: (name) => {
      if (name === "node:child_process") return { spawn };
      if (name === "node:fs/promises") return { access: async () => {}, realpath: async () => "/fixture" };
      return require(name);
    },
  });
  const sessions = new Set(["current-session", "old-session"].map(observationId));
  const metadataResult = await module.exports.readCodexMetadata({
    workspace: "/fixture", sessions, signal: new AbortController().signal, includeUsage: false,
  });
  const result = metadataResult.titles;
  assert.equal(result.size, 2);
  assert.equal(result.get(observationId("current-session")), "Current name");
  assert.equal(result.get(observationId("old-session")), "Archived name");
  assert.equal(result.has(observationId("unrelated-session")), false);
  assert.equal(metadataResult.chatResources.get(observationId("current-session")).threadId, "current-session");
  assert.equal(metadataResult.chatResources.get(observationId("old-session")).threadId, "old-session");
  assert.equal(metadataResult.chatResources.has(observationId("unrelated-session")), false);
  assert.equal(requests.filter((request) => request.method === "thread/list").length, 2);
  assert.ok(requests.filter((request) => request.method === "thread/list").every((request) =>
    request.params.useStateDbOnly === true && request.params.cwd === "/fixture"));
  const combined = await module.exports.readCodexMetadata({
    workspace: "/fixture", sessions, signal: new AbortController().signal, includeUsage: true,
  });
  assert.equal(combined.titles.size, 2);
  assert.equal(combined.usage.fiveHour.remainingPercent, 59);
  const requestCount = requests.length;
  const accountOnly = await module.exports.readCodexMetadata({
    workspace: "/fixture", sessions: new Set(), signal: new AbortController().signal, includeUsage: true,
  });
  assert.equal(accountOnly.titles.size, 0);
  assert.equal(accountOnly.usage.fiveHour.remainingPercent, 59);
  assert.ok(requests.slice(requestCount).every((request) => request.method !== "thread/list"));

  const recent = await module.exports.readCodexMetadata({
    workspace: "/fixture", sessions: new Set(), signal: new AbortController().signal, includeUsage: false, includeRecent: true,
  });
  assert.deepEqual(Array.from(recent.recentChats, (chat) => chat.title), ["Another project", "Untitled chat"]);
  assert.deepEqual(Object.keys(recent.recentChats[0]).sort(), ["at", "session", "title", "workspace"]);
  assert.equal(recent.chatResources.get(observationId("other-workspace")).threadId, "other-workspace");
  assert.equal(recent.chatResources.get(observationId("other-workspace")).workspace, observationId("/another/project"));
  assert.equal(recent.chatResources.get(observationId("unnamed")).threadId, "unnamed");
  assert.equal(recent.chatResources.has(observationId("archived")), false);
  assert.equal(recent.chatResources.has(observationId("invalid")), false);
  const query = requests.findLast((request) => request.method === "thread/list");
  assert.equal(query.params.cwd, undefined);
  assert.equal(query.params.currentAccountOnly, true);
  assert.equal(query.params.archived, undefined);
});
