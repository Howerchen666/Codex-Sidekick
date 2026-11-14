import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { build } from "esbuild";

test("a window only counts another window's bridge when that process is still alive", async (t) => {
  const { outputFiles } = await build({
    entryPoints: ["apps/vscode-extension/src/bridge.ts"], bundle: true,
    platform: "node", format: "cjs", external: ["vscode"], write: false,
  });
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require, process });
  const { otherBridgeRunning } = module.exports;
  const dir = await mkdtemp("/tmp/sk-presence-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(otherBridgeRunning(join(dir, "missing")), false);
  assert.equal(otherBridgeRunning(dir), false);
  await writeFile(join(dir, `ide-${process.pid}-aabbccddeeff.sock`), ""); // this window's own bridge
  await writeFile(join(dir, "notes.txt"), "");
  assert.equal(otherBridgeRunning(dir), false);
  const peer = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"]);
  t.after(() => peer.kill());
  await writeFile(join(dir, `ide-${peer.pid}-112233445566.sock`), "");
  assert.equal(otherBridgeRunning(dir), true);
  peer.kill();
  await new Promise((resolve) => peer.once("exit", resolve));
  assert.equal(otherBridgeRunning(dir), false); // a crashed window's leftover socket is ignored
});
