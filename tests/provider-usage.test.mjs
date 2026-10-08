import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProviderUsage, fresherUsage, rotateUsageFor } from "../extensions/statusbar/provider-usage.ts";

const now = Date.parse("2026-10-08T10:30:00Z");
const file = join(mkdtempSync(join(tmpdir(), "pmls-rotate-")), "pi-rotate-usage.json");
writeFileSync(file, JSON.stringify([
  { slotId: "anthropic-ps", fetchedAt: now - 60_000, windows: [
    { label: "5h", usedPercent: 0, resetAt: now + 3_600_000 },
    { label: "7d", usedPercent: 100, resetAt: now + 5 * 86_400_000 },
    { label: "7d:Fable", usedPercent: 0, scopeModel: "fable" } ] },
  { slotId: "anthropic", fetchedAt: now - 47 * 60_000, windows: [
    { label: "5h", usedPercent: 38, resetAt: now + 40 * 60_000 }, { label: "7d", usedPercent: 10 } ] },
]));

test("the serving account's 5h AND weekly come from pi-rotate, for any account name", () => {
  const ps = rotateUsageFor("anthropic-ps", file);
  assert.equal(ps.secondary.usedPercent, 100, "the account-wide week, not the model-scoped one");
  assert.equal(rotateUsageFor("nobody", file), undefined);
  assert.equal(rotateUsageFor("anthropic", join(file, "missing")), undefined, "no pi-rotate, no claim");
});

test("every figure says it is USED and which window it is; old readings say how old", () => {
  const line = formatProviderUsage(rotateUsageFor("anthropic", file), now);
  assert.match(line, /^5h 38% used \(resets \d\d:\d\d\) · week 10% used · measured 47m ago$/);
  assert.doesNotMatch(formatProviderUsage(rotateUsageFor("anthropic-ps", file), now), /measured/);
});

test("the fresher of pi-rotate and the last reply's headers wins", () => {
  const rotated = rotateUsageFor("anthropic", file);
  const headers = { ...rotated, primary: { ...rotated.primary, usedPercent: 40 }, fetchedAt: now };
  assert.equal(fresherUsage(rotated, headers).primary.usedPercent, 40);
  assert.equal(fresherUsage(rotated, null), rotated);
});
