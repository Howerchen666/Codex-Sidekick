import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activityLogPath, setupActivity } from "../apps/vscode-extension/src/setup.mts";

test("workspace setup installs a recorder, reuses the log, and preserves existing hooks", async (t) => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "sidekick-activity-")));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const codexHome = join(tmp, "codex home with 'quotes'");
  const options = {
    codexHome, storage: join(tmp, "storage with 'quotes'"),
    recorder: fileURLToPath(new URL("../apps/vscode-extension/dist/recorder.mjs", import.meta.url)),
  };
  const installed = await setupActivity(options);
  assert.equal(installed.configured, true);
  assert.equal(installed.created, true);
  // The bridge finds the log from the workspace alone, with no stored preference to lose.
  assert.equal(activityLogPath(options.storage), installed.log);
  const configPath = join(codexHome, "hooks.json");
  const config = await readFile(configPath, "utf8");
  const { command } = JSON.parse(config).hooks.UserPromptSubmit[0].hooks[0];
  const run = spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify({ cwd: tmp, session_id: "test-session", hook_event_name: "UserPromptSubmit", prompt: "private" }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  const row = JSON.parse(await readFile(installed.log, "utf8"));
  assert.equal(row.event, "UserPromptSubmit");
  assert.deepEqual(Object.keys(row).sort(), ["at", "event", "session", "workspace"]);
  assert.equal((await lstat(installed.log)).mode & 0o777, 0o600);

  const repeated = await setupActivity(options);
  assert.equal(repeated.log, installed.log);
  assert.equal(repeated.configured, true);
  assert.equal(repeated.created, false); // an automatic re-run is silent
  assert.equal(await readFile(configPath, "utf8"), config);

  const unrelated = { hooks: [{ type: "command", command: "/bin/true" }] };
  const existingConfig = JSON.parse(config);
  existingConfig.hooks.Stop[0].hooks[0].command = existingConfig.hooks.Stop[0].hooks[0].command
    .replace(/record-[a-f0-9]{16}/, "record-0000000000000000");
  existingConfig.hooks.Stop.unshift(unrelated);
  const existing = JSON.stringify(existingConfig) + "\n";
  await writeFile(configPath, existing);
  const draft = await setupActivity(options);
  assert.equal(draft.configured, false);
  assert.equal(draft.merged, true);
  assert.deepEqual(JSON.parse(draft.content).hooks.Stop, [unrelated, ...JSON.parse(config).hooks.Stop]);
  assert.equal(await readFile(configPath, "utf8"), existing);
  assert.deepEqual(JSON.parse(await readFile(installed.log, "utf8")), row);
});
