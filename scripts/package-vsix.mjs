import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The installer is named from the extension's own manifest, so there is one place to bump.
const extension = "apps/vscode-extension";
const { version } = JSON.parse(readFileSync(join(extension, "package.json"), "utf8"));
const artifact = join("release", `codex-sidekick-neo-${version}.vsix`);
mkdirSync("release", { recursive: true });
const result = spawnSync("vsce", ["package", "--no-dependencies", "--allow-missing-repository",
  "--out", resolve(artifact)], { cwd: extension, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
else console.log(artifact);
