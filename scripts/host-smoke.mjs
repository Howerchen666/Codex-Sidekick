import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const vscodeBin = process.argv[2] ?? "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const installed = process.argv[3] ?? join(homedir(), ".vscode/extensions");
const root = process.argv[4] ?? "/tmp";
const codex = readdirSync(installed).filter((name) => name.startsWith("openai.chatgpt-"));
if (codex.length !== 1) throw new Error("Use an extensions directory containing exactly one official Codex extension.");
const officialPath = realpathSync(join(installed, codex[0]));
const manifest = JSON.parse(readFileSync(join(officialPath, "package.json"), "utf8"));
if (manifest.publisher !== "openai" || manifest.name !== "chatgpt") throw new Error("Unexpected official extension ID.");

const scratch = mkdtempSync(join(root, "sidekick-host-"));
const extensions = join(scratch, "extensions");
const workspace = join(scratch, "workspace");
mkdirSync(extensions);
mkdirSync(workspace);
const codexState = join(scratch, "codex");
mkdirSync(codexState, { mode: 0o700 });
const userData = join(scratch, "user");
mkdirSync(join(userData, "User"), { recursive: true });
// Model a user who has already confirmed Codex's URI handler in this test-only
// profile, so the sidebar smoke can run unattended.
writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
  "extensions.confirmedUriHandlerExtensionIds": ["openai.chatgpt"],
}));
const project = fileURLToPath(new URL("../", import.meta.url));
const args = [
  "--user-data-dir", userData, "--extensions-dir", extensions,
  "--skip-welcome", "--skip-release-notes",
  "--extensionDevelopmentPath=" + join(project, "apps/vscode-extension"),
  "--extensionDevelopmentPath=" + officialPath,
  "--extensionTestsPath=" + join(project, "tests/host-smoke.cjs"),
  workspace,
];
console.log("Isolated VS Code test profile: " + scratch);
// Inside a VS Code terminal or extension host this variable makes the Code binary behave as plain Node.
const { ELECTRON_RUN_AS_NODE: _inherited, ...environment } = process.env;
const child = spawn(vscodeBin, args, {
  env: { ...environment, CODEX_HOME: codexState, SIDEKICK_HOST_LOG_ROOT: join(userData, "logs") },
  stdio: ["ignore", "pipe", "pipe"],
});
let reported = false;
let output = "";
child.stdout.on("data", (chunk) => {
  output = (output + chunk.toString()).slice(-32_768);
  for (const line of output.split("\n").slice(0, -1)) {
    if (line.includes("SIDEKICK_HOST_REPORT ") || /AssertionError|SIDEKICK_HOST_ERROR/.test(line)) {
      console.log(line);
      if (line.includes("SIDEKICK_HOST_REPORT ")) reported = true;
    }
  }
  output = output.slice(output.lastIndexOf("\n") + 1);
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
const timer = setTimeout(() => {
  console.error("VS Code did not finish the host smoke test within 35 seconds.");
  child.kill("SIGKILL");
}, 35_000);
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code, signal) => {
  clearTimeout(timer);
  if (code !== 0 || !reported) {
    if (stderr) console.error(stderr);
    console.error(`No successful host result (exit=${code}, signal=${signal}).`);
    process.exitCode = 1;
  }
});
