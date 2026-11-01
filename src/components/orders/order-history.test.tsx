// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useLocale: () => "es",
  useTranslations: () => (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

import { OrderHistory, ORDERS_CHANGED_EVENT } from "./order-history";

const CONV = "33333333-3333-4333-8333-333333333333";
const order = (over: Record<string, unknown> = {}) => ({
  id: "80abf267-5719-4ace-8adb-7e317141947c",
  confirmed_at: "2026-11-01T00:41:46Z",
  product: "Prensa de banco",
  quantity: 1,
  price: 110,
  confirmed_by_name: "Keyler Ortega",
  seller_name: "David Riveros",
  delivery_status: "held",
  sent_at: null,
  acknowledged_at: null,
  attempts: 0,
  ...over,
});
const answer = (body: unknown, status = 200) => {
  const f = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
};

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OrderHistory", () => {
  it("lists several orders of the conversation with product, amount, status and Lima time", async () => {
    answer({ enabled: true, orders: [order(), order({ id: "b", product: "Adaptador", delivery_status: "acknowledged" })], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("Prensa de banco");
    expect(screen.getByText("Adaptador")).toBeTruthy();
    expect(screen.getByText("statusHeld")).toBeTruthy();
    expect(screen.getByText("statusAcknowledged")).toBeTruthy();
    expect(screen.getAllByText(/S\/ 110\.00/).length).toBe(2);
    expect(screen.getAllByText(/31 oct 2026, 19:41 \(Lima\)/).length).toBe(2);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(`conversation_id=${CONV}`);
  });

  it("renders nothing when the feature is off, or when the lookup fails for the first time (viewer, 500, network)", async () => {
    answer({ enabled: false, orders: [], has_more: false });
    const a = render(<OrderHistory conversationId={CONV} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(a.container.textContent).toBe("");
    a.unmount();

    answer({ error: "forbidden" }, 403);
    const b = render(<OrderHistory conversationId={CONV} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.container.textContent).toBe("");
    b.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const c = render(<OrderHistory conversationId={CONV} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.container.textContent).toBe("");
  });

  it("shows the empty state, and nothing at all without a conversation", async () => {
    answer({ enabled: true, orders: [], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("historyEmpty");
    cleanup();
    const f = answer({ enabled: true, orders: [], has_more: false });
    const { container } = render(<OrderHistory conversationId={null} />);
    expect(container.textContent).toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the list and offers a retry when a later refresh fails", async () => {
    const f = answer({ enabled: true, orders: [order()], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("Prensa de banco");
    f.mockImplementation(async () => new Response("{}", { status: 500 }));
    fireEvent.click(screen.getByLabelText("historyRefresh"));
    await screen.findByText("historyRetry");
    expect(screen.getByText("Prensa de banco")).toBeTruthy();
  });

  it("opens the detail with author and seller as separate fields, the Lima dates and the identifier", async () => {
    answer({ enabled: true, orders: [order({ delivery_status: "acknowledged", sent_at: "2026-11-01T00:57:47Z", acknowledged_at: "2026-11-01T01:01:49Z", attempts: 1 })], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    fireEvent.click(await screen.findByText("Prensa de banco"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Keyler Ortega");
    expect(dialog.textContent).toContain("David Riveros");
    expect(dialog.textContent).toContain("19:57 (Lima)");
    expect(dialog.textContent).toContain("20:01 (Lima)");
    expect(dialog.textContent).toContain("80abf267-5719-4ace-8adb-7e317141947c");
  });

  it("an unsent order shows an em dash, not an invented date", async () => {
    answer({ enabled: true, orders: [order()], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    fireEvent.click(await screen.findByText("Prensa de banco"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("detailNone");
    expect(dialog.textContent).not.toContain("1970");
  });

  it("refreshes at once when an order is confirmed (event), so the new order appears without waiting", async () => {
    const f = answer({ enabled: true, orders: [], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("historyEmpty");
    f.mockImplementation(async () => new Response(JSON.stringify({ enabled: true, orders: [order({ product: "Nuevo" })], has_more: false })));
    act(() => {
      window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT));
    });
    await screen.findByText("Nuevo");
  });

  it("polls while an order is still in flight and picks up the new status; it stops once nothing can change", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = answer({ enabled: true, orders: [order({ delivery_status: "sent" })], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("statusSent");
    f.mockImplementation(async () => new Response(JSON.stringify({ enabled: true, orders: [order({ delivery_status: "acknowledged" })], has_more: false })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await screen.findByText("statusAcknowledged");
    const calls = f.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(f.mock.calls.length).toBe(calls);
  });

  it("a held order is stable: no polling at all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const f = answer({ enabled: true, orders: [order()], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    await screen.findByText("statusHeld");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("only ever issues GET requests (it can never change or resend an order)", async () => {
    const f = answer({ enabled: true, orders: [order({ delivery_status: "failed" })], has_more: false });
    render(<OrderHistory conversationId={CONV} />);
    fireEvent.click(await screen.findByText("Prensa de banco"));
    await screen.findByRole("dialog");
    for (const call of f.mock.calls) expect((call[1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });
});
