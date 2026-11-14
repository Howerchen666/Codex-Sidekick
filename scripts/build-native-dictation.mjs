import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Build the native dictation helper on macOS.");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = join(project, "apps/streamdeck-plugin/dev.sidekick.codex.sdPlugin/native");
mkdirSync(native, { recursive: true });
const binary = join(native, "dictation-helper");
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
execFileSync("/usr/bin/xcrun", ["swiftc", "-O", "-target", architecture + "-apple-macos13.0",
  "-framework", "AppKit", "-framework", "ApplicationServices", "-module-cache-path", "/tmp/sidekick-dictation-swift-cache",
  join(project, "apps/streamdeck-plugin/native-helper/main.swift"), "-o", binary], { stdio: "inherit" });
execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", binary], { stdio: "inherit" });
execFileSync(binary, ["--self-test"], { stdio: "inherit" });
