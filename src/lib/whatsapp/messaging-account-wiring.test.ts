import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A guard, not a behaviour test: every place that CALLS a WhatsApp sender must hand it the account's messaging_account_id. If a new send path
// is added (or an existing one edited) without it, that account's messages would silently be billed by Meta to whichever messaging account it
// picks. The behaviour of each sender is proven in messaging-account.test.ts; this proves nobody forgot to pass the value.

const ROOT = join(__dirname, "..", "..");
const SENDERS = ["sendTextMessage", "sendMediaMessage", "sendTemplateMessage", "sendReactionMessage", "sendInteractiveButtons", "sendInteractiveList"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** The text of the `({ ... })` argument of every `name(` call, with balanced braces. */
function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w.])${name}\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    // Skip the declaration `export async function name(` and imports.
    const before = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(before)) continue;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.endsWith(join("lib", "whatsapp", "meta-api.ts")));

describe("every WhatsApp sender call passes messagingAccountId", () => {
  const calls: Array<{ file: string; sender: string; args: string }> = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const s of SENDERS) for (const args of callArguments(src, s)) calls.push({ file: relative(ROOT, f), sender: s, args });
  }

  it("finds the known call sites (the guard itself is not silently empty)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(12);
    const byFile = new Set(calls.map((c) => c.file));
    for (const f of [
      "lib/whatsapp/send-message.ts",
      "lib/flows/meta-send.ts",
      "lib/automations/meta-send.ts",
      "lib/whatsapp/broadcast-core.ts",
      "app/api/whatsapp/broadcast/route.ts",
      "app/api/whatsapp/react/route.ts",
    ]) expect(byFile.has(f)).toBe(true);
  });

  it.each(calls.map((c, i) => [`${c.file} -> ${c.sender} #${i}`, c] as const))("%s", (_name, c) => {
    expect(c.args).toMatch(/messagingAccountId\s*[:,}]/);
  });

  it("a caller that selects explicit whatsapp_config columns includes messaging_account_id", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!SENDERS.some((s) => src.includes(`${s}(`))) continue;
      for (const m of src.matchAll(/from\('whatsapp_config'\)\s*\.select\('([^']*)'\)/g)) {
        if (m[1] !== "*" && !m[1].includes("messaging_account_id")) offenders.push(`${relative(ROOT, f)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
