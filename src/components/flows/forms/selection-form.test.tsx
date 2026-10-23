// @vitest-environment jsdom
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// F2-C editor: "Enviar todos los audios" / "Enviar un audio específico" in the Audios por producto node. The Select popup is replaced by plain
// buttons so a test can pick an option and prove that the node stores the UUID while the screen shows the visible name.
const Ctx = createContext<(v: string) => void>(() => {});
vi.mock("@/components/ui/select", () => ({
  Select: ({ onValueChange, children }: { onValueChange?: (v: string) => void; children: ReactNode }) => <Ctx.Provider value={onValueChange ?? (() => {})}><div>{children}</div></Ctx.Provider>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => { const pick = useContext(Ctx); return <button type="button" data-testid={`opt-${value}`} onClick={() => pick(value)}>{children}</button>; },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct-1" }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }) }) }) }) }));

import { NodeConfigForm } from "./node-config-form";
import type { BuilderNode } from "../shared";

const PU1 = "c1111111-1111-4111-8111-111111111111", PU_OFF = "c2222222-2222-4222-8222-222222222222", PU_GONE = "c9999999-9999-4999-8999-999999999999";
const ID1 = "d1111111-1111-4111-8111-111111111111", ID2 = "d2222222-2222-4222-8222-222222222222";
const PRODUCT = "44444444-4444-4444-8444-444444444444";

let purposes: unknown[], identifiers: unknown[], purposesStatus: number, productItems: unknown[];
const fetchMock = vi.fn<(url: string) => Promise<Response>>();
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  purposes = [{ id: PU1, name: "Pago", active: true, in_use: 1 }, { id: PU_OFF, name: "Promoción", active: false, in_use: 0 }];
  identifiers = [{ id: ID1, name: "Principal", active: true, in_use: 1 }, { id: ID2, name: "Alternativo", active: true, in_use: 0 }];
  purposesStatus = 200;
  productItems = [{ id: "i1", purpose_id: PU1, identifier_id: ID1, status: "active" }];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url) => {
    if (url === "/api/audio-guide/purposes") return reply(purposesStatus, purposesStatus < 400 ? { purposes } : { error: purposesStatus === 403 ? "voice_notes_disabled" : "internal_error" });
    if (url === "/api/audio-guide/identifiers") return reply(200, { identifiers });
    if (url === `/api/audio-guide/products/${PRODUCT}`) return reply(200, { product: { id: PRODUCT, items: productItems } });
    return reply(200, { products: [{ id: PRODUCT, product_key: "taladro pro", display_name: "Taladro Pro", active: true }] });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = { gate_mode: "none", gate_tag_id: "", product_source: "auto", product_field_id: "", product_id: "", next_node_key: "a", unknown_node_key: "b", no_audios_node_key: "c", gate_closed_node_key: "" };
const node = (config: Record<string, unknown>): BuilderNode => ({ node_key: "vp", node_type: "send_product_audios", config }) as BuilderNode;
const others: BuilderNode[] = ["a", "b", "c"].map((k) => ({ node_key: k, node_type: "end", config: {} }) as BuilderNode);
function mount(config: Record<string, unknown>) {
  const onUpdateConfig = vi.fn();
  render(<NodeConfigForm node={node(config)} allNodes={[node(config), ...others]} showAdvanced={false} onUpdateConfig={onUpdateConfig} />);
  return onUpdateConfig;
}
const checked = (testId: string) => (screen.getByTestId(testId).querySelector("input") as HTMLInputElement).checked;
const requested = () => fetchMock.mock.calls.map((c) => c[0]);

describe("choosing which audios: the original 'all' is the default and nothing is written on its own", () => {
  it("a node saved before the option existed shows 'all' selected, does not ask for a purpose, writes nothing and fetches no names", async () => {
    const onUpdate = mount(base);
    expect(checked("selection-all")).toBe(true);
    expect(checked("selection-single")).toBe(false);
    expect(screen.queryByTestId("single-audio")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(requested().some((u) => u.includes("purposes") || u.includes("identifiers"))).toBe(false);
  });
  it("choosing 'one specific audio' only sets the mode; going back to 'all' clears the purpose and identifier so no hidden condition is left", () => {
    let onUpdate = mount(base);
    fireEvent.click(screen.getByTestId("selection-single").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ audio_selection: "single" });
    cleanup();
    onUpdate = mount({ ...base, audio_selection: "single", purpose_id: PU1, identifier_id: ID1 });
    fireEvent.click(screen.getByTestId("selection-all").querySelector("input")!);
    expect(onUpdate).toHaveBeenCalledWith({ audio_selection: "all", purpose_id: "", identifier_id: "" });
  });
  it("a mode this version does not know is shown as neither choice (never as 'all')", () => {
    mount({ ...base, audio_selection: "group" });
    expect(checked("selection-all")).toBe(false);
    expect(checked("selection-single")).toBe(false);
  });
  it("every choice has its explanation and example, and the other controls are still there", () => {
    mount(base);
    for (const key of ["productAudiosSelectionAll", "productAudiosSelectionAllExample", "productAudiosSelectionSingle", "productAudiosSelectionSingleHelp", "productAudiosSelectionSingleExample", "productAudiosSelectionTitle"]) expect(screen.getAllByText(key).length, key).toBeGreaterThan(0);
    for (const id of ["gate-choice", "source-choice"]) expect(screen.getByTestId(id)).toBeTruthy();
    for (const label of ["productAudiosRouteNext", "productAudiosRouteUnknown", "productAudiosRouteNoAudios"]) expect(screen.getByText(label)).toBeTruthy();
  });
});

describe("one specific audio: purpose and identifier of THIS account, by visible name, stored as UUIDs", () => {
  it("loads only the account's lists, shows the visible names of the saved values, and never the ids", async () => {
    mount({ ...base, audio_selection: "single", purpose_id: PU1, identifier_id: ID2 });
    expect((await screen.findByTestId("purpose-field-name")).textContent).toBe("Pago");
    expect(screen.getByTestId("identifier-field-name").textContent).toBe("Alternativo");
    expect(requested()).toEqual(expect.arrayContaining(["/api/audio-guide/purposes", "/api/audio-guide/identifiers"]));
    expect(screen.queryByText(PU1)).toBeNull();
  });
  it("picking an option writes the UUID of that option (not its name) and nothing else", async () => {
    const onUpdate = mount({ ...base, audio_selection: "single" });
    fireEvent.click(await screen.findByTestId(`opt-${PU1}`));
    expect(onUpdate).toHaveBeenLastCalledWith({ purpose_id: PU1 });
    fireEvent.click(screen.getByTestId(`opt-${ID2}`));
    expect(onUpdate).toHaveBeenLastCalledWith({ identifier_id: ID2 });
  });
  it("an inactive purpose is offered only when it is the saved one, and is flagged; other inactive ones are not offered", async () => {
    mount({ ...base, audio_selection: "single", purpose_id: PU1, identifier_id: ID1 });
    await screen.findByTestId("purpose-field-name");
    expect(screen.queryByTestId(`opt-${PU_OFF}`)).toBeNull();
    cleanup();
    mount({ ...base, audio_selection: "single", purpose_id: PU_OFF, identifier_id: ID1 });
    expect((await screen.findByTestId("purpose-field-name")).textContent).toContain("productAudiosNameInactive");
    expect(screen.getByTestId("purpose-field-inactive")).toBeTruthy();
  });
  it("a purpose or identifier that was deleted (or belongs to another account) is reported instead of shown as chosen", async () => {
    mount({ ...base, audio_selection: "single", purpose_id: PU_GONE, identifier_id: ID1 });
    expect(await screen.findByTestId("purpose-field-gone")).toBeTruthy();
    expect(screen.queryByTestId("purpose-field-name")).toBeNull();
  });
  it("missing values are flagged so the person knows the step cannot be activated", async () => {
    mount({ ...base, audio_selection: "single" });
    expect(await screen.findByTestId("purpose-field-missing")).toBeTruthy();
    expect(screen.getByTestId("identifier-field-missing")).toBeTruthy();
  });
  it("tells the person when the module is off, the lists fail to load, or there is nothing to choose yet", async () => {
    purposesStatus = 403;
    mount({ ...base, audio_selection: "single" });
    expect(await screen.findByText("productAudiosNamesDisabled")).toBeTruthy();
    cleanup();
    purposesStatus = 500;
    mount({ ...base, audio_selection: "single" });
    expect(await screen.findByText("productAudiosNamesError")).toBeTruthy();
    cleanup();
    purposesStatus = 200; purposes = []; identifiers = [];
    mount({ ...base, audio_selection: "single" });
    expect(await screen.findByTestId("names-empty")).toBeTruthy();
  });
});

describe("warning when no audio carries the chosen pair (product chosen by hand)", () => {
  const manual = { ...base, product_source: "manual", product_id: PRODUCT, audio_selection: "single", purpose_id: PU1, identifier_id: ID1 };
  it("found / missing classification / switched-off audio", async () => {
    mount(manual);
    await waitFor(() => expect(screen.getByTestId("audio-match").getAttribute("data-match")).toBe("found"));
    cleanup();
    productItems = [{ id: "i1", purpose_id: null, identifier_id: null, status: "active" }];
    mount(manual);
    await waitFor(() => expect(screen.getByTestId("audio-match").getAttribute("data-match")).toBe("missing"));
    expect(screen.getByText("productAudiosMatchMissing")).toBeTruthy();
    cleanup();
    productItems = [{ id: "i1", purpose_id: PU1, identifier_id: ID1, status: "disabled" }];
    mount(manual);
    await waitFor(() => expect(screen.getByTestId("audio-match").getAttribute("data-match")).toBe("disabled"));
  });
  it("with the automatic product it says the check happens when sending, and does not read any product", async () => {
    mount({ ...base, audio_selection: "single", purpose_id: PU1, identifier_id: ID1 });
    expect((await screen.findByTestId("audio-match")).getAttribute("data-match")).toBe("auto");
    expect(requested().some((u) => u.startsWith(`/api/audio-guide/products/`))).toBe(false);
  });
});
