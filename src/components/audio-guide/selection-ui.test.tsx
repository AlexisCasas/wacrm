// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key);
    t.raw = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
}));
const toastError = vi.fn(), toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), warning: vi.fn(), info: vi.fn() } }));
const state = vi.hoisted(() => ({ accountRole: "owner" as string | null, accountId: "acct-1" }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountRole: state.accountRole, accountId: state.accountId }) }));
vi.mock("@/hooks/use-audio-guide-enabled", () => ({ useAudioGuideEnabled: () => true }));
vi.mock("@/lib/audio-guide/stage-client", () => ({ stageVoiceNote: vi.fn() }));

import { AudioGuideAdmin } from "./audio-guide-admin";

// F2-B: the Audios por producto screen with purposes, identifiers and the classification of each audio. A tiny fake server answers /api/audio-guide.
type Name = { id: string; name: string; active: boolean; in_use: number };
const PU1 = "c1111111-1111-4111-8111-111111111111", PU2 = "c2222222-2222-4222-8222-222222222222";
const ID1 = "d1111111-1111-4111-8111-111111111111", ID2 = "d2222222-2222-4222-8222-222222222222";
const PROD = "a1111111-1111-4111-8111-111111111111";
const IT1 = "a3333333-3333-4333-8333-333333333333", IT2 = "a4444444-4444-4444-8444-444444444444";

let purposes: Name[], identifiers: Name[], items: Array<Record<string, unknown>>, revision: number;
let calls: Array<{ method: string; url: string; body?: Record<string, unknown> }>;
let override: ((method: string, url: string, body?: Record<string, unknown>) => { status: number; body: unknown } | null) | null;

const detail = () => ({ id: PROD, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision, created_at: "", updated_at: "", items });
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function serve(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  calls.push({ method, url, body });
  const forced = override?.(method, url, body);
  if (forced) return answer(forced.status, forced.body);
  if (url === "/api/audio-guide/products" || url.startsWith("/api/audio-guide/products?")) return answer(200, { products: [{ id: PROD, product_key: "combo xtd", display_name: "Combo XTD", active: true, revision, item_count: items.length, active_item_count: items.length }] });
  if (url === `/api/audio-guide/products/${PROD}`) return answer(200, { product: detail() });
  if (url === "/api/audio-guide/purposes" && method === "GET") return answer(200, { purposes });
  if (url === "/api/audio-guide/identifiers" && method === "GET") return answer(200, { identifiers });
  if (url === "/api/audio-guide/purposes" && method === "POST") { const n = { id: "c9999999-9999-4999-8999-999999999999", name: String(body?.name), active: true, in_use: 0 }; purposes = [...purposes, n]; return answer(201, { purpose: n }); }
  if (/\/api\/audio-guide\/(purposes|identifiers)\//.test(url) && method === "PATCH") {
    const list = url.includes("/purposes/") ? purposes : identifiers; const row = list.find((r) => url.endsWith(r.id));
    if (row) Object.assign(row, body);
    return answer(200, { ok: true });
  }
  if (url.endsWith("/classification") && method === "PUT") {
    const item = items.find((i) => url.includes(String(i.id)))!;
    Object.assign(item, { purpose_id: body?.purpose_id ?? null, identifier_id: body?.identifier_id ?? null }); revision += 1;
    return answer(200, { product: detail() });
  }
  return answer(404, { error: "not_found" });
}

const baseItem = (id: string, n: number, over: Record<string, unknown> = {}) => ({ id, position: n, sha256: String(n).repeat(64), url: `https://x.test/${n}.ogg`, label: `Audio ${n}`, bytes: 1000, duration_ms: 5000, pre_delay_seconds: 5, status: "active", purpose_id: null, identifier_id: null, ...over });

