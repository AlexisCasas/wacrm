// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { FlowStartPicker } from "./flow-start-picker";

// Non-blocking manual Flow start. The picker must release the UI as soon
// as the agent confirms, while the POST (which owns the whole run on the
// server) keeps going and reports through toasts tied to the ORIGINAL
// contact. Server-side rules are untouched; they keep their own suites.

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const messages: Record<string, string> = {
      confirm: "Start Flow",
      successToast: "Flow started: {flowName}",
      errorActiveFlow: "Active: {flowName}",
      errorContactBlocked: "Blocked",
      errorBsuidFlowNotAuthorized: "BSUID not authorized",
      errorContactRecipientUnavailable: "Recipient unavailable",
      errorFailedImmediately: "Failed immediately",
      errorGeneric: "Generic error",
    };
    let str = messages[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) str = str.replace(`{${k}}`, String(v));
    return str;
  },
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const FLOWS = [{ id: "f1", name: "Flow One", status: "active", trigger_type: "manual" }];
type Deferred = { resolve: (r: Response) => void };

function okStart(flowName = "Flow One") {
  return { ok: true, json: async () => ({ success: true, flow_name: flowName }) } as Response;
}
function failStart(code: string, extra: Record<string, unknown> = {}) {
  return { ok: false, json: async () => ({ error: code, code, ...extra }) } as Response;
}

