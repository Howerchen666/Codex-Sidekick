import { availableWindow, type AllowanceWindow } from "../../../packages/account-usage/usage.mts";
import type { Control } from "../../../packages/neo-bridge/protocol.mts";
import { chatTiles, type DeckState, type Session } from "./link.mts";

const colors = {
  paper: "#FAF9F5",
  ink: "#171816",
  muted: "#62645E",
  border: "#DADBD3",
};

const icons = {
  openSidebar: '<rect x="3.5" y="5" width="25" height="22" rx="3"/><path d="M12 5v22m-5.5-15h2m-2 5h2"/>',
  newChat: '<path d="M26 22H14l-7 5v-5H5V6h22v16ZM16 9.5v9m-4.5-4.5h9"/>',
  newPanel: '<rect x="4" y="5" width="24" height="22" rx="3"/><path d="M4 11h24m-10 0v16"/><path d="M22.5 16v6m-3-3h6"/>',
  dictate: '<rect x="12" y="4" width="8" height="15" rx="4"/><path d="M8 15v1a8 8 0 0 0 16 0v-1m-8 9v5m-4 0h8"/>',
};

type CommandArt = Control | "dictate";
type Lines = readonly [string, string?];

const commandLabels: Record<CommandArt, Lines> = {
  openSidebar: ["Open", "Codex"],
  newChat: ["New", "Chat"],
  newPanel: ["New", "Panel"],
  dictate: ["Dictate"],
};

const statusTints: Record<Session["observation"], string> = {
  "Session observed": "#A783DD",
  "Working observed": "#479BEF",
  "Model request returned": "#40B6CA",
  "Approval requested": "#F0AE28",
  "Stop observed": "#47B783",
  "Interrupt observed": "#EB7E6F",
  "Session end observed": "#DDDAD3",
  "Unknown": "#DDDAD3",
};

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const titleFontSize = 11.5;
const titleWidth = 60;
const titleLineCount = 3;
// Arial Bold advances for printable ASCII, in 1/1000 em. These match the SVG font.
const titleAdvances = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
const escape = (text: string) => text.replace(/[&<>"']/gu, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
})[character]!);

function splitTitle(title: string): string[] {
  const clusters = [...graphemes.segment(title)].map(({ segment }) => segment);
  const width = (cluster: string) => {
    if (/\p{Extended_Pictographic}/u.test(cluster)) return titleFontSize * 1.25;
    const code = cluster.normalize("NFD").codePointAt(0)!;
    return (titleAdvances[code - 32] ?? 1000) * titleFontSize / 1000;
  };
  const lines: string[] = [];
  for (let line = 0; clusters.length && line < titleLineCount; line++) {
    let end = 0;
    let size = 0;
    let space = 0;
    while (end < clusters.length && size + width(clusters[end]) <= titleWidth) {
      if (clusters[end] === " ") space = end;
      size += width(clusters[end++]);
    }
    const overflow = end < clusters.length;
    const lastLine = line === titleLineCount - 1;
    if (overflow && !lastLine && space >= 3) end = space;
    if (overflow && lastLine) {
      while (size + width("…") > titleWidth) size -= width(clusters[--end]);
    }
    const text = clusters.splice(0, end).join("").trim();
    if (clusters[0] === " ") clusters.shift();
    lines.push(escape(text) + (overflow && lastLine ? "…" : ""));
  }
  return lines;
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72" font-family="Arial, sans-serif">${content}</svg>`;
}

export function deckImage(markup: string): string {
  return "data:image/svg+xml," + encodeURIComponent(markup);
}

function commandGlyph(action: CommandArt, color: string): string {
  return `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[action]}</g>`;
}

export function controlArt(action: CommandArt, ready: boolean): string {
  const [first, second] = commandLabels[action];
  const foreground = ready ? colors.ink : colors.muted;
  return svg(
    `<rect x=".5" y=".5" width="71" height="71" rx="9" fill="${colors.paper}" stroke="${colors.border}"/>` +
    '<rect x="18" y="7" width="36" height="33" rx="9" fill="#EEEFE8"/>' +
    `<g transform="translate(22 9) scale(.875)">${commandGlyph(action, foreground)}</g>` +
    `<g fill="${foreground}" text-anchor="middle" font-weight="700" font-size="11.5">` +
    (second ? `<text x="36" y="52">${first}</text><text x="36" y="64">${second}</text>`
      : `<text x="36" y="58">${first}</text>`) + '</g>',
  );
}

