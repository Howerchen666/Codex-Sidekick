import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { infobarImage } from "../apps/streamdeck-plugin/src/infobar-image.mts";
import { receive, send } from "../packages/neo-bridge/protocol.mts";

test("Neo layout fits the display and has no overlapping elements at the same depth", async () => {
  const layout = JSON.parse(await readFile(new URL(
    "../apps/streamdeck-plugin/dev.sidekick.codex.sdPlugin/layouts/neo.json", import.meta.url), "utf8"));
  for (const [index, item] of layout.items.entries()) {
    const [x, y, width, height] = item.rect;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 232 && y + height <= 50, item.key);
    for (const other of layout.items.slice(index + 1)) {
      if ((item.zOrder ?? 0) !== (other.zOrder ?? 0)) continue;
      const [otherX, otherY, otherWidth, otherHeight] = other.rect;
      const overlaps = x < otherX + otherWidth && otherX < x + width &&
        y < otherY + otherHeight && otherY < y + height;
      assert.equal(overlaps, false, `${item.key} overlaps ${other.key}`);
    }
  }
});

test("bundled plugin emits native-size pixel feedback, animates chats, and routes the displayed command", async (t) => {
  const runtime = await mkdtemp("/tmp/sk-sdk-");
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const sockets = new Set();
  const commands = [];
  const targets = [];
  const nativeArguments = join(runtime, "native-arguments.json");
  const nativeHelper = join(runtime, "fake-native-helper.mjs");
  await writeFile(nativeHelper, '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\n' +
    `writeFileSync(${JSON.stringify(nativeArguments)},JSON.stringify(process.argv.slice(2)));\n` +
    'console.log(JSON.stringify({outcome:"native-state-confirmed",nativeControlPressed:true,workspaceMatched:true,actionRequested:"start",nativeState:"recording"}));\n', {mode:0o600});
  const bridge = createServer((peer) => {
    sockets.add(peer);
    peer.on("error", () => peer.destroy());
    receive(peer, (msg) => {
      if (msg.type === "hello") send(peer, {
        type: "state", workspace: "Fixture", feed: true, chatTabs: true,
        usage: {
          at: new Date().toISOString(),
          fiveHour: { remainingPercent: 70, resetsAt: Math.floor(Date.now() / 1000) + 2 },
          weekly: { remainingPercent: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        }, sessions: [{
          at: new Date().toISOString(), event: "PermissionRequest", session: "1".repeat(16),
          workspace: "2".repeat(16), expiresAt: Date.now() + 15_000, observation: "Approval requested",
          title: "Fix & test", usage: { at: new Date(Date.now() - 1000).toISOString(), tokens: 12400 },
        }],
      });
      if (msg.type === "command") {
        commands.push(msg.action);
        if (msg.target) targets.push(msg.target);
        send(peer, { type: "result", id: msg.id, outcome: "invoked" });
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); bridge.close(); });
  const socketPath = join(runtime, `ide-${process.pid}-aabbccddeeff.sock`);
  await new Promise((resolve, reject) => bridge.listen(socketPath, resolve).once("error", reject));
  await chmod(socketPath, 0o600);

  const deck = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(() => { for (const client of deck.clients) client.terminate(); deck.close(); });
  await new Promise((resolve, reject) => deck.once("listening", resolve).once("error", reject));
  const received = [];
  let peer;
  const uuid = "dev.sidekick.codex";
  const sendKey = (name, context, controller, event = "willAppear") => peer.send(JSON.stringify({
    event, action: uuid + "." + name, device: "device", context,
    payload: { controller, coordinates: { column: 0, row: 0 }, settings: {}, resources: {}, state: 0 },
  }));
  deck.on("connection", (socket) => {
    peer = socket;
    peer.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.event === "registerPlugin") {
        sendKey("slot-1", "slot", "Keypad");
        sendKey("opencommandmenu", "menu", "Keypad");
        sendKey("newpanel", "panel", "Keypad");
        sendKey("infobar", "bar", "Neo");
      }
    });
  });
  const port = deck.address().port;
  // The SDK reads its manifest and writes logs relative to its working directory.
  const pluginDir = join(runtime, uuid + ".sdPlugin");
  await mkdir(pluginDir);
  await copyFile(new URL("../apps/streamdeck-plugin/dev.sidekick.codex.sdPlugin/manifest.json", import.meta.url),
    join(pluginDir, "manifest.json"));
  // The test bundle has only its socket root substituted. All production action
  // registrations, rendering and command routing use the same code.
  const { build } = await import("esbuild");
  const entry = fileURLToPath(new URL("../apps/streamdeck-plugin/src/index.mts", import.meta.url));
  const bundle = join(runtime, "plugin.mjs");
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", target: "node22", format: "esm",
    define: { "process.env.SIDEKICK_TEST_SOCKET_ROOT": JSON.stringify(runtime),
      "process.env.SIDEKICK_TEST_DICTATION_HELPER": JSON.stringify(nativeHelper) },
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
  const child = spawn(process.execPath, [bundle, "-port", String(port), "-pluginUUID", uuid, "-registerEvent", "registerPlugin",
    "-info", JSON.stringify({ application: { version: "7.6.1", language: "en" }, devices: [{ id: "device", name: "Neo fixture", size: { columns: 4, rows: 2 }, type: 9 }], plugin: { uuid } })],
    { cwd: pluginDir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-4096); });
  t.after(() => child.kill());
  const find = (event, context, match = () => true) => received.find((m) => m.event === event && m.context === context && match(m.payload));
  const waitFor = async (check) => {
    const until = Date.now() + 3500;
    while (!check()) {
      if (child.exitCode !== null || Date.now() >= until) assert.fail(`No expected Stream Deck messages: ${stderr}\n${received.map(m=>m.event).join(",")}`);
      await delay(20);
    }
  };
  const expectedFrame = (fiveHour) => "data:image/png;base64," + infobarImage({
    fiveHourLabel: "5h left", fiveHour, fiveHourColor: "#171816",
    weeklyLabel: "Week left", weekly: "95%", weeklyColor: "#171816",
    tokenLabel: "Tokens", tokens: "12.4K",
  }).toString("base64");
  const hasText = (str) => (payload) => typeof payload?.image === "string" && decodeURIComponent(payload.image).includes(str);
  await waitFor(() => find("setFeedbackLayout", "bar") && find("setFeedback", "bar", (p) =>
    p?.pixels === expectedFrame("70%")) &&
    find("setImage", "slot", hasText("#F0AE28")) && find("setImage", "slot", hasText("Fix &amp;")) &&
    find("setImage", "menu", hasText(">Dictate<")));
  await waitFor(() => new Set(received.filter((m) => m.event === "setImage" && m.context === "slot")
    .map((m) => m.payload.image)).size >= 2);
  assert.ok(!find("setImage", "slot", hasText(">111111<")));
  assert.ok(!find("setImage", "slot", hasText(">Approval<")));
  sendKey("opencommandmenu", "menu", "Keypad", "keyDown");
  await waitFor(() => find("showOk", "menu"));
  assert.deepEqual(JSON.parse(await readFile(nativeArguments,"utf8")),["--toggle","--workspace","Fixture"]);
  // A composer that is already visible is pressed as it is; the sidebar command is not sent.
  assert.deepEqual(commands, []);
  sendKey("slot-1", "slot", "Keypad", "keyDown");
  await waitFor(() => find("showOk", "slot"));
  assert.deepEqual(targets, [{ session: "1".repeat(16), workspace: "2".repeat(16) }]);
  assert.ok(find("setImage", "panel", hasText(">Panel<")));
  sendKey("newpanel", "panel", "Keypad", "keyDown");
  await waitFor(() => find("showOk", "panel"));
  assert.deepEqual(commands, ["focusChat", "newPanel"]);
  await waitFor(() => find("setFeedback", "bar", (p) =>
    p?.pixels === expectedFrame("—")));

});
