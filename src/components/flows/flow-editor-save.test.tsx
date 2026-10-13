// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";

import { FlowEditorProvider, useFlowEditor, type FlowEditorContextValue } from "./flow-editor-state";
import type { FlowNodeRow, FlowRow } from "@/lib/flows/types";

// P1-A / P1-B: save() must report success or failure explicitly, a failed save must keep the edits pending, and activation
// must never reach /activate unless the save before it was confirmed.

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));

const FLOW = {
  id: "flow-1", name: "Draft", description: null, status: "draft", trigger_type: "manual", trigger_config: {}, entry_node_id: "hello",
  fallback_policy: {}, user_id: "u", account_id: "a", created_at: "", updated_at: "",
} as unknown as FlowRow;
const NODES = [
  { id: "n1", flow_id: "flow-1", node_key: "hello", node_type: "send_message", config: { text: "hola", next_node_key: "end" }, position_x: 0, position_y: 0 },
  { id: "n2", flow_id: "flow-1", node_key: "end", node_type: "end", config: {}, position_x: 0, position_y: 0 },
] as unknown as FlowNodeRow[];

let ctx: FlowEditorContextValue;
const capture = (value: FlowEditorContextValue) => { ctx = value; };
function Probe() { const value = useFlowEditor(); useEffect(() => { capture(value); }); return null; }
const mount = () => render(<FlowEditorProvider initialFlow={FLOW} initialNodes={NODES}><Probe /></FlowEditorProvider>);

type Call = { url: string; method: string };
let calls: Call[];
/** fetch double: each rule decides the answer for "METHOD url-suffix". */
function stubFetch(rules: Record<string, () => Response | Promise<Response>>) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const key = Object.keys(rules).find((k) => `${method} ${url}`.endsWith(k));
    if (!key) throw new Error(`unexpected request ${method} ${url}`);
    return rules[key]();
  }));
}
const ok = (body: unknown = {}) => () => Response.json(body, { status: 200 });
const fail = (status: number, error: string) => () => Response.json({ error }, { status });
const activations = () => calls.filter((c) => c.url.endsWith("/activate"));

