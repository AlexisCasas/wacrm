// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GlobalIncomingCallAlert } from "./global-incoming-call-alert";

const authz = vi.hoisted(() => ({ sendMessages: true }));
vi.mock("@/hooks/use-can", () => ({
  useCan: () => authz.sendMessages,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const otherConversation = "a3000000-0000-4000-8000-000000000099";
const currentConversation = "a3000000-0000-4000-8000-000000000004";

function response(calls: unknown[]) {
  return new Response(JSON.stringify({ calls }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function incoming(
  overrides: Partial<{
    conversation_id: string;
    customer_name: string | null;
    created_at: string;
    expires_at: string;
  }> = {},
) {
  return {
    conversation_id: otherConversation,
    customer_name: "Alexis",
    created_at: new Date(Date.now()).toISOString(),
    expires_at: new Date(Date.now() + 50_000).toISOString(),
    ...overrides,
  };
}

describe("GlobalIncomingCallAlert", () => {
  beforeEach(() => {
    authz.sendMessages = true;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a call from another thread and navigates without claiming or touching the mic", async () => {
    const fetchCalls = vi.fn(async () => response([incoming()]));
    const onOpenConversation = vi.fn();
    render(
      <GlobalIncomingCallAlert
        activeConversationId={currentConversation}
        onOpenConversation={onOpenConversation}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("incomingCall: Alexis")).toBeTruthy();
    expect(fetchCalls).toHaveBeenCalledWith(
      "/api/whatsapp/calls?inbox_alerts=1",
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "openIncomingConversation" }));
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(onOpenConversation).toHaveBeenCalledWith(otherConversation);
    expect(fetchCalls).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the alert for the already-selected caller", async () => {
    const fetchCalls = vi.fn(async () => response([incoming()]));
    const onOpenConversation = vi.fn();

    render(
      <GlobalIncomingCallAlert
        activeConversationId={otherConversation}
        onOpenConversation={onOpenConversation}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    await waitFor(() => expect(fetchCalls).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("works without a selected conversation and uses a localized caller fallback", async () => {
    const fetchCalls = vi.fn(async () => response([incoming({ customer_name: null })]));
    render(
      <GlobalIncomingCallAlert
        activeConversationId={null}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("incomingCall"));
  });

  it("ignores offers expiring before microphone acquisition", async () => {
    const fetchCalls = vi.fn(async () => response([incoming({
      expires_at: new Date(Date.now() + 10_000).toISOString(),
    })]));
    render(
      <GlobalIncomingCallAlert
        activeConversationId={currentConversation}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    await waitFor(() => expect(fetchCalls).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not poll or reveal calls for read-only agents", async () => {
    authz.sendMessages = false;
    const fetchCalls = vi.fn();
    render(
      <GlobalIncomingCallAlert
        activeConversationId={currentConversation}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    expect(fetchCalls).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not display an alert if the server denies its scoped request", async () => {
    const fetchCalls = vi.fn(async () => new Response(null, { status: 403 }));
    render(
      <GlobalIncomingCallAlert
        activeConversationId={currentConversation}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    await waitFor(() => expect(fetchCalls).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prioritizes the oldest eligible caller when another is already selected", async () => {
    const first = incoming({ customer_name: "Primera" });
    const second = incoming({
      conversation_id: "a3000000-0000-4000-8000-000000000098",
      customer_name: "Segunda",
    });
    const fetchCalls = vi.fn(async () => response([first, second]));
    const view = render(
      <GlobalIncomingCallAlert
        activeConversationId={first.conversation_id}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );

    expect(await screen.findByText("incomingCall: Segunda")).toBeTruthy();
    view.rerender(
      <GlobalIncomingCallAlert
        activeConversationId={currentConversation}
        onOpenConversation={vi.fn()}
        fetchCalls={fetchCalls as typeof fetch}
      />,
    );
    expect(screen.getByText("incomingCall: Primera")).toBeTruthy();
  });
});
