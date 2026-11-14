import { execFile } from "node:child_process";

export type DictationResult = { ok: boolean; outcome: string; detail: string };
type Runner = (file: string, args: readonly string[], options: object,
  done: (error: Error | null, stdout: string) => void) => void;

/** One short-lived native helper per physical key press; no audio or text is returned. */
export function toggleNativeDictation(workspace: string, helper: string,
  run: Runner = execFile as Runner, awaitControl = false): Promise<DictationResult> {
  if (!workspace || workspace.length > 80 || /[\u0000-\u001f]/u.test(workspace)) {
    return Promise.resolve({ ok: false, outcome: "workspace-unavailable", detail: "" });
  }
  const args = ["--toggle", "--workspace", workspace, ...(awaitControl ? ["--await-control"] : [])];
  return new Promise((resolve) => {
    run(helper, args, { timeout: 15_000, maxBuffer: 65_536, encoding: "utf8" },
      (error, stdout) => {
        if (error) { resolve({ ok: false, outcome: "helper-unavailable", detail: "" }); return; }
        try {
          const result = JSON.parse(stdout);
          // Starting counts: Codex has accepted the press and is opening the microphone.
          const stateMatches = result?.actionRequested === "start" ? ["recording", "starting"].includes(result?.nativeState) :
            result?.actionRequested === "stop" && ["idle", "transcribing", "retry-available"].includes(result?.nativeState);
          const ok = result?.outcome === "native-state-confirmed" && result?.nativeControlPressed === true &&
            result?.workspaceMatched === true && stateMatches;
          // Retain only bounded machine statuses. Never retain the UI diagnostic tree.
          const outcome = typeof result?.outcome === "string" && /^[a-z-]{1,60}$/u.test(result.outcome)
            ? result.outcome : "invalid-helper-response";
          const detail = typeof result?.detail === "string" && /^[a-z0-9 =.,:+_-]{0,400}$/u.test(result.detail)
            ? result.detail : "";
          resolve({ ok, outcome, detail });
        } catch { resolve({ ok: false, outcome: "invalid-helper-response", detail: "" }); }
      });
  });
}

/**
 * Toggle dictation in the Codex composer that is already on screen. Only when no
 * composer is visible, ask VS Code to show the Codex sidebar and try once more.
 * Leaving a visible composer alone keeps its controls stable while they are pressed.
 */
export async function dictate(workspace: string, helper: string, showComposer: () => Promise<boolean>,
  run: Runner = execFile as Runner): Promise<DictationResult> {
  const first = await toggleNativeDictation(workspace, helper, run);
  if (first.outcome !== "native-control-unavailable") return first;
  if (!await showComposer()) return { ok: false, outcome: "sidebar-unavailable", detail: first.detail };
  return toggleNativeDictation(workspace, helper, run, true);
}