/** fetch mock whose start POSTs stay pending until resolved by the test. */
function pendingFetch() {
  const pending: Array<Deferred & { conversation_id: string }> = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/flows") {
      return Promise.resolve({ ok: true, json: async () => ({ flows: FLOWS }) } as Response);
    }
    return new Promise<Response>((resolve) => {
      pending.push({ resolve, conversation_id: JSON.parse(String(init?.body)).conversation_id });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const startCalls = () =>
    fetchMock.mock.calls.filter((c) => typeof c[0] === "string" && c[0].endsWith("/start"));
  return { pending, startCalls };
}

async function pickAndConfirm() {
  fireEvent.click(await screen.findByText("Flow One"));
  fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

describe("FlowStartPicker — non-blocking manual start", () => {
  it("1. releases the UI immediately while the POST is still pending", async () => {
    const { pending, startCalls } = pendingFetch();
    const onOpenChange = vi.fn();
    render(
      <FlowStartPicker open onOpenChange={onOpenChange} conversationId="conv-a1" contactDisplayName="Ana" />,
    );
    await pickAndConfirm();

    expect(onOpenChange).toHaveBeenCalledWith(false); // closed before any response
    expect(startCalls()).toHaveLength(1);
    expect(toastMock.success).not.toHaveBeenCalled(); // no success before backend accepts

    pending[0].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Flow started: Flow One", { description: "Ana" }));
  });

  it("2/10. a late response for A does not touch B (dialog, callbacks, toast text)", async () => {
    const { pending } = pendingFetch();
    const onOpenChangeA = vi.fn();
    const onStartedA = vi.fn();
    const view = render(
      <FlowStartPicker open onOpenChange={onOpenChangeA} onStarted={onStartedA} conversationId="conv-a2" contactDisplayName="Ana" />,
    );
    await pickAndConfirm();
    onOpenChangeA.mockClear();

    // agent switches to B: same component slot, new props, picker closed
    const onOpenChangeB = vi.fn();
    const onStartedB = vi.fn();
    view.rerender(
      <FlowStartPicker open={false} onOpenChange={onOpenChangeB} onStarted={onStartedB} conversationId="conv-b2" contactDisplayName="Beto" />,
    );

    pending[0].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));

    expect(toastMock.success).toHaveBeenCalledWith("Flow started: Flow One", { description: "Ana" });
    expect(onStartedA).toHaveBeenCalledTimes(1); // A's own refresh callback only
    expect(onStartedB).not.toHaveBeenCalled();
    expect(onOpenChangeB).not.toHaveBeenCalled();
    expect(onOpenChangeA).not.toHaveBeenCalled(); // no late close either
  });

  it("2/10. a late ERROR for A is attributed to A and never succeeds", async () => {
    const { pending } = pendingFetch();
    const view = render(
      <FlowStartPicker open onOpenChange={vi.fn()} conversationId="conv-a3" contactDisplayName="Ana" />,
    );
    await pickAndConfirm();
    view.unmount(); // user navigated away; component gone

    pending[0].resolve(failStart("active_flow_exists", { active_flow_name: "Otro" }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Active: Otro", { description: "Ana" }));
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("3/4. A, B and C start independently and in parallel, each bound to its own conversation", async () => {
    const { pending, startCalls } = pendingFetch();
    const names: Record<string, string> = { "conv-a4": "Ana", "conv-b4": "Beto", "conv-c4": "Carla" };
    for (const id of Object.keys(names)) {
      render(<FlowStartPicker open onOpenChange={vi.fn()} conversationId={id} contactDisplayName={names[id]} />);
      await pickAndConfirm();
      cleanup(); // move on immediately; earlier POSTs still pending
    }
    expect(startCalls()).toHaveLength(3);
    expect(pending.map((p) => p.conversation_id).sort()).toEqual(["conv-a4", "conv-b4", "conv-c4"]);

    // resolve out of order
    pending[2].resolve(okStart());
    pending[0].resolve(okStart());
    pending[1].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(3));
    const who = toastMock.success.mock.calls.map((c) => c[1].description).sort();
    expect(who).toEqual(["Ana", "Beto", "Carla"]);
  });

  it("5. rapid double click sends ONE POST", async () => {
    const { pending, startCalls } = pendingFetch();
    render(<FlowStartPicker open onOpenChange={vi.fn()} conversationId="conv-a5" contactDisplayName="Ana" />);
    fireEvent.click(await screen.findByText("Flow One"));
    const btn = screen.getByRole("button", { name: "Start Flow" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(startCalls()).toHaveLength(1);
    pending[0].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
  });

  it("5. re-opening the picker for the same conversation while its POST is pending sends no second POST", async () => {
    const { pending, startCalls } = pendingFetch();
    const props = { onOpenChange: vi.fn(), conversationId: "conv-a6", contactDisplayName: "Ana" };
    const view = render(<FlowStartPicker open {...props} />);
    await pickAndConfirm();
    view.rerender(<FlowStartPicker open={false} {...props} />);
    view.rerender(<FlowStartPicker open {...props} />);
    await pickAndConfirm();
    expect(startCalls()).toHaveLength(1);

    pending[0].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));

    // guard released once the first request settled
    view.rerender(<FlowStartPicker open={false} {...props} />);
    view.rerender(<FlowStartPicker open {...props} />);
    await pickAndConfirm();
    expect(startCalls()).toHaveLength(2);
    pending[1].resolve(okStart());
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["6. generic/validation error", failStart("conversation_not_found"), "Generic error"],
    ["8. contact_blocked", failStart("contact_blocked"), "Blocked"],
    ["9. bsuid_flow_not_authorized", failStart("bsuid_flow_not_authorized"), "BSUID not authorized"],
    ["9. contact_recipient_unavailable", failStart("contact_recipient_unavailable"), "Recipient unavailable"],
    ["7. active_flow_exists", failStart("active_flow_exists", { active_flow_name: "X" }), "Active: X"],
    ["flow_failed_immediately", failStart("flow_failed_immediately"), "Failed immediately"],
  ])("%s: error toast, no false success, no onStarted", async (_n, response, message) => {
    const { pending } = pendingFetch();
    const onStarted = vi.fn();
    render(
      <FlowStartPicker open onOpenChange={vi.fn()} onStarted={onStarted} conversationId={`conv-${message}`} contactDisplayName="Ana" />,
    );
    await pickAndConfirm();
    pending[0].resolve(response);
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(message, { description: "Ana" }));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("network failure shows the generic error, never a success", async () => {
    const fetchMock = vi.fn((url: string) =>
      url === "/api/flows"
        ? Promise.resolve({ ok: true, json: async () => ({ flows: FLOWS }) } as Response)
        : Promise.reject(new Error("offline")),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<FlowStartPicker open onOpenChange={vi.fn()} conversationId="conv-a8" contactDisplayName="Ana" />);
    await pickAndConfirm();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("Generic error", { description: "Ana" }));
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