beforeEach(() => {
  state.accountRole = "owner";
  purposes = [{ id: PU1, name: "Pago", active: true, in_use: 0 }, { id: PU2, name: "Provincia", active: true, in_use: 2 }];
  identifiers = [{ id: ID1, name: "Principal", active: true, in_use: 0 }, { id: ID2, name: "Alternativo", active: true, in_use: 0 }];
  items = [baseItem(IT1, 1), baseItem(IT2, 2)];
  revision = 3; calls = []; override = null;
  toastError.mockReset(); toastSuccess.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => serve(url, init)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const openProduct = async () => {
  render(<AudioGuideAdmin />);
  fireEvent.click(await screen.findByTestId("product-combo xtd"));
  await screen.findByTestId("audio-list");
};
const openCatalogs = async () => {
  render(<AudioGuideAdmin />);
  await waitFor(() => expect(screen.getByTestId("selection-catalogs-toggle")).toBeTruthy());
  fireEvent.click(screen.getByTestId("selection-catalogs-toggle"));
  await screen.findByTestId("purpose-column");
};
const puts = () => calls.filter((c) => c.method === "PUT");

describe("the purposes and identifiers panel", () => {
  it("lists both catalogs with their state and how many audios use each; usage is shown and a name in use cannot be deleted", async () => {
    await openCatalogs();
    expect(within(screen.getByTestId("purpose-list")).getByText("Pago")).toBeTruthy();
    expect(within(screen.getByTestId("identifier-list")).getByText("Alternativo")).toBeTruthy();
    expect(screen.getByTestId(`usage-${PU2}`).textContent).toContain('"count":2');
    expect(screen.getByTestId(`usage-${PU1}`).textContent).toBe("catalogUnused");
    expect((screen.getByTestId(`delete-${PU2}`) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId(`blocked-${PU2}`)).toBeTruthy();
    expect((screen.getByTestId(`delete-${PU1}`) as HTMLButtonElement).disabled).toBe(false);
  });
  it("creates one (POST with only the name), refreshes the list and clears the box", async () => {
    await openCatalogs();
    fireEvent.change(screen.getByTestId("new-purpose-name"), { target: { value: "Promoción" } });
    fireEvent.click(screen.getByTestId("add-purpose"));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Promoción" }));
    await waitFor(() => expect(within(screen.getByTestId("purpose-list")).getByText("Promoción")).toBeTruthy());
    expect((screen.getByTestId("new-purpose-name") as HTMLInputElement).value).toBe("");
    expect(toastSuccess).toHaveBeenCalledWith("catalogCreated");
  });
  it("a duplicate name is explained next to the box (visible, not only a toast) and nothing is added", async () => {
    override = (method) => (method === "POST" ? { status: 409, body: { error: "duplicate_name" } } : null);
    await openCatalogs();
    fireEvent.change(screen.getByTestId("new-identifier-name"), { target: { value: "principal" } });
    fireEvent.click(screen.getByTestId("add-identifier"));
    expect((await screen.findByTestId("identifier-create-error")).textContent).toBe("errorDuplicateName");
    expect(within(screen.getByTestId("identifier-list")).getAllByRole("listitem")).toHaveLength(2);
  });
  it("name rules and the limit are explained: 422 invalid_value is about the name, limit_reached about the catalog", async () => {
    await openCatalogs();
    override = () => ({ status: 422, body: { error: "invalid_value" } });
    fireEvent.change(screen.getByTestId("new-purpose-name"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("add-purpose"));
    expect((await screen.findByTestId("purpose-create-error")).textContent).toBe("errorCatalogName");
    override = () => ({ status: 422, body: { error: "limit_reached" } });
    fireEvent.click(screen.getByTestId("add-purpose"));
    await waitFor(() => expect(screen.getByTestId("purpose-create-error").textContent).toBe("errorCatalogLimit"));
  });
  it("renames and deactivates through PATCH", async () => {
    await openCatalogs();
    fireEvent.click(screen.getByTestId(`rename-${PU1}`));
    fireEvent.change(screen.getByTestId(`rename-input-${PU1}`), { target: { value: "Pago adelantado" } });
    fireEvent.click(screen.getByTestId(`rename-save-${PU1}`));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.url.endsWith(PU1))?.body).toEqual({ name: "Pago adelantado" }));
    fireEvent.click(await screen.findByTestId(`active-${ID1}`));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.url.endsWith(ID1))?.body).toEqual({ active: false }));
  });
  it("deletes one nobody uses after a confirmation; a refusal (409 in_use) is reported, not hidden", async () => {
    await openCatalogs();
    fireEvent.click(screen.getByTestId(`delete-${PU1}`));
    override = (method) => (method === "DELETE" ? { status: 409, body: { error: "in_use" } } : null);
    fireEvent.click(await screen.findByTestId("confirm-delete-purpose"));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("errorInUse"));
    await waitFor(() => expect(screen.queryByTestId("confirm-delete-purpose")).toBeNull());
    override = null;
    fireEvent.click(screen.getByTestId(`delete-${PU1}`));
    fireEvent.click(await screen.findByTestId("confirm-delete-purpose"));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(PU1))).toBe(true));
  });
  it("a viewer or agent can read the catalogs but has no controls to change them", async () => {
    state.accountRole = "viewer";
    await openCatalogs();
    expect(within(screen.getByTestId("purpose-list")).getByText("Pago")).toBeTruthy();
    for (const id of ["new-purpose-name", "add-purpose", `rename-${PU1}`, `active-${PU1}`, `delete-${PU1}`]) expect(screen.queryByTestId(id), id).toBeNull();
  });
  it("shows the loading failure with a retry instead of an empty list", async () => {
    override = (method, url) => (url === "/api/audio-guide/purposes" && method === "GET" ? { status: 500, body: { error: "internal_error" } } : null);
    await openCatalogs().catch(() => {});
    expect((await screen.findByTestId("catalogs-error")).textContent).toContain("catalogLoadError");
  });
});