beforeEach(() => { toastSuccess.mockClear(); toastError.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("flow editor save contract", () => {
  it("a confirmed save resolves true, clears the pending-changes flag and reports success once", async () => {
    stubFetch({ "PUT /api/flows/flow-1": ok({ flow: FLOW, nodes: [] }) });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    expect(ctx.dirty).toBe(true);
    let saved: boolean | undefined;
    await act(async () => { saved = await ctx.save(); });
    expect(saved).toBe(true);
    expect(ctx.dirty).toBe(false);
    expect(ctx.saving).toBe(false);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(calls).toEqual([{ url: "/api/flows/flow-1", method: "PUT" }]);
  });

  it.each([
    ["a validation failure (422)", fail(422, "The flow definition is not valid. Nothing was saved.")],
    ["a server failure (500)", fail(500, "Could not save flow")],
    ["a permission failure (403)", fail(403, "Forbidden")],
    ["an unreadable error body", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["a network failure", () => { throw new TypeError("Failed to fetch"); }],
  ])("%s resolves false, keeps the edits pending, shows ONE error and no success", async (_label, answer) => {
    stubFetch({ "PUT /api/flows/flow-1": answer });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    let saved: boolean | undefined;
    await act(async () => { saved = await ctx.save(); });
    expect(saved).toBe(false);
    expect(ctx.dirty).toBe(true);             // the unsaved edits are still flagged
    expect(ctx.state.name).toBe("Changed");   // and still on screen
    expect(ctx.saving).toBe(false);           // no stuck spinner
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("the server's explanation reaches the user", async () => {
    stubFetch({ "PUT /api/flows/flow-1": fail(422, "The flow definition is not valid (for example a duplicated or unknown node). Nothing was saved.") });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.save(); });
    expect(toastError).toHaveBeenCalledWith("The flow definition is not valid (for example a duplicated or unknown node). Nothing was saved.");
  });

  it("a failed retry can be followed by a successful one: the same edits are saved and the flag clears", async () => {
    let attempts = 0;
    stubFetch({ "PUT /api/flows/flow-1": () => (++attempts === 1 ? fail(500, "Could not save flow")() : ok({ flow: FLOW, nodes: [] })()) });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { expect(await ctx.save()).toBe(false); });
    expect(ctx.dirty).toBe(true);
    await act(async () => { expect(await ctx.save()).toBe(true); });
    expect(ctx.dirty).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
  });
});

describe("activation after a save (P1-B)", () => {
  it("does NOT call /activate when the save before it fails, and keeps the edits pending", async () => {
    stubFetch({ "PUT /api/flows/flow-1": fail(500, "Could not save flow"), "POST /api/flows/flow-1/activate": ok({}) });
    mount();
    expect(ctx.canActivate).toBe(true);
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.setStatus("active"); });
    expect(activations()).toHaveLength(0);       // the previous server version is never published
    expect(ctx.state.status).toBe("draft");
    expect(ctx.dirty).toBe(true);
    expect(ctx.activating).toBe(false);          // loading state is released
    expect(ctx.saving).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1); // the save error, once: no second alert from the activation path
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("does NOT call /activate when the save request itself cannot be sent (network)", async () => {
    stubFetch({ "PUT /api/flows/flow-1": () => { throw new TypeError("Failed to fetch"); }, "POST /api/flows/flow-1/activate": ok({}) });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.setStatus("active"); });
    expect(activations()).toHaveLength(0);
    expect(ctx.state.status).toBe("draft");
    expect(ctx.dirty).toBe(true);
  });

  it("calls /activate exactly once, after the confirmed save, when the save works", async () => {
    stubFetch({ "PUT /api/flows/flow-1": ok({ flow: FLOW, nodes: [] }), "POST /api/flows/flow-1/activate": ok({}) });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.setStatus("active"); });
    expect(calls.map((c) => c.method)).toEqual(["PUT", "POST"]);   // saved first, then activated
    expect(ctx.state.status).toBe("active");
    expect(ctx.dirty).toBe(false);
    expect(ctx.activating).toBe(false);
  });

  it("recovers: after a failed activation attempt the user retries and both steps succeed", async () => {
    let put = 0;
    stubFetch({ "PUT /api/flows/flow-1": () => (++put === 1 ? fail(500, "Could not save flow")() : ok({ flow: FLOW, nodes: [] })()), "POST /api/flows/flow-1/activate": ok({}) });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.setStatus("active"); });
    expect(activations()).toHaveLength(0);
    await act(async () => { await ctx.setStatus("active"); });
    expect(activations()).toHaveLength(1);
    expect(ctx.state.status).toBe("active");
    expect(ctx.dirty).toBe(false);
  });

  it("leaving active (back to draft / archive) never saves first and is unaffected", async () => {
    stubFetch({ "POST /api/flows/flow-1/activate": ok({}) });
    mount();
    await act(async () => { await ctx.setStatus("archived"); });
    expect(calls).toEqual([{ url: "/api/flows/flow-1/activate", method: "POST" }]);
    expect(ctx.state.status).toBe("archived");
  });

  it("an /activate failure after a successful save still reports its own error", async () => {
    stubFetch({ "PUT /api/flows/flow-1": ok({ flow: FLOW, nodes: [] }), "POST /api/flows/flow-1/activate": fail(422, "Flow has validation errors") });
    mount();
    act(() => ctx.setState((s) => ({ ...s, name: "Changed" })));
    await act(async () => { await ctx.setStatus("active"); });
    expect(ctx.state.status).toBe("draft");
    expect(ctx.dirty).toBe(false);                 // the save did succeed
    expect(toastError).toHaveBeenCalledWith("Flow has validation errors");
  });
});
