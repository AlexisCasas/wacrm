// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { ContactAutomationToggle } from "./contact-automation-toggle";
import { ORDERS_CHANGED_EVENT } from "@/components/orders/order-history";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

const h = vi.hoisted(() => ({
  canSendMessages: true,
  paused: {} as Record<string, boolean>,
  reads: [] as string[],
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ canSendMessages: h.canSendMessages }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (k: string, v: string) => ((filters[k] = v), b),
        maybeSingle: () => {
          h.reads.push(`${table}:${filters.contact_id}`);
          const v = h.paused[filters.contact_id];
          return Promise.resolve({ data: v === undefined ? null : { keyword_automations_paused: v }, error: null });
        },
      };
      return b;
    },
  }),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  h.canSendMessages = true;
  h.paused = { angelo: true, keyler: false };
  h.reads = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const status = () => screen.getByTestId("automations-status").textContent;

describe("ContactAutomationToggle", () => {
  it("active contact: shows Pausar and pausing persists through the API, then shows Reanudar", async () => {
    render(<ContactAutomationToggle contactId="keyler" />);
    fireEvent.click(await screen.findByText("automationsPause"));
    await waitFor(() => expect(screen.getByText("automationsResume")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith("/api/contacts/keyler/automation-pause", expect.objectContaining({ method: "PUT", body: JSON.stringify({ paused: true }) }));
    expect(status()).toBe("automationsPausedState");
  });

  it("paused contact: shows Reanudar and resuming goes back to Pausar", async () => {
    render(<ContactAutomationToggle contactId="angelo" />);
    expect(await screen.findByText("automationsResume")).toBeTruthy();
    expect(status()).toBe("automationsPausedState");
    fireEvent.click(screen.getByText("automationsResume"));
    await waitFor(() => expect(screen.getByText("automationsPause")).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ paused: false });
  });

  it("a failed write keeps the real previous state and shows an error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    render(<ContactAutomationToggle contactId="keyler" />);
    fireEvent.click(await screen.findByText("automationsPause"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("automationsError"));
    expect(screen.getByText("automationsPause")).toBeTruthy();
    expect(status()).toBe("automationsActive");
  });

  it("blocks a double click while the request is in flight", async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => { release = r; }));
    render(<ContactAutomationToggle contactId="keyler" />);
    const button = (await screen.findByText("automationsPause")).closest("button") as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    release({ ok: true });
    await waitFor(() => expect(screen.getByText("automationsResume")).toBeTruthy());
  });

  it("viewer sees the state but has no button", async () => {
    h.canSendMessages = false;
    render(<ContactAutomationToggle contactId="angelo" />);
    await waitFor(() => expect(status()).toBe("automationsPausedState"));
    expect(screen.queryByText("automationsResume")).toBeNull();
    expect(screen.queryByText("automationsPause")).toBeNull();
  });

  it("12. A (paused) -> B (active) on the same instance never shows A's state for B", async () => {
    const { rerender } = render(<ContactAutomationToggle contactId="angelo" />);
    expect(await screen.findByText("automationsResume")).toBeTruthy();
    rerender(<ContactAutomationToggle contactId="keyler" />);
    expect(screen.queryByTestId("automations-status")).toBeNull();
    expect(screen.queryByText("automationsResume")).toBeNull();
    expect(await screen.findByText("automationsPause")).toBeTruthy();
    expect(status()).toBe("automationsActive");
    expect(h.reads).toEqual(["contact_automation_settings:angelo", "contact_automation_settings:keyler"]);
  });
});

describe("ContactAutomationToggle — Confirmar pedido", () => {
  it("2. an active contact flips from Pausar to Reanudar when an order is confirmed, without a reload and without any extra control", async () => {
    render(<ContactAutomationToggle contactId="keyler" />);
    expect(await screen.findByText("automationsPause")).toBeTruthy();
    expect(status()).toBe("automationsActive");
    h.paused.keyler = true; // what create_order_confirmation just did on the server
    window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByText("automationsResume")).toBeTruthy());
    expect(status()).toBe("automationsPausedState");
    expect(screen.queryByText("automationsPause")).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1); // still the one existing button
    expect(fetchMock).not.toHaveBeenCalled(); // the UI only re-reads: it never writes the pause itself
  });

  it("keeps showing the current state while it re-reads (no flicker back to a spinner)", async () => {
    render(<ContactAutomationToggle contactId="keyler" />);
    await screen.findByText("automationsPause");
    window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT));
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(h.reads.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText("automationsPause")).toBeTruthy();
  });

  it("9/11. Reanudar writes only the existing pause flag, and a NEW confirmation afterwards pauses (Reanudar) again", async () => {
    render(<ContactAutomationToggle contactId="angelo" />);
    fireEvent.click(await screen.findByText("automationsResume"));
    await waitFor(() => expect(screen.getByText("automationsPause")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/contacts/angelo/automation-pause");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ paused: false }); // nothing about runs, waits or pendings is sent
    h.paused.angelo = true; // second order confirmed
    window.dispatchEvent(new Event(ORDERS_CHANGED_EVENT));
    await waitFor(() => expect(screen.getByText("automationsResume")).toBeTruthy());
    expect(status()).toBe("automationsPausedState");
  });

  it("12. the sidebar control never blocks anything: it only offers the existing pause/resume button to agents who can send", async () => {
    h.canSendMessages = false;
    render(<ContactAutomationToggle contactId="angelo" />);
    await screen.findByTestId("automations-status");
    expect(screen.queryByRole("button")).toBeNull();
    expect(status()).toBe("automationsPausedState");
  });
});
