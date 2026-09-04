// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { AiThreadBanner } from "./ai-thread-banner";

// ---------------------------------------------------------------------------
// Component-level coverage for the fail-safe handoff-visibility rule this
// round adds: a real handoff (paused + a non-empty handoffSummary) must
// render the amber "Needs human attention" banner unconditionally —
// regardless of the account's autoReplyOn status (which is fetched/cached
// separately) or whether a human is already assigned. Everything else
// (plain manual pause, active bot, Resume/Take-over actions) must keep
// behaving exactly as before.
//
// Each test uses its OWN accountId. AiThreadBanner's module-level
// `statusCache` is keyed by accountId and persists across tests/renders
// within this file (that's the real, intentional production behavior —
// see its own doc comment) — reusing an id across tests with different
// desired autoReplyOn values would read back a stale cached value instead
// of hitting the mocked fetch again.
// ---------------------------------------------------------------------------

const messages: Record<string, string> = {
  pausedTitle: "AI assistant is paused here",
  activeText: "AI assistant is replying automatically",
  takeOver: "Take over",
  resume: "Resume AI",
  tookOver: "You’ve taken over this chat.",
  resumed: "AI resumed.",
  updateError: "Couldn’t update the AI assistant.",
  networkError: "Couldn’t reach the server.",
  handoffTitle: "Needs human attention",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const h = vi.hoisted(() => ({ accountId: "acct-default" as string | null }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ accountId: h.accountId }),
}));

function mockConfigFetch(status: {
  configured?: boolean;
  is_active?: boolean;
  auto_reply_enabled?: boolean;
}) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/ai/config") {
      return {
        ok: true,
        json: async () => ({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
          ...status,
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ success: true, paused: false }) } as Response;
  });
}

afterEach(() => {
  // vitest.config.ts doesn't set `test.globals: true`, so
  // @testing-library/react's automatic per-test cleanup (which detects
  // a global `afterEach`) never registers — without this, DOM from each
  // `render()` accumulates across tests in this file.
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AiThreadBanner — handoff always visible (test #22, #23)", () => {
  it("renders the handoff banner even when autoReplyOn=false (account-level status stale/off)", async () => {
    h.accountId = "acct-22";
    vi.stubGlobal("fetch", mockConfigFetch({ auto_reply_enabled: false }));

    render(
      <AiThreadBanner
        conversationId="conv-1"
        disabled={true}
        handoffSummary="🤖 AI agent handed off after 2 replies. Last customer message: “refund please”"
      />,
    );

    expect(await screen.findByText("Needs human attention")).toBeInTheDocument();
    expect(screen.getByText(/refund please/)).toBeInTheDocument();
  });

  it("renders the handoff banner even when a human agent is already assigned", async () => {
    h.accountId = "acct-23";
    vi.stubGlobal("fetch", mockConfigFetch({}));

    render(
      <AiThreadBanner
        conversationId="conv-1"
        disabled={true}
        handoffSummary="🤖 AI agent handed off without replying."
        assignedAgentId="agent-9"
      />,
    );

    expect(await screen.findByText("Needs human attention")).toBeInTheDocument();
  });

  it("does not render the handoff banner for a disabled thread with an empty/whitespace-only summary", async () => {
    h.accountId = "acct-empty-summary";
    vi.stubGlobal("fetch", mockConfigFetch({}));

    render(<AiThreadBanner conversationId="conv-1" disabled={true} handoffSummary="   " />);

    // autoReplyOn resolves true, disabled=true, but no real summary →
    // falls through to the plain "paused" banner instead of the handoff one.
    expect(await screen.findByText("AI assistant is paused here")).toBeInTheDocument();
    expect(screen.queryByText("Needs human attention")).not.toBeInTheDocument();
  });
});

describe("AiThreadBanner — everything else keeps working (test #24, #25, #26)", () => {
  it("a plain manual pause (disabled=true, no summary) renders the normal muted paused state", async () => {
    h.accountId = "acct-24";
    vi.stubGlobal("fetch", mockConfigFetch({}));

    render(<AiThreadBanner conversationId="conv-1" disabled={true} handoffSummary={null} />);

    expect(await screen.findByText("AI assistant is paused here")).toBeInTheDocument();
    expect(screen.queryByText("Needs human attention")).not.toBeInTheDocument();
  });

  it("the active-AI banner is unchanged when nothing is paused and no one is assigned", async () => {
    h.accountId = "acct-25";
    vi.stubGlobal("fetch", mockConfigFetch({}));

    render(<AiThreadBanner conversationId="conv-1" disabled={false} handoffSummary={null} />);

    expect(await screen.findByText("AI assistant is replying automatically")).toBeInTheDocument();
    expect(screen.getByText("Take over")).toBeInTheDocument();
  });

  it('"Resume AI" on a handoff banner still POSTs { paused: false } and flips the banner away, unchanged', async () => {
    h.accountId = "acct-26";
    const fetchMock = mockConfigFetch({});
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AiThreadBanner
        conversationId="conv-1"
        disabled={true}
        handoffSummary="🤖 AI agent handed off after 3 replies."
      />,
    );

    const resumeBtn = await screen.findByText("Resume AI");
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0].includes("/api/ai/autoreply/"),
      );
      expect(postCall).toBeDefined();
      const init = postCall![1] as RequestInit;
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toMatchObject({ paused: false });
    });

    // Optimistic local flip — the handoff banner disappears immediately.
    await waitFor(() => {
      expect(screen.queryByText("Needs human attention")).not.toBeInTheDocument();
    });
  });
});