describe("classifying an audio", () => {
  it("every audio starts 'Sin clasificar' and nothing is saved by opening the screen", async () => {
    await openProduct();
    expect(screen.getByTestId("unclassified-1")).toBeTruthy();
    expect((screen.getByTestId("purpose-1") as HTMLSelectElement).value).toBe("");
    expect(puts()).toHaveLength(0);
  });
  it("choosing only one value saves nothing and says both are needed; choosing the second saves them together (PUT with the loaded revision)", async () => {
    await openProduct();
    fireEvent.change(screen.getByTestId("purpose-1"), { target: { value: PU1 } });
    expect(screen.getByTestId("half-1")).toBeTruthy();
    expect(puts()).toHaveLength(0);
    fireEvent.change(screen.getByTestId("identifier-1"), { target: { value: ID2 } });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].url).toBe(`/api/audio-guide/products/${PROD}/items/${IT1}/classification`);
    expect(puts()[0].body).toEqual({ expected_revision: 3, purpose_id: PU1, identifier_id: ID2 });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("classifySaved"));
    await waitFor(() => expect((screen.getByTestId("purpose-1") as HTMLSelectElement).value).toBe(PU1));
    expect(screen.queryByTestId("unclassified-1")).toBeNull();
  });
  it("a duplicated combination is refused and the reason stays visible on that audio; the selectors go back to what is saved", async () => {
    override = (method) => (method === "PUT" ? { status: 409, body: { error: "duplicate_classification", conflict_item: IT2 } } : null);
    await openProduct();
    fireEvent.change(screen.getByTestId("purpose-1"), { target: { value: PU1 } });
    fireEvent.change(screen.getByTestId("identifier-1"), { target: { value: ID1 } });
    expect((await screen.findByTestId("classification-error-1")).textContent).toBe("errorDuplicateClassification");
    await waitFor(() => expect((screen.getByTestId("purpose-1") as HTMLSelectElement).value).toBe(""));
  });
  it("an inactive or deleted value is reported (409/422) and not applied", async () => {
    await openProduct();
    for (const [code, text] of [["purpose_inactive", "errorPurposeInactive"], ["identifier_inactive", "errorIdentifierInactive"], ["purpose_not_found", "errorPurposeMissing"], ["identifier_not_found", "errorIdentifierMissing"]] as const) {
      override = (method) => (method === "PUT" ? { status: 409, body: { error: code } } : null);
      fireEvent.change(screen.getByTestId("purpose-1"), { target: { value: PU1 } });
      fireEvent.change(screen.getByTestId("identifier-1"), { target: { value: ID1 } });
      await waitFor(() => expect(screen.getByTestId("classification-error-1").textContent).toBe(text));
      await waitFor(() => expect((screen.getByTestId("purpose-1") as HTMLSelectElement).value).toBe(""));
    }
  });
  it("a stale revision reloads the product and tells the person (the standard conflict message)", async () => {
    override = (method) => (method === "PUT" ? { status: 409, body: { error: "revision_conflict", revision: 9 } } : null);
    await openProduct();
    fireEvent.change(screen.getByTestId("purpose-2"), { target: { value: PU2 } });
    fireEvent.change(screen.getByTestId("identifier-2"), { target: { value: ID1 } });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("conflict"));
  });
  it("a classified audio shows its values, can be cleared with one click (null, null), and keeps its player, pause and switch", async () => {
    items = [baseItem(IT1, 1, { purpose_id: PU1, identifier_id: ID1 }), baseItem(IT2, 2)];
    await openProduct();
    expect((screen.getByTestId("purpose-1") as HTMLSelectElement).value).toBe(PU1);
    expect(screen.getByTestId("player-1")).toBeTruthy();
    expect(screen.getByTestId("pause-1")).toBeTruthy();
    expect(screen.getByTestId("toggle-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("clear-classification-1"));
    await waitFor(() => expect(puts()[0].body).toEqual({ expected_revision: 3, purpose_id: null, identifier_id: null }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("classifyCleared"));
  });
  it("an inactive value already saved stays visible and is labelled; a deleted one is shown as such", async () => {
    purposes = [{ id: PU1, name: "Pago", active: false, in_use: 1 }];
    items = [baseItem(IT1, 1, { purpose_id: PU1, identifier_id: ID1 }), baseItem(IT2, 2, { purpose_id: PU2, identifier_id: ID1 })];
    await openProduct();
    const inactive = screen.getByTestId("purpose-1") as HTMLSelectElement;
    expect(inactive.value).toBe(PU1);
    expect(Array.from(inactive.options).map((o) => o.textContent)).toContain("Pago classifyInactiveSuffix");
    const missing = screen.getByTestId("purpose-2") as HTMLSelectElement;
    expect(missing.value).toBe(PU2);
    expect(Array.from(missing.options).map((o) => o.textContent)).toContain("classifyMissingValue");
    // an inactive value cannot be newly assigned to ANOTHER audio: it is not offered there
    const other = Array.from((screen.getByTestId("purpose-2") as HTMLSelectElement).options).map((o) => o.value);
    expect(other).not.toContain("c9999999");
  });
  it("a viewer sees the classification but cannot change it; the controls are disabled", async () => {
    state.accountRole = "agent";
    items = [baseItem(IT1, 1, { purpose_id: PU1, identifier_id: ID1 }), baseItem(IT2, 2)];
    await openProduct();
    expect((screen.getByTestId("purpose-1") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByTestId("identifier-1") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByTestId("clear-classification-1")).toBeNull();
  });
  it("while the lists are loading, or if they failed, the selectors are disabled instead of offering nothing", async () => {
    override = (method, url) => (url === "/api/audio-guide/identifiers" && method === "GET" ? { status: 500, body: { error: "internal_error" } } : null);
    await openProduct();
    await waitFor(() => expect((screen.getByTestId("purpose-1") as HTMLSelectElement).disabled).toBe(true));
  });
  it("with no purpose or identifier created yet, an admin is told to create them first", async () => {
    purposes = []; identifiers = [];
    await openProduct();
    await waitFor(() => expect(screen.getByTestId("no-catalog-1")).toBeTruthy());
  });
});
