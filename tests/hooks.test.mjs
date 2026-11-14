import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hookConfig } from "../packages/hook-recorder/config.mts";

const recorder = fileURLToPath(new URL("../packages/hook-recorder/record.mts", import.meta.url));

/** A private log plus the generated user-level hook definitions. */
function makeFixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "sidekick-test-")));
  const home = join(temp, "codex home with 'quotes'");
  mkdirSync(home, { mode: 0o700 });
  const log = join(temp, "all.ndjson");
  writeFileSync(log, "", { flag: "wx", mode: 0o600 });
  const config = JSON.parse(hookConfig({ node: process.execPath, recorder, log, workspace: "*" }));
  const invoke = (event, fields = {}, input) => {
    const run = spawnSync("/bin/sh", ["-c", config.hooks[event][0].hooks[0].command], {
      input: input ?? JSON.stringify({ cwd: temp, session_id: "private-session", turn_id: "private-turn",
        hook_event_name: event, prompt: "private prompt", tool_input: { command: "private command" },
        transcript_path: "/private/transcript", ...fields }),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, event === "Stop" ? "{}\n" : "");
  };
  return { temp, log, config, invoke, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

test("hooks record redacted lifecycle and approval signals for any project, without issuing any decision", (t) => {
  const { temp, log, config, invoke, cleanup } = makeFixture();
  t.after(cleanup);
  for (const event of Object.keys(config.hooks)) invoke(event);
  invoke("PermissionRequest", { session_id: "other-session", turn_id: "other-turn" });
  // Sessions from other projects and other folders are all recorded.
  const elsewhere = join(temp, "another project");
  mkdirSync(elsewhere);
  invoke("SessionStart", { cwd: elsewhere, session_id: "elsewhere" });
  invoke("SessionStart", { cwd: "/", session_id: "root" });
  // Input that is not a well-formed hook event from an absolute directory is not evidence.
  invoke("SessionStart", { cwd: "relative-folder" });
  invoke("SessionStart", { session_id: null });
  invoke("SessionStart", { cwd: undefined });
  invoke("PermissionRequest", {}, "{invalid");
  invoke("PermissionRequest", { hook_event_name: "unsupported" });
  invoke("PermissionRequest", { hook_event_name: "SessionStart" });
  invoke("PostModelRequest", { token_usage: { total_tokens: 1234, private: "secret" } });
  invoke("PostModelRequest", { token_usage: { total_tokens: -4 } });
  const raw = readFileSync(log, "utf8");
  const records = raw.trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ event }) => event),
    [...Object.keys(config.hooks), "PermissionRequest", "SessionStart", "SessionStart", "PostModelRequest", "PostModelRequest"]);
  assert.equal(records[1].session, records[2].session);
  assert.notEqual(records[1].session, records[Object.keys(config.hooks).length].session);
  assert.equal(new Set(records.map((r) => r.session)).size, 4);
  const tokenRecord = records.at(-2);
  for (const record of records) {
    const keys = record === tokenRecord ? ["at", "event", "requestTokens", "session", "workspace"] :
      ["at", "event", "session", "workspace"];
    assert.deepEqual(Object.keys(record).sort(), keys);
    assert.equal(record.workspace, records[0].workspace);
  }
  assert.equal(tokenRecord.requestTokens, 1234);
  assert.doesNotMatch(raw, /private|secret|transcript|tool_input|cwd|decision|another project/);
});

test("the recorder never follows a replaced log and leaves approvals untouched", (t) => {
  const { temp, log, invoke, cleanup } = makeFixture();
  t.after(cleanup);
  const target = join(temp, "README.md");
  writeFileSync(target, "# keep\n");
  rmSync(log);
  symlinkSync(target, log);
  invoke("PermissionRequest");
  assert.equal(readFileSync(target, "utf8"), "# keep\n");
  rmSync(log);
  invoke("PermissionRequest"); // no collector or log available must still leave approval untouched
  invoke("Stop");
});

test("an oversized log is trimmed to its newest events instead of silently stopping", (t) => {
  const { log, invoke, cleanup } = makeFixture();
  t.after(cleanup);
  const old = JSON.stringify({ at: "2026-01-01T00:00:00.000Z", event: "Stop", session: "a".repeat(16), workspace: "b".repeat(16) });
  const rows = Array.from({ length: Math.ceil(600 * 1024 / (old.length + 1)) }, () => old);
  writeFileSync(log, rows.join("\n") + "\n", { mode: 0o600 });
  assert.ok(statSync(log).size > 512 * 1024);
  invoke("UserPromptSubmit", { session_id: "fresh" });
  const lines = readFileSync(log, "utf8").split("\n");
  assert.equal(lines.at(-1), "");
  const records = lines.slice(0, -1).map(JSON.parse); // every kept line is whole
  assert.ok(statSync(log).size < 80 * 1024);
  assert.equal(records.at(-1).event, "UserPromptSubmit");
  assert.ok(records.length > 100);
  invoke("Stop", { session_id: "fresh" });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").at(-1).includes('"Stop"'), true);
});
