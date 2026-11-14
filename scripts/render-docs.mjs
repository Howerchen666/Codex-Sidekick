// Renders the README images from the plugin's own drawing code, so they always match the real keys.
// Usage: npm run docs:images
import { mkdirSync, writeFileSync } from "node:fs";
import { controlArt, infobarText, sessionArt } from "../apps/streamdeck-plugin/src/art.mts";
import { infobarImage } from "../apps/streamdeck-plugin/src/infobar-image.mts";

const out = new URL("../docs/images/", import.meta.url);
mkdirSync(out, { recursive: true });

const now = Date.parse("2026-01-01T12:00:00Z");
const hex = (n) => String(n).repeat(16);
const chats = [
  { observation: "Working observed", event: "PreModelRequest", title: "Fix flaky login test", age: 5 },
  { observation: "Approval requested", event: "PermissionRequest", title: "Update the build script", age: 10 },
  { observation: "Stop observed", event: "Stop", title: "Explain the cache layer", age: 15 },
  { observation: "Unknown", event: "Stop", title: "Draft release notes", age: 600 },
].map((chat, i) => ({ ...chat, session: hex(i + 1), workspace: hex(9), at: new Date(now - chat.age * 1000).toISOString() }));
const state = {
  mode: "connected", workspace: "my-project", feed: true, chatTabs: true,
  recentChats: chats.map(({ session, workspace, title, at }) => ({ session, workspace, title, at })),
  sessions: chats.map(({ session, workspace, at, event, observation }) =>
    ({ session, workspace, at, event, observation, expiresAt: now + 60_000 })),
};

// Pick the moment of each tile's pulse that shows the strongest glow.
const peak = (i) => Date.parse(chats[i].at) + 1125;
const body = (svg) => svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
const tile = (svg, x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 72 72">${body(svg)}</svg>`;

const size = 112, gap = 14, pad = 24, labelH = 30;
const captions = [["Working", "blue pulse"], ["Approval", "amber pulse"], ["Turn ended", "green glow"], ["Idle", "no glow"]];
const commands = ["openSidebar", "newChat", "newPanel", "dictate"];
const width = pad * 2 + 4 * size + 3 * gap;
const row2 = pad + size + labelH + gap;
const height = row2 + size + pad;
let content = "";
chats.forEach((_, i) => {
  const x = pad + i * (size + gap);
  content += tile(sessionArt(i, state, i === 3 ? now : peak(i)).replace(/glow-\d/g, `glow-${i}`), x, pad, size);
  content += `<text x="${x + size / 2}" y="${pad + size + 16}" text-anchor="middle" font-size="13" font-weight="700" fill="#F2F1EC">${captions[i][0]}</text>`;
  content += `<text x="${x + size / 2}" y="${pad + size + 31}" text-anchor="middle" font-size="11" fill="#A9AAA3">${captions[i][1]}</text>`;
});
commands.forEach((action, i) => {
  const x = pad + i * (size + gap);
  content += tile(controlArt(action, true), x, row2, size);
});
writeFileSync(new URL("keys.svg", out), `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Helvetica, sans-serif"><title>Codex Sidekick keys on a Stream Deck Neo</title><rect width="${width}" height="${height}" rx="18" fill="#1E1F1C"/>${content}</svg>\n`);

const usageState = { ...state, usage: {
  at: new Date(now).toISOString(),
  fiveHour: { remainingPercent: 70, resetsAt: Math.floor(now / 1000) + 3600 },
  weekly: { remainingPercent: 95, resetsAt: Math.floor(now / 1000) + 86_400 },
}, sessions: state.sessions.map((row, i) => i === 0 ? { ...row, usage: { at: new Date(now - 2000).toISOString(), tokens: 12_400 } } : row) };
writeFileSync(new URL("infobar.png", out), infobarImage(infobarText(usageState, now)));
console.log("Wrote docs/images/keys.svg and docs/images/infobar.png");
