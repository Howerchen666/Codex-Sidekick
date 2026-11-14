import { constants, closeSync, fstatSync, openSync, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { parseObservations, summarize } from "./observations.mts";

export function watchFeed(path: string, onChange: (state: ReturnType<typeof summarize>, available: boolean) => void) {
  let watcher: ReturnType<typeof watch> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let rows: ReturnType<typeof parseObservations> = [];
  let last = "";
  function render() {
    if (closed) return;
    clearTimeout(expiry);
    let available = false;
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (stat.isFile() && stat.uid === process.getuid?.() && stat.nlink === 1 &&
            (stat.mode & 0o077) === 0 && stat.size <= 1_050_000) {
          rows = parseObservations(readFileSync(fd, "utf8"));
          available = Boolean(watcher);
        }
      } finally { closeSync(fd); }
    } catch { /* retain only observation history on loss */ }
    const now = Date.now();
    const state = summarize(rows, now, available);
    const key = JSON.stringify([state, available]);
    if (last !== key) { last = key; onChange(state, available); }
    const next = Math.min(...state.filter((row) => row.observation !== "Unknown").map((row) => row.expiresAt));
    if (Number.isFinite(next)) expiry = setTimeout(render, Math.max(1, next - now));
  }
  function start() {
    if (closed) return;
    try {
      watcher = watch(dirname(path), (_, filename) => {
        if (filename && filename !== basename(path)) return;
        clearTimeout(debounce);
        debounce = setTimeout(render, 35);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
        render();
        if (!closed) retry = setTimeout(start, 2000);
      });
    } catch { retry = setTimeout(start, 2000); }
    render();
  }
  start();
  return () => {
    closed = true;
    watcher?.close();
    clearTimeout(debounce);
    clearTimeout(expiry);
    clearTimeout(retry);
  };
}
