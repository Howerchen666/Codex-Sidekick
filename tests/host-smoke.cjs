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
  console.log("SIDEKICK_HOST_REPORT " + JSON.stringify({
    vscode: vscode.version, sidekick: sidekick.id, ...before, controlSmoke: { sidebar, newChat, newPanel: "opened" },
    navigationCommands: (await vscode.commands.getCommands(true)).filter((id) =>
      id.startsWith("chatgpt.") && /open|switch|focus|resume|select/i.test(id)),
  }));
}
module.exports = { run };
