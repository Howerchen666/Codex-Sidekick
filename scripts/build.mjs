import { build } from "esbuild";
import { rm } from "node:fs/promises";

const plugin = "apps/streamdeck-plugin/dev.sidekick.codex.sdPlugin";
const extensionOutput = "apps/vscode-extension/dist";
const common = { bundle: true, platform: "node", target: "node22", logLevel: "info" };
await rm(extensionOutput, { recursive: true, force: true });
await Promise.all([
  build({ ...common, entryPoints: ["apps/vscode-extension/src/extension.ts"],
    outdir: extensionOutput, format: "cjs", external: ["vscode"] }),
  build({ ...common, entryPoints: ["packages/hook-recorder/record.mts"],
    outfile: extensionOutput + "/recorder.mjs", format: "esm" }),
  build({ ...common, entryPoints: ["apps/streamdeck-plugin/src/index.mts"], outfile: plugin + "/plugin.mjs", format: "esm",
    define: { "process.env.SIDEKICK_TEST_SOCKET_ROOT": "undefined", "process.env.SIDEKICK_TEST_DICTATION_HELPER": "undefined" },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } }),
]);
