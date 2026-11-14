import { createHash } from "node:crypto";

export function observationId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? createHash("sha256").update(value).digest("hex").slice(0, 16)
    : undefined;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function chatTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return value.slice(0, 240).replace(/[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim() || undefined;
}
