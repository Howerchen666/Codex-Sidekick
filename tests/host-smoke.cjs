const assert = require("node:assert/strict");
const vscode = require("vscode");
const { setTimeout: delay } = require("node:timers/promises");
const manifest = require("../apps/vscode-extension/package.json");

async function run() {
  const sidekick = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  assert.ok(sidekick, "Sidekick should be loaded");
  const official = vscode.extensions.getExtension("openai.chatgpt");
  assert.ok(official, "OpenAI's official extension should be available");
  await official.activate();
  const before = await vscode.commands.executeCommand("codexSidekick.probe");
  assert.ok(before?.extension?.isActive, "Sidekick should detect the active official extension");
  assert.equal(before.commands.openSidebar.registered, true);
  assert.equal(before.commands.newChat.registered, true);
  const sidebar = await vscode.commands.executeCommand("codexSidekick.openSidebar");
  const newChat = await vscode.commands.executeCommand("codexSidekick.newChat");
  assert.equal(sidebar, "invoked");
  assert.equal(newChat, "invoked");
  await vscode.commands.executeCommand("chatgpt.newCodexPanel");
  const findPanel = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === "chatgpt.conversationEditor");
  const deadline = Date.now() + 3500;
  while (!findPanel() && Date.now() < deadline) await delay(25);
  const panel = findPanel();
  assert.ok(panel, "New Panel should open the official Codex editor");

  // Exercise the production navigation helper against the real VS Code API and
  // installed Codex provider. This disposable profile has no signed-in chats;
  // assert sidebar URI delivery, without sending a turn or touching real chats.
  const { outputFiles } = require("esbuild").buildSync({
    entryPoints: [require("node:path").join(__dirname, "../apps/vscode-extension/src/chat-tabs.ts")],
    bundle: true, platform: "node", format: "cjs", external: ["vscode"], write: false,
  });
  const navigation = { exports: {} };
  require("node:vm").runInNewContext(outputFiles[0].text, {
    module: navigation, exports: navigation.exports, require,
  });
  const { readdirSync, readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const logRoot = process.env.SIDEKICK_HOST_LOG_ROOT;
  assert.ok(logRoot, "Host runner should provide this disposable profile's log directory");
  function codexLog() {
    return readdirSync(logRoot, { recursive: true })
      .filter((name) => name.endsWith("openai.chatgpt/Codex.log"))
      .map((name) => readFileSync(join(logRoot, name), "utf8")).join("\n");
  }
  const tabCount = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
  const beforeNavigation = tabCount();
  for (const threadId of ["01999999-1234-7000-8000-123456789abc", "01999999-1234-7000-8000-123456789def"]) {
    const session = require("node:crypto").createHash("sha256").update(threadId).digest("hex").slice(0, 16);
    assert.equal(await navigation.exports.focusChatInSidebar(session, threadId), "invoked");
    const handled = () => codexLog().split("\n").some((line) =>
      line.includes("Handling URI") && line.includes("/local/" + threadId));
    const routeDeadline = Date.now() + 3500;
    while (!handled() && Date.now() < routeDeadline) await delay(25);
    assert.ok(handled(), "Codex's URI handler in this window should receive the exact sidebar route");
    assert.equal(tabCount(), beforeNavigation, "Sidebar navigation should keep the editor tab count stable");
  }
  console.log("SIDEKICK_HOST_REPORT " + JSON.stringify({
    vscode: vscode.version, sidekick: sidekick.id, ...before,
    controlSmoke: { sidebar, newChat, newPanel: "opened", sidebarConversationRoute: "two-routes-delivered" },
    navigationCommands: (await vscode.commands.getCommands(true)).filter((id) =>
      id.startsWith("chatgpt.") && /open|switch|focus|resume|select/i.test(id)),
  }));
}
module.exports = { run };
