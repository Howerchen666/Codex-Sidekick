import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activityLogPath, setupActivity } from "../apps/vscode-extension/src/setup.mts";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

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

test("repeated setup keeps the validated Node executable after a transient probe failure", async (t) => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), "sidekick-node-")));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/setup.mts"], bundle: true,
    platform: "node", format: "cjs", write: false,
  });
  const probes = [];
  let cold = true;
  const execFile = () => assert.fail("Node discovery should use the promisified probe");
  execFile[promisify.custom] = async (candidate) => {
    probes.push(candidate);
    if (candidate === "/opt/homebrew/bin/node" && cold) {
      cold = false;
      throw new Error("First launch timed out");
    }
    return { stdout: "22.23.4\n", stderr: "" };
  };
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, process,
    require: (name) => name === "node:child_process" ? { execFile } : require(name),
  });
  const options = {
    codexHome: join(tmp, "codex"), storage: join(tmp, "storage"),
    recorder: fileURLToPath(new URL("../apps/vscode-extension/dist/recorder.mjs", import.meta.url)),
  };
  const installed = await module.exports.setupActivity(options);
  const configPath = join(options.codexHome, "hooks.json");
  const original = await readFile(configPath, "utf8");
  const repeated = await module.exports.setupActivity(options);
  assert.equal(installed.configured, true);
  assert.equal(repeated.configured, true, "A warmed-up alternative Node must not change installed hooks");
  assert.equal(repeated.created, false);
  assert.equal(repeated.content, original);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(probes, ["/opt/homebrew/bin/node", "/opt/homebrew/opt/node@22/bin/node"]);
});
