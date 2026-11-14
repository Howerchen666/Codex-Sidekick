import test from "node:test";
import assert from "node:assert/strict";
import { parseObservations, summarize } from "../packages/hook-recorder/observations.mts";

test("observations stay scoped to the session and expire without asserting approval or success", () => {
  const base = Date.parse("2026-11-13T12:00:00.000Z");
  const row = (event, offset, session = "a", workspace = "b") => ({
    at: new Date(base + offset).toISOString(), event, session: session.repeat(16), workspace: workspace.repeat(16),
  });
  const lines = [
    row("UserPromptSubmit", 0),
    row("PermissionRequest", 100),
    row("Stop", 200, "c"),
    row("Interrupt", 150, "a", "d"),
    row("PreModelRequest", 20), // older event arrives late
    row("SessionEnd", 400, "e"), // truncated row is not evidence
  ];
  const parsed = parseObservations(lines.map((r) => JSON.stringify(r)).join("\n"));
  assert.equal(parsed.length, 5);
  assert.deepEqual(summarize(parsed, base + 300, true).map((s) => s.observation),
    ["Approval requested", "Stop observed", "Interrupt observed"]);
  assert.deepEqual(summarize(parsed, base + 15_100, true).map((s) => s.observation),
    ["Unknown", "Stop observed", "Interrupt observed"]);
  assert.ok(summarize(parsed, base + 300, false).every((s) => s.observation === "Unknown"));
  const later = parseObservations(JSON.stringify(row("PostModelRequest", 310)) + "\n");
  assert.equal(summarize([...parsed, ...later], base + 320, true)[0].observation, "Model request returned");
});

test("the newest reported token sample survives later status events and out-of-order delivery", () => {
  const base = Date.parse("2026-11-13T12:00:00.000Z");
  const row = (event, offset, requestTokens) => ({
    at: new Date(base + offset).toISOString(), event, session: "a".repeat(16), workspace: "b".repeat(16), requestTokens,
  });
  const rows = [
    row("PostModelRequest", 100, 4200), row("PostModelRequest", 200, 5600),
    row("Stop", 220, 9900), row("PostModelRequest", 150, 5050), row("PostModelRequest", 210, -1),
  ];
  const parsed = parseObservations(rows.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const [session] = summarize(parsed, base + 300, true);
  assert.equal(session.observation, "Stop observed");
  assert.deepEqual(session.usage, { at: rows[1].at, tokens: 5600 });
});
