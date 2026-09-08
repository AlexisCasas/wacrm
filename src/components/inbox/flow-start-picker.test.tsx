// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { FlowStartPicker } from "./flow-start-picker";

// P0 — DISPARO MANUAL DE FLOW DESDE INBOX. Component coverage for the
// picker's own contract: fetch on open, active-only + search filtering,
// select -> confirm -> start, success/error handling, and the
// double-submit guard. Permission gating (`useCan("send-messages")`)
// and the 24h `sessionInfo.expired` disabled-state live in
// message-thread.tsx's header JSX around this component, not here.

const messages: Record<string, string> = {
  title: "Start Flow",
  searchPlaceholder: "Search flows...",
  empty: "No active flows available.",
  confirmDescription: 'Start "{flowName}" for {contactName}?',
  back: "Back",
  cancel: "Cancel",
  confirm: "Start Flow",
  starting: "Starting...",
  successToast: "Flow started: {flowName}",
  errorActiveFlow: "This contact already has an active Flow: {flowName}.",
  errorServiceWindow: "A Flow can't be started outside the 24-hour service window.",
  errorContactBlocked: "This contact is blocked. Unblock them first to start a Flow.",
  errorGeneric: "Couldn't start the flow. Please try again.",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    let str = messages[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  },
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const FLOWS = [
  { id: "f-keyword", name: "Combo XTD Taladro", status: "active", trigger_type: "keyword" },
  { id: "f-manual", name: "Manual Only Flow", status: "active", trigger_type: "manual" },
  { id: "f-first", name: "Welcome Flow", status: "active", trigger_type: "first_inbound_message" },
  { id: "f-draft", name: "Draft Flow", status: "draft", trigger_type: "keyword" },
  { id: "f-archived", name: "Old Flow", status: "archived", trigger_type: "keyword" },
];

function mockFetch(overrides?: { startResponse?: () => Promise<Response> }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/flows") {
      return {
        ok: true,
        json: async () => ({ flows: FLOWS }),
      } as Response;
    }
    if (url.startsWith("/api/flows/") && url.endsWith("/start") && init?.method === "POST") {
      if (overrides?.startResponse) return overrides.startResponse();
      return {
        ok: true,
        json: async () => ({
          success: true,
          flow_run_id: "run-1",
          flow_id: "f-keyword",
          flow_name: "Combo XTD Taladro",
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
});

const BASE_PROPS = {
  conversationId: "conv-1",
  contactDisplayName: "Juan Pérez",
};

describe("FlowStartPicker — fetch + filtering", () => {
  it("fetches /api/flows when opened", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/flows", expect.anything());
    });
  });

  it("does not fetch when closed", () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<FlowStartPicker open={false} onOpenChange={vi.fn()} {...BASE_PROPS} />);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows only active flows — keyword, manual, and first_inbound_message all appear; draft/archived hidden", async () => {
    vi.stubGlobal("fetch", mockFetch());

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);

    expect(await screen.findByText("Combo XTD Taladro")).toBeInTheDocument();
    expect(screen.getByText("Manual Only Flow")).toBeInTheDocument();
    expect(screen.getByText("Welcome Flow")).toBeInTheDocument();
    expect(screen.queryByText("Draft Flow")).not.toBeInTheDocument();
    expect(screen.queryByText("Old Flow")).not.toBeInTheDocument();
  });

  it("filters by name, case-insensitively", async () => {
    vi.stubGlobal("fetch", mockFetch());

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    await screen.findByText("Combo XTD Taladro");

    fireEvent.change(screen.getByPlaceholderText("Search flows..."), {
      target: { value: "welcome" },
    });

    expect(screen.queryByText("Combo XTD Taladro")).not.toBeInTheDocument();
    expect(screen.getByText("Welcome Flow")).toBeInTheDocument();
  });

  it("shows the empty state when no active flows exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/flows") {
          return { ok: true, json: async () => ({ flows: [] }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }),
    );

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);

    expect(await screen.findByText("No active flows available.")).toBeInTheDocument();
  });
});

describe("FlowStartPicker — selection + confirmation", () => {
  it("selecting a flow shows the confirmation with flow + contact names", async () => {
    vi.stubGlobal("fetch", mockFetch());

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));

    expect(
      await screen.findByText('Start "Combo XTD Taladro" for Juan Pérez?'),
    ).toBeInTheDocument();
  });

  it("Cancel on the confirmation returns to the list without submitting", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByText("Cancel"));

    expect(await screen.findByPlaceholderText("Search flows...")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/start"),
      expect.anything(),
    );
  });
});

describe("FlowStartPicker — starting a flow", () => {
  it("POSTs conversation_id, shows a success toast, closes the dialog, and fires onStarted", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChange = vi.fn();
    const onStarted = vi.fn();

    render(
      <FlowStartPicker
        open={true}
        onOpenChange={onOpenChange}
        onStarted={onStarted}
        {...BASE_PROPS}
      />,
    );
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/flows/f-keyword/start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ conversation_id: "conv-1" }),
        }),
      );
    });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Flow started: Combo XTD Taladro"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("does not double-submit when the confirm button is clicked twice quickly", async () => {
    let resolveStart!: (v: Response) => void;
    const startPromise = new Promise<Response>((resolve) => {
      resolveStart = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/flows") return { ok: true, json: async () => ({ flows: FLOWS }) } as Response;
      if (url.endsWith("/start") && init?.method === "POST") return startPromise;
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    const confirmBtn = screen.getByRole("button", { name: "Start Flow" });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    resolveStart({
      ok: true,
      json: async () => ({ success: true, flow_run_id: "run-1", flow_id: "f-keyword", flow_name: "Combo XTD Taladro" }),
    } as Response);

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    const startCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].endsWith("/start"),
    );
    expect(startCalls).toHaveLength(1);
  });

  it("active_flow_exists error shows a distinct toast naming the existing flow and keeps the dialog open", async () => {
    const onOpenChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      mockFetch({
        startResponse: async () =>
          ({
            ok: false,
            json: async () => ({
              error: "conflict",
              code: "active_flow_exists",
              active_flow_name: "AMOLADORA TOTAL",
            }),
          }) as Response,
      }),
    );

    render(<FlowStartPicker open={true} onOpenChange={onOpenChange} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "This contact already has an active Flow: AMOLADORA TOTAL.",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("service_window_expired error shows the service-window toast", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        startResponse: async () =>
          ({
            ok: false,
            json: async () => ({ error: "expired", code: "service_window_expired" }),
          }) as Response,
      }),
    );

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "A Flow can't be started outside the 24-hour service window.",
      ),
    );
  });

  it("contact_blocked error shows the blocked-contact toast (P0 contact blocking)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        startResponse: async () =>
          ({
            ok: false,
            json: async () => ({ error: "blocked", code: "contact_blocked" }),
          }) as Response,
      }),
    );

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "This contact is blocked. Unblock them first to start a Flow.",
      ),
    );
  });

  it("an unrecognized error code falls back to the generic error toast", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        startResponse: async () =>
          ({ ok: false, json: async () => ({ error: "boom" }) }) as Response,
      }),
    );

    render(<FlowStartPicker open={true} onOpenChange={vi.fn()} {...BASE_PROPS} />);
    fireEvent.click(await screen.findByText("Combo XTD Taladro"));
    fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't start the flow. Please try again."),
    );
  });
});
