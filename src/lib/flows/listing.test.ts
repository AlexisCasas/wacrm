import { describe, expect, it } from "vitest";
import { listFlows, normalizeFlowSearchText, type ListableFlow } from "./listing";

const flows: ListableFlow[] = [
  {
    id: "1",
    name: "NIVEL LÁSER",
    status: "active",
    execution_count: 12,
    last_executed_at: "2026-10-08T10:00:00.000Z",
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-06T10:00:00.000Z",
  },
  {
    id: "2",
    name: "Medición de taladro",
    status: "draft",
    execution_count: 2,
    last_executed_at: null,
    created_at: "2026-10-03T10:00:00.000Z",
    updated_at: "2026-10-09T10:00:00.000Z",
  },
  {
    id: "3",
    name: "Taladro básico",
    status: "archived",
    execution_count: 2,
    last_executed_at: "2026-10-07T10:00:00.000Z",
    created_at: "2026-10-02T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  },
  {
    id: "4",
    name: "Árbol",
    status: "active",
    execution_count: 2,
    last_executed_at: "2026-10-07T10:00:00.000Z",
    created_at: "2026-10-04T10:00:00.000Z",
    updated_at: "2026-10-05T10:00:00.000Z",
  },
];

const defaults = { query: "", status: "all" as const, sort: "newest" as const };

const ids = (result: ListableFlow[]) => result.map((flow) => flow.id);

describe("normalizeFlowSearchText", () => {
  it("normalizes case and diacritics", () => {
    expect(normalizeFlowSearchText("NIVEL LÁSER")).toBe("nivel laser");
    expect(normalizeFlowSearchText("Medición")).toBe("medicion");
  });
});

describe("listFlows search and status", () => {
  it("finds exact and partial names regardless of case or accents", () => {
    expect(ids(listFlows(flows, { ...defaults, query: "TALADRO" }))).toEqual(["2", "3"]);
    expect(ids(listFlows(flows, { ...defaults, query: "medicion" }))).toEqual(["2"]);
    expect(ids(listFlows(flows, { ...defaults, query: "nivel laser" }))).toEqual(["1"]);
  });

  it("returns every flow for an empty query and no flow when nothing matches", () => {
    expect(ids(listFlows(flows, defaults))).toEqual(["4", "2", "3", "1"]);
    expect(listFlows(flows, { ...defaults, query: "inexistente" })).toEqual([]);
  });

  it("filters every supported status", () => {
    expect(ids(listFlows(flows, { ...defaults, status: "active" }))).toEqual(["4", "1"]);
    expect(ids(listFlows(flows, { ...defaults, status: "draft" }))).toEqual(["2"]);
    expect(ids(listFlows(flows, { ...defaults, status: "archived" }))).toEqual(["3"]);
  });
});

describe("listFlows sorting", () => {
  it("keeps newest-first as the default and never mutates the source", () => {
    const source = [...flows];
    expect(ids(listFlows(source, defaults))).toEqual(["4", "2", "3", "1"]);
    expect(source).toEqual(flows);
  });

  it("sorts execution count in both directions with deterministic ties", () => {
    expect(ids(listFlows(flows, { ...defaults, sort: "most-used" }))).toEqual(["1", "4", "2", "3"]);
    expect(ids(listFlows(flows, { ...defaults, sort: "least-used" }))).toEqual(["4", "2", "3", "1"]);
  });

  it("sorts last execution and leaves never-executed flows at the end", () => {
    expect(ids(listFlows(flows, { ...defaults, sort: "last-executed" }))).toEqual(["1", "4", "3", "2"]);
  });

  it("sorts last modification and localized names", () => {
    expect(ids(listFlows(flows, { ...defaults, sort: "last-modified" }))).toEqual(["2", "1", "4", "3"]);
    expect(ids(listFlows(flows, { ...defaults, sort: "name-asc" }))).toEqual(["4", "2", "1", "3"]);
    expect(ids(listFlows(flows, { ...defaults, sort: "name-desc" }))).toEqual(["3", "1", "2", "4"]);
  });
});

describe("listFlows combinations", () => {
  it("combines query, status, and sorting", () => {
    expect(
      ids(
        listFlows(flows, {
          query: "taladro",
          status: "archived",
          sort: "most-used",
        }),
      ),
    ).toEqual(["3"]);
  });

  it("combines query with sorting and status with sorting", () => {
    expect(ids(listFlows(flows, { ...defaults, query: "a", sort: "name-asc" }))).toEqual([
      "4",
      "2",
      "1",
      "3",
    ]);
    expect(ids(listFlows(flows, { ...defaults, status: "active", sort: "most-used" }))).toEqual([
      "1",
      "4",
    ]);
  });
});
