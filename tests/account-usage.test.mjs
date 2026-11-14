import test from "node:test";
import assert from "node:assert/strict";
import { availableWindow, isAccountUsage, projectAccountUsage, usageExpiresAt } from "../packages/account-usage/usage.mts";

const now = Date.parse("2026-11-14T03:00:00.000Z");

test("remaining allowances select the Codex bucket and match durations instead of window order", () => {
  const usage = projectAccountUsage({
    rateLimits: { limitId: "codex", primary: { usedPercent: 99, windowDurationMins: 300 } },
    rateLimitsByLimitId: {
      anotherModel: { primary: { usedPercent: 80, windowDurationMins: 300 } },
      codex: {
        primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: now / 1000 + 90 },
        secondary: { usedPercent: 30.2, windowDurationMins: 300, resetsAt: now / 1000 + 30 },
        credits: { balance: "ignored" },
      },
    },
  }, now);
  assert.deepEqual(usage, {
    at: new Date(now).toISOString(),
    fiveHour: { remainingPercent: 69, resetsAt: now / 1000 + 30 },
    weekly: { remainingPercent: 95, resetsAt: now / 1000 + 90 },
  });
  assert.equal(isAccountUsage(usage), true);
  assert.equal(isAccountUsage({ ...usage, fiveHour: { remainingPercent: 101, resetsAt: null } }), false);
});

test("missing windows stay unavailable and legacy replies remain supported", () => {
  assert.equal(projectAccountUsage({ rateLimits: { limitId: "other", primary: { usedPercent: 0, windowDurationMins: 300 } } }, now), undefined);
  assert.equal(projectAccountUsage({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 15 } } }, now), undefined);
  assert.equal(projectAccountUsage({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }, now), undefined);
  assert.deepEqual(projectAccountUsage({ rateLimits: {
    limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: null,
  } }, now), { at: new Date(now).toISOString(), fiveHour: { remainingPercent: 0, resetsAt: null } });
});

test("a reset or stale snapshot becomes unavailable without assuming a fresh allowance", () => {
  const usage = {
    at: new Date(now).toISOString(),
    fiveHour: { remainingPercent: 40, resetsAt: now / 1000 + 30 },
    weekly: { remainingPercent: 70, resetsAt: now / 1000 + 90 },
  };
  assert.equal(usageExpiresAt(usage, now), now + 30_000);
  assert.equal(availableWindow(usage, usage.fiveHour, now + 30_000), undefined);
  assert.equal(availableWindow(usage, usage.weekly, now + 30_000), usage.weekly);
  assert.equal(usageExpiresAt(usage, now + 30_000), now + 90_000);
  assert.equal(usageExpiresAt(usage, now + 90_000), now + 120_000);
  assert.equal(availableWindow(usage, usage.weekly, now - 1), undefined);
  assert.equal(availableWindow(usage, { remainingPercent: 70, resetsAt: null }, now + 120_000), undefined);
});
