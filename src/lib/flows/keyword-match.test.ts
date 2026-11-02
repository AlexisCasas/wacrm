import { describe, expect, it } from "vitest";
import { matchesKeywordTrigger } from "./engine";
import { isWordFlow, normalizeForWordMatch, pickEntryFlow, wordMatchSpecificity } from "./keyword-match";
import type { FlowRow, KeywordTriggerConfig } from "./types";

// Synthetic data only (this repo is public): place names stand in for the regional flows, product words for the commercial ones.

let seq = 0;
function flow(over: Partial<FlowRow> & { cfg?: KeywordTriggerConfig; type?: FlowRow["trigger_type"] }): FlowRow {
  const { cfg, type, ...rest } = over;
  seq += 1;
  return {
    id: rest.id ?? `f${seq}`,
    account_id: "acct",
    user_id: "u",
    status: "active",
    trigger_type: type ?? "keyword",
    trigger_config: cfg ?? { keywords: [] },
    entry_node_id: "start",
    created_at: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    ...rest,
  } as FlowRow;
}
const word = (keywords: string[], extra: Partial<KeywordTriggerConfig> = {}): KeywordTriggerConfig => ({ keywords, match_type: "word", ...extra });
const pickId = (flows: FlowRow[], text: string, first = false) => {
  const p = pickEntryFlow(flows, [text], first, matchesKeywordTrigger);
  return p.kind === "flow" ? p.flow.id : p.kind === "ambiguous" ? `AMBIGUOUS(${p.flow_ids.join(",")})` : null;
};

describe("normalizeForWordMatch", () => {
  it("folds case, accents and punctuation", () => {
    expect(normalizeForWordMatch("¿Jaén, Cajamarca?")).toBe("jaen cajamarca");
    expect(normalizeForWordMatch("  ICA.  ")).toBe("ica");
    expect(normalizeForWordMatch("San-Martín / Tarapoto")).toBe("san martin tarapoto");
  });
  it("returns an empty string for text without letters or digits", () => {
    expect(normalizeForWordMatch("¿?! ...")).toBe("");
    expect(normalizeForWordMatch("")).toBe("");
  });
  it("keeps digits", () => {
    expect(normalizeForWordMatch("Taladro 12V")).toBe("taladro 12v");
  });
});

describe("wordMatchSpecificity", () => {
  const ica = { keywords: ["Ica"], match_type: "word" as const };
  it.each([
    ["Ica", 1],
    ["ICA.", 1],
    ["es para ica", 1],
    ["De Ica, Pisco", 1],
    ["ica!", 1],
  ])("matches %j as a whole word", (text, words) => expect(wordMatchSpecificity(text, ica)).toBe(words));
  it.each(["eléctrica", "Precio de la cocina eléctrica", "práctica", "música", "pública", "chica", "Amica", "ica2", "2ica"])(
    "does NOT match %j (Ica only inside another word)",
    (text) => expect(wordMatchSpecificity(text, ica)).toBeNull(),
  );
  it("matches accented keywords written without accents and the other way round", () => {
    expect(wordMatchSpecificity("jaen", { keywords: ["Jaén"] })).toBe(1);
    expect(wordMatchSpecificity("JAÉN", { keywords: ["jaen"] })).toBe(1);
    expect(wordMatchSpecificity("san martin", { keywords: ["San Martín"] })).toBe(2);
  });
  it("a multi-word keyword needs all its words, contiguous and in order", () => {
    const k = { keywords: ["Nuevo Chimbote"] };
    expect(wordMatchSpecificity("soy de nuevo chimbote", k)).toBe(2);
    expect(wordMatchSpecificity("chimbote nuevo", k)).toBeNull();
    expect(wordMatchSpecificity("nuevo", k)).toBeNull();
  });
  it("reports the most specific matching keyword", () => {
    expect(wordMatchSpecificity("nuevo chimbote", { keywords: ["chimbote", "nuevo chimbote"] })).toBe(2);
  });
  it("ignores blank, non-string and empty-after-normalizing keywords and empty text", () => {
    expect(wordMatchSpecificity("hola", { keywords: ["", "  ", "¿?", null as unknown as string] })).toBeNull();
    expect(wordMatchSpecificity("", ica)).toBeNull();
    expect(wordMatchSpecificity("¿?", ica)).toBeNull();
    expect(wordMatchSpecificity("hola", { keywords: [] })).toBeNull();
  });
});

