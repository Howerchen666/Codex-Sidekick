import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = "apps/streamdeck-plugin/dev.sidekick.codex.sdPlugin";
const { UUID, Version } = JSON.parse(readFileSync(join(plugin, "manifest.json"), "utf8"));
const release = Version.split(".").slice(0, 3).join(".");
const scratch = mkdtempSync(join(tmpdir(), "sidekick-pack-"));
try {
  const result = spawnSync("streamdeck", ["pack", plugin, "--output", scratch, "--no-update-check"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    mkdirSync("release", { recursive: true });
    const artifact = join("release", `${UUID}-${release}.streamDeckPlugin`);
    renameSync(join(scratch, UUID + ".streamDeckPlugin"), artifact);
    console.log(artifact);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