function activityArt(index: number, title: string, tint: string, strength: number): string {
  const lines = splitTitle(title);
  const gradient = `glow-${index}`;
  return svg(
    `<defs><radialGradient id="${gradient}" cx="15%" cy="100%" r="120%">` +
    `<stop stop-color="${tint}" stop-opacity="${strength.toFixed(2)}"/>` +
    `<stop offset="1" stop-color="${tint}" stop-opacity="${(strength * 0.22).toFixed(2)}"/></radialGradient></defs>` +
    `<rect x=".5" y=".5" width="71" height="71" rx="9" fill="${colors.paper}" stroke="${colors.border}"/>` +
    `<rect x="1" y="1" width="70" height="70" rx="8" fill="url(#${gradient})" stroke="${tint}" stroke-width="1.5" stroke-opacity="${(strength * 0.8).toFixed(2)}"/>` +
    `<g fill="${colors.ink}" font-size="${titleFontSize}" font-weight="700">` +
    lines.map((line, index) => `<text x="6" y="${40 - (lines.length - 1) * 6.5 + index * 13}">${line}</text>`).join("") + '</g>',
  );
}

export function isAnimated(index: number, state: DeckState, now: number): boolean {
  if (state.mode !== "connected" || !state.feed) return false;
  const row = chatTiles(state)[index]?.activity;
  return Boolean(row && (row.observation === "Working observed" || row.observation === "Approval requested" ||
    (row.observation === "Stop observed" && now - Date.parse(row.at) < 3000)));
}

export function sessionArt(index: number, state: DeckState, now = Date.now()): string {
  const name = `Chat ${index + 1}`;
  if (state.mode !== "connected") {
    return activityArt(index, name, statusTints.Unknown, 0);
  }
  const tile = chatTiles(state)[index];
  if (!tile) return activityArt(index, name, statusTints.Unknown, 0);
  const row = tile.activity;
  if (!row) return activityArt(index, tile.title ?? name, statusTints.Unknown, 0);
  const observation = state.feed ? row.observation : "Unknown";
  const period = row.observation === "Approval requested" ? 3000 : 2250;
  const phase = Math.floor(Math.max(0, now - Date.parse(row.at)) / 250) * 250;
  const pulse = (1 - Math.cos(2 * Math.PI * phase / period)) / 2;
  const base = observation === "Unknown" ? 0 : 0.68;
  const strength = isAnimated(index, state, now) ? base + 0.28 * pulse : base;
  return activityArt(index, tile.title ?? name, statusTints[observation], strength);
}

export function infobarText(state: DeckState, now = Date.now()) {
  const empty = {
    fiveHourLabel: "5h left", fiveHour: "—", fiveHourColor: colors.ink,
    weeklyLabel: "Week left", weekly: "—", weeklyColor: colors.ink,
    tokenLabel: "Tokens", tokens: "—",
  };
  if (state.mode === "multiple") return { ...empty, fiveHourLabel: "VS Code", weeklyLabel: "2+ windows" };
  if (state.mode !== "connected") return { ...empty, fiveHourLabel: "VS Code", weeklyLabel: "Offline" };

  const format = (window: AllowanceWindow | undefined) => window ? `${window.remainingPercent}%` : "—";
  const color = (window: AllowanceWindow | undefined) => {
    if (!window) return colors.ink;
    if (window.remainingPercent <= 5) return "#A12D20";
    return window.remainingPercent <= 20 ? "#815100" : colors.ink;
  };
  const fiveHour = availableWindow(state.usage, state.usage?.fiveHour, now);
  const weekly = availableWindow(state.usage, state.usage?.weekly, now);
  const latest = state.feed ? state.sessions.reduce<Session["usage"]>((best, row) => {
    const usage = row.usage;
    return usage && (!best || Date.parse(usage.at) > Date.parse(best.at)) ? usage : best;
  }, undefined) : undefined;
  return {
    ...empty, fiveHour: format(fiveHour), fiveHourColor: color(fiveHour),
    weekly: format(weekly), weeklyColor: color(weekly),
    tokens: latest ? compact.format(latest.tokens) : "—",
  };
}