describe("matchesKeywordTrigger with match_type word", () => {
  it("is whole-word, case/accent-insensitive", () => {
    expect(matchesKeywordTrigger("Soy de ICA", word(["ica"]))).toBe(true);
    expect(matchesKeywordTrigger("cocina eléctrica", word(["ica"]))).toBe(false);
  });
  it("ignores case_sensitive (always case-insensitive)", () => {
    expect(matchesKeywordTrigger("SOY DE ICA", word(["ica"], { case_sensitive: true }))).toBe(true);
  });
  it("leaves contains and exact exactly as they were", () => {
    expect(matchesKeywordTrigger("cocina eléctrica", { keywords: ["ica"] })).toBe(true);
    expect(matchesKeywordTrigger("cocina eléctrica", { keywords: ["ica"], match_type: "contains" })).toBe(true);
    expect(matchesKeywordTrigger("ICA", { keywords: ["ica"], match_type: "exact" })).toBe(true);
    expect(matchesKeywordTrigger("jaen", { keywords: ["Jaén"] })).toBe(false);
  });
});

describe("pickEntryFlow — word flows alone", () => {
  const ica = flow({ id: "ica", cfg: word(["Ica"]) });
  const lima = flow({ id: "lima", cfg: word(["Lima"]) });
  const barranca = flow({ id: "barranca", cfg: word(["Barranca", "Lima Barranca"]) });
  const nuevoChimbote = flow({ id: "nchim", cfg: word(["Nuevo Chimbote"]) });
  const chimbote = flow({ id: "chim", cfg: word(["Chimbote", "Chinbote"]) });
  const all = [ica, lima, barranca, nuevoChimbote, chimbote];

  it("picks the flow whose place name is a whole word", () => {
    expect(pickId(all, "Ica")).toBe("ica");
    expect(pickId(all, "soy de lima")).toBe("lima");
    expect(pickId(all, "CHINBOTE")).toBe("chim");
  });
  it("does not start the Ica flow inside another word", () => {
    expect(pickId(all, "tienen cocina eléctrica?")).toBeNull();
  });
  it("the more specific (more words) keyword wins over a shorter one that also matches", () => {
    expect(pickId(all, "Nuevo Chimbote")).toBe("nchim");
    expect(pickId(all, "lima barranca")).toBe("barranca");
  });
  it("a tie between different flows is ambiguous, not decided by creation order", () => {
    // "lima" (Lima) and "barranca" (Barranca) are both one word and both priority 0.
    expect(pickId(all, "barranca lima")).toMatch(/^AMBIGUOUS\(/);
    expect(pickId([...all].reverse(), "barranca lima")).toMatch(/^AMBIGUOUS\(/);
  });
  it("an explicit word_priority breaks the tie, in either creation order", () => {
    const dept = flow({ id: "caj", cfg: word(["Cajamarca"], { word_priority: 1 }) });
    const city = flow({ id: "jaen", cfg: word(["Jaén"], { word_priority: 2 }) });
    expect(pickId([dept, city], "Jaén, Cajamarca")).toBe("jaen");
    expect(pickId([city, dept], "cajamarca jaen")).toBe("jaen");
  });
  it("equal priority still ties", () => {
    const a = flow({ id: "a", cfg: word(["Cajamarca"], { word_priority: 2 }) });
    const b = flow({ id: "b", cfg: word(["Jaén"], { word_priority: 2 }) });
    expect(pickId([a, b], "Jaén Cajamarca")).toBe("AMBIGUOUS(a,b)");
  });
  it("two flows claiming the same keyword is ambiguous (data problem surfaced, not hidden)", () => {
    const a = flow({ id: "a", cfg: word(["Chimbote"]) });
    const b = flow({ id: "b", cfg: word(["chimbote"]) });
    expect(pickId([a, b], "Chimbote")).toBe("AMBIGUOUS(a,b)");
  });
  it("a flow listing the same place twice is not ambiguous with itself", () => {
    const a = flow({ id: "a", cfg: word(["Ica", "ICA", "ica."]) });
    expect(pickId([a], "ica")).toBe("a");
  });
  it("never returns more than one flow", () => {
    const p = pickEntryFlow(all, ["lima barranca ica"], false, matchesKeywordTrigger);
    expect(p.kind === "flow" || p.kind === "ambiguous" || p.kind === "none").toBe(true);
    if (p.kind === "flow") expect(p.flow.id).toBeTruthy();
  });
  it("uses every offered candidate text (a button title and its id)", () => {
    const p = pickEntryFlow([ica], ["Elegir", "ica"], false, matchesKeywordTrigger);
    expect(p.kind).toBe("flow");
  });
});

describe("pickEntryFlow — commercial flows keep priority over word flows", () => {
  const ad = flow({ id: "ad", cfg: { keywords: ["Hola. ¿Puedes darme más información sobre el taladro?"] } });
  const ica = flow({ id: "ica", cfg: word(["Ica"]) });
  it("an ad text that also contains a place name starts the ad flow, whatever the creation order", () => {
    const text = "Hola. ¿Puedes darme más información sobre el taladro? Soy de Ica";
    expect(pickId([ica, ad], text)).toBe("ad");
    expect(pickId([ad, ica], text)).toBe("ad");
  });
  it("a first_inbound_message flow also outranks word flows", () => {
    const welcome = flow({ id: "welcome", type: "first_inbound_message", cfg: { keywords: [] } });
    expect(pickId([ica, welcome], "Ica", true)).toBe("welcome");
    expect(pickId([ica, welcome], "Ica", false)).toBe("ica");
  });
  it("a manual flow never starts from a message, even with word keywords", () => {
    const manual = flow({ id: "m", type: "manual", cfg: word(["Ica"]) });
    expect(pickId([manual], "Ica")).toBeNull();
  });
});

// ---- Regression: flows WITHOUT match_type word behave exactly as the engine did before this change -----------------------------------------------------------
// `legacyPick` is the entry loop of findEntryFlow copied verbatim from the previous release.
function legacyPick(flows: FlowRow[], candidates: string[], isFirstInbound: boolean): FlowRow | null {
  for (const f of flows) {
    if (f.trigger_type === "keyword") {
      const cfg = f.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) return f;
    } else if (f.trigger_type === "first_inbound_message" && isFirstInbound) {
      return f;
    }
  }
  return null;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const VOCAB = ["ica", "lima", "taladro", "eléctrica", "cocina", "hola", "precio", "jaén", "jaen", "san martín", "12v", "ingco", "para", "quiero", "información"];

describe("regression: legacy selection is unchanged", () => {
  it("matches the previous implementation on 3000 random scenarios without word flows", () => {
    const rnd = prng(42);
    const pickWords = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(" ");
    for (let i = 0; i < 3000; i++) {
      const flows: FlowRow[] = [];
      const n = 1 + Math.floor(rnd() * 6);
      for (let j = 0; j < n; j++) {
        const r = rnd();
        if (r < 0.1) flows.push(flow({ type: "first_inbound_message", cfg: { keywords: [] } }));
        else if (r < 0.2) flows.push(flow({ type: "manual", cfg: { keywords: [pickWords(1)] } }));
        else
          flows.push(
            flow({
              cfg: {
                keywords: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pickWords(1 + Math.floor(rnd() * 2))),
                ...(rnd() < 0.3 ? { match_type: rnd() < 0.5 ? ("exact" as const) : ("contains" as const) } : {}),
                ...(rnd() < 0.2 ? { case_sensitive: true } : {}),
              },
            }),
          );
      }
      const candidates = [pickWords(1 + Math.floor(rnd() * 4))];
      const first = rnd() < 0.3;
      const expected = legacyPick(flows, candidates, first);
      const got = pickEntryFlow(flows, candidates, first, matchesKeywordTrigger);
      expect(got.kind === "flow" ? got.flow.id : null).toBe(expected ? expected.id : null);
    }
  });

  it("adding word flows anywhere never changes the outcome when a legacy flow matches", () => {
    const rnd = prng(7);
    const pickWords = (n: number) => Array.from({ length: n }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(" ");
    let legacyHits = 0;
    for (let i = 0; i < 3000; i++) {
      const legacy: FlowRow[] = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => flow({ cfg: { keywords: [pickWords(1 + Math.floor(rnd() * 2))] } }));
      const words: FlowRow[] = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => flow({ cfg: word([pickWords(1), pickWords(2)]) }));
      // word flows are interleaved at random positions; the relative order of the legacy flows (their creation order) is kept
      const mixed = [...legacy];
      for (const w of words) mixed.splice(Math.floor(rnd() * (mixed.length + 1)), 0, w);
      const candidates = [pickWords(1 + Math.floor(rnd() * 4))];
      const expected = legacyPick(legacy, candidates, false);
      const got = pickEntryFlow(mixed, candidates, false, matchesKeywordTrigger);
      if (expected) {
        legacyHits++;
        expect(got.kind === "flow" ? got.flow.id : null).toBe(expected.id);
      } else if (got.kind === "flow") {
        expect(isWordFlow(got.flow)).toBe(true);
      }
    }
    expect(legacyHits).toBeGreaterThan(100); // the scenario generator really exercises the interesting branch
  });
});
