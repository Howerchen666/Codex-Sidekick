import streamDeck, { action, SingletonAction, type WillAppearEvent, type WillDisappearEvent, type KeyDownEvent } from "@elgato/streamdeck";
import { ACTIONS, root, type ChatTarget, type Control } from "../../../packages/neo-bridge/protocol.mts";
import { chatTiles, connectDeck, type DeckState } from "./link.mts";
import { controlArt, deckImage, infobarText, isAnimated, sessionArt } from "./art.mts";

import { infobarImage } from "./infobar-image.mts";
import { fileURLToPath } from "node:url";
import { chmod } from "node:fs/promises";
import { dictate } from "./dictation.mts";

const UUID = "dev.sidekick.codex";
let state: DeckState = { mode: "offline" };
const callbacks = new Map<string, () => Promise<void>>();
const visibleSessions = new Map<string, { slot: number; update: (now?: number) => Promise<void> }>();
let frames: ReturnType<typeof setTimeout> | undefined;

function scheduleFrame() {
  if (frames) return;
  const now = Date.now();
  if (![...visibleSessions.values()].some(({ slot }) => isAnimated(slot, state, now))) return;
  frames = setTimeout(() => {
    frames = undefined;
    const at = Date.now();
    for (const { update } of visibleSessions.values()) void update(at).catch(() => undefined);
    scheduleFrame();
  }, 250);
}

const link = connectDeck((next) => {
  state = next;
  for (const update of callbacks.values()) void update().catch(() => undefined);
  scheduleFrame();
}, process.env.SIDEKICK_TEST_SOCKET_ROOT ?? root());

class SessionKey extends SingletonAction {
  readonly #displayed = new Map<string, ChatTarget>();
  constructor(private readonly slot: number) { super(); }
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const key = ev.action;
    if (!key.isKey()) return;
    let previous = "";
    let revision = 0;
    const update = async (now?: number) => {
      const currentRevision = ++revision;
      const row = chatTiles(state)[this.slot];
      const svg = sessionArt(this.slot, state, now);
      if (svg !== previous) { previous = svg; await key.setImage(deckImage(svg)); }
      if (callbacks.get(key.id) !== update || currentRevision !== revision) return;
      if (row) this.#displayed.set(key.id, { session: row.session, workspace: row.workspace });
      else this.#displayed.delete(key.id);
    };
    callbacks.set(key.id, update);
    visibleSessions.set(key.id, { slot: this.slot, update });
    scheduleFrame();
    await update();
  }
  override onWillDisappear(ev: WillDisappearEvent): void {
    callbacks.delete(ev.action.id);
    visibleSessions.delete(ev.action.id);
    this.#displayed.delete(ev.action.id);
    if (visibleSessions.size === 0) { clearTimeout(frames); frames = undefined; }
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const target = this.#displayed.get(ev.action.id);
    const row = chatTiles(state)[this.slot];
    if (target && row?.session === target.session && row.workspace === target.workspace && await link.focusChat(target)) {
      await ev.action.showOk();
    } else await ev.action.showAlert();
  }
}

class CommandKey extends SingletonAction {
  constructor(private readonly control: Control) { super(); }
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const key = ev.action;
    if (!key.isKey()) return;
    let previous = "";
    const update = async () => {
      const svg = controlArt(this.control, state.mode === "connected");
      if (svg !== previous) { previous = svg; await key.setImage(deckImage(svg)); }
    };
    callbacks.set(key.id, update);
    await update();
  }
  override onWillDisappear(ev: WillDisappearEvent): void { callbacks.delete(ev.action.id); }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (await link.command(this.control)) await ev.action.showOk();
    else await ev.action.showAlert();
  }
}

// This action was the "Codex Menu" key before it became Dictate. The UUID stays
// so that existing layouts keep their bottom-right key assignment.
@action({ UUID: `${UUID}.opencommandmenu` })
class DictationKey extends SingletonAction {
  #busy = false;
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;
    const key = ev.action;
    const update = () => key.setImage(deckImage(controlArt("dictate", state.mode === "connected")));
    callbacks.set(key.id, update);
    await update();
  }
  override onWillDisappear(ev: WillDisappearEvent): void { callbacks.delete(ev.action.id); }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.#busy || state.mode !== "connected") {
      streamDeck.logger.info("Native dictation: " + (this.#busy ? "busy" : "workspace-not-connected"));
      await ev.action.showAlert(); return;
    }
    const workspace = state.workspace;
    this.#busy = true;
    try {
      const helper = process.env.SIDEKICK_TEST_DICTATION_HELPER ??
        fileURLToPath(new URL("./native/dictation-helper", import.meta.url));
      // Stream Deck's packager normalizes bundled auxiliary files to mode 0644.
      // Prepare our own helper on demand so a fresh installation can execute it.
      await chmod(helper, 0o755);
      const result = await dictate(workspace, helper, async () =>
        await link.command("openSidebar") && state.mode === "connected" && state.workspace === workspace);
      streamDeck.logger.info("Native dictation: " + result.outcome + (result.detail ? " | " + result.detail : ""));
      if (result.ok) await ev.action.showOk();
      else await ev.action.showAlert();
    } catch {
      streamDeck.logger.info("Native dictation: helper-error");
      await ev.action.showAlert();
    } finally { this.#busy = false; }
  }
}

@action({ UUID: `${UUID}.infobar` })
class Infobar extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const neo = ev.action;
    if (!neo.isNeoInfobar()) return;
    await neo.setFeedbackLayout("layouts/neo.json");
    let previous = "";
    const update = async () => {
      const view = infobarText(state);
      const stamp = JSON.stringify(view);
      if (stamp !== previous) {
        previous = stamp;
        const image = "data:image/png;base64," + infobarImage(view).toString("base64");
        await neo.setFeedback({ pixels: image });
      }
    };
    callbacks.set(neo.id, update);
    await update();
  }
  override onWillDisappear(ev: WillDisappearEvent): void { callbacks.delete(ev.action.id); }
}

for (let slot = 0; slot < 4; slot++) {
  @action({ UUID: `${UUID}.slot-${slot + 1}` })
  class Slot extends SessionKey { constructor() { super(slot); } }
  streamDeck.actions.registerAction(new Slot());
}
for (const control of ACTIONS) {
  @action({ UUID: `${UUID}.${control.toLowerCase()}` })
  class ControlKey extends CommandKey { constructor() { super(control); } }
  streamDeck.actions.registerAction(new ControlKey());
}
streamDeck.actions.registerAction(new DictationKey());
streamDeck.actions.registerAction(new Infobar());
void streamDeck.connect().catch(() => { link.close(); process.exitCode = 1; });
