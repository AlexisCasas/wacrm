// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { WhatsAppConfig } from "./whatsapp-config";

// ---------------------------------------------------------------------------
// feat/per-account-meta-app-secret (+ Hallazgo 2 fix)
//
// Two things this file proves:
//   1. "leaving App Secret blank preserves the existing value" — the
//      settings form never SENDS the field unless the user actually
//      typed something (server-side enforcement is covered exhaustively
//      in src/app/api/whatsapp/config/route.test.ts).
//   2. The direct Supabase read in fetchConfig never asks for
//      access_token / verify_token / app_secret — "configured" state
//      comes ONLY from the API's `app_secret_configured` boolean.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    t.raw = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    accountId: "acct-1",
    loading: false,
    profileLoading: false,
    canEditSettings: true,
  }),
}));

// Deliberately has NO access_token / verify_token / app_secret field at
// all — this is the exact shape the real narrowed `.select(...)` in
// fetchConfig would return. If the component ever tried to read one of
// those off this row, it would just get `undefined`, not a real value.
const EXISTING_ROW = {
  id: "cfg-1",
  phone_number_id: "pn-1",
  waba_id: "waba-1",
  status: "connected",
  registered_at: "2026-01-01T00:00:00.000Z",
  last_registration_error: null,
  mirror_inbound_media: true,
};

let lastSelectColumns: string | null = null;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: (columns: string) => {
        lastSelectColumns = columns;
        return {
          eq: () => ({
            maybeSingle: async () => ({ data: EXISTING_ROW, error: null }),
          }),
        };
      },
    }),
  }),
}));

let lastPostBody: Record<string, unknown> | null = null;
/** What GET /api/whatsapp/config/verify-registration returns — set per test. */
let verifyResponse: Record<string, unknown> = { live: true, registration_source: "wacrm", checks: {}, errors: [] };
/** What the GET /api/whatsapp/config health-check mock returns — set per test. */
let getResponse: Record<string, unknown> = { connected: true, phone_info: {}, app_secret_configured: true };

beforeEach(() => {
  lastPostBody = null;
  lastSelectColumns = null;
  getResponse = { connected: true, phone_info: {}, app_secret_configured: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/whatsapp/config" && init?.method === "POST") {
        lastPostBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({ success: true, saved: true, registered: true, phone_info: {} }),
        };
      }
      if (url === "/api/whatsapp/config/verify-registration") {
        return { ok: true, json: async () => verifyResponse };
      }
      if (url === "/api/whatsapp/config" && (!init || init.method === "GET")) {
        return { ok: true, json: async () => getResponse };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WhatsAppConfig — direct Supabase read never selects sensitive columns", () => {
  it("the fetchConfig select() column list excludes access_token, verify_token, and app_secret", async () => {
    render(<WhatsAppConfig />);
    await waitFor(() => expect(lastSelectColumns).not.toBeNull());
    expect(lastSelectColumns).not.toMatch(/\*/);
    expect(lastSelectColumns).not.toMatch(/access_token/);
    expect(lastSelectColumns).not.toMatch(/verify_token/);
    expect(lastSelectColumns).not.toMatch(/app_secret/);
  });

  it("loading Settings does not require app_secret ciphertext from the DB row at all", async () => {
    // EXISTING_ROW has no app_secret field whatsoever — if the component
    // crashed or mis-rendered without it, this would fail.
    render(<WhatsAppConfig />);
    await waitFor(() => {
      expect(screen.getByText("appSecretConfigured")).toBeInTheDocument();
    });
  });
});

describe("WhatsAppConfig — App Secret 'configured' state comes from the API boolean", () => {
  it("shows the 'configured' hint when GET reports app_secret_configured=true", async () => {
    getResponse = { connected: true, phone_info: {}, app_secret_configured: true };
    render(<WhatsAppConfig />);
    await waitFor(() => {
      expect(screen.getByText("appSecretConfigured")).toBeInTheDocument();
    });
    // The field itself starts empty — never pre-filled with the
    // ciphertext or any placeholder standing in for the real value.
    const input = screen.getByPlaceholderText("appSecretPlaceholder") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
  });

  it("shows the 'not configured' hint when GET reports app_secret_configured=false", async () => {
    getResponse = { connected: true, phone_info: {}, app_secret_configured: false };
    render(<WhatsAppConfig />);
    await waitFor(() => {
      expect(screen.getByText("appSecretNotConfigured")).toBeInTheDocument();
    });
  });
});

describe("WhatsAppConfig — App Secret field never round-trips the real value", () => {
  it("leaving the field blank does not send app_secret on save", async () => {
    render(<WhatsAppConfig />);
    await waitFor(() => screen.getByText("appSecretConfigured"));

    // Saving an EXISTING config requires re-entering the access token
    // (the form's own pre-existing rule, unrelated to app_secret) — do
    // that first so the save actually reaches fetch().
    fireEvent.change(screen.getByPlaceholderText("accessTokenPlaceholder"), {
      target: { value: "fresh-access-token" },
    });
    fireEvent.click(screen.getByText("saveConfig"));

    await waitFor(() => expect(lastPostBody).not.toBeNull());
    expect(lastPostBody).not.toHaveProperty("app_secret");
  });

  it("typing a new value sends it as plaintext over the request body (server encrypts it)", async () => {
    render(<WhatsAppConfig />);
    await waitFor(() => screen.getByText("appSecretConfigured"));

    fireEvent.change(screen.getByPlaceholderText("accessTokenPlaceholder"), {
      target: { value: "fresh-access-token" },
    });
    const input = screen.getByPlaceholderText("appSecretPlaceholder");
    fireEvent.change(input, { target: { value: "brand-new-secret" } });
    fireEvent.click(screen.getByText("saveConfig"));

    await waitFor(() => expect(lastPostBody).not.toBeNull());
    expect(lastPostBody?.app_secret).toBe("brand-new-secret");
  });
});

// ---------------------------------------------------------------------------
// prepare_only: valid credentials are NOT the same as receiving enabled. The Connection Status banner must say so, while accounts that already
// receive (or that talk to an older API that does not send the field) keep the banner they always had.
// ---------------------------------------------------------------------------
describe("WhatsAppConfig — credentials valid vs receiving enabled", () => {
  it("receiving_enabled=false: says credentials are valid but receiving is NOT enabled (never the plain 'valid' banner)", async () => {
    getResponse = { connected: true, receiving_enabled: false, phone_info: {}, app_secret_configured: true };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("credentialsValidNotReceiving")).toBeInTheDocument());
    expect(screen.getByText("notReceivingDesc")).toBeInTheDocument();
    expect(screen.queryByText("credentialsValid")).not.toBeInTheDocument();
    expect(screen.queryByText("connectedDesc")).not.toBeInTheDocument();
  });

  it("receiving_enabled=true: the banner of an operating account is unchanged", async () => {
    getResponse = { connected: true, receiving_enabled: true, phone_info: {}, app_secret_configured: true };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("credentialsValid")).toBeInTheDocument());
    expect(screen.getByText("connectedDesc")).toBeInTheDocument();
    expect(screen.queryByText("credentialsValidNotReceiving")).not.toBeInTheDocument();
  });

  it("the field absent (older API, or an account saved before this change): treated as receiving, banner unchanged", async () => {
    getResponse = { connected: true, phone_info: {}, app_secret_configured: true };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("credentialsValid")).toBeInTheDocument());
    expect(screen.queryByText("credentialsValidNotReceiving")).not.toBeInTheDocument();
  });

  it("not connected at all: still 'notConnected' whatever receiving_enabled says", async () => {
    getResponse = { connected: false, reason: "meta_api_error", message: "x", receiving_enabled: false };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("notConnected")).toBeInTheDocument());
    expect(screen.queryByText("credentialsValidNotReceiving")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Registration is three different facts. WACRM-registered numbers (registered_at set: Lorteg, Alexis Test) keep their banner; a number that was
// registered in Meta BEFORE WACRM (registered_at stays NULL, never invented) is shown as such once Meta confirms it; everything else keeps
// the old "not registered" state.
// ---------------------------------------------------------------------------
describe("WhatsAppConfig — registration: WACRM vs prior in Meta", () => {
  const BASE_ROW = { ...EXISTING_ROW };
  afterEach(() => {
    Object.keys(EXISTING_ROW).forEach((k) => delete (EXISTING_ROW as Record<string, unknown>)[k]);
    Object.assign(EXISTING_ROW, BASE_ROW);
    verifyResponse = { live: true, registration_source: "wacrm", checks: {}, errors: [] };
  });
  const asPriorRegistered = (over: Record<string, unknown> = {}) =>
    Object.assign(EXISTING_ROW, { registered_at: null, status: "connected", subscribed_apps_at: "2026-11-01T19:30:00.000Z", ...over });

  it("registered by WACRM (registered_at set): unchanged — 'registered' with its real date", async () => {
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("registered")).toBeInTheDocument());
    expect(screen.queryByText("registeredPriorInMeta")).not.toBeInTheDocument();
    expect(screen.queryByText("registrationUnverified")).not.toBeInTheDocument();
  });

  it("activated + subscribed but no local registration, not verified yet: says so instead of 'Meta will not deliver events'", async () => {
    asPriorRegistered();
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("registrationUnverified")).toBeInTheDocument());
    expect(screen.getByText("unverifiedDesc")).toBeInTheDocument();
    expect(screen.queryByText("notRegistered")).not.toBeInTheDocument();
    expect(screen.queryByText("registered")).not.toBeInTheDocument();
  });

  it("after 'Verify with Meta' confirms a prior registration: 'registered in Meta beforehand', and NO invented date", async () => {
    asPriorRegistered();
    verifyResponse = { live: true, registration_source: "meta_prior", checks: { meta_confirms_connected: true, locally_marked_registered: false }, errors: [], registered_at: null };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("registrationUnverified")).toBeInTheDocument());
    fireEvent.click(screen.getByText("verifyWithMeta"));
    await waitFor(() => expect(screen.getByText("registeredPriorInMeta")).toBeInTheDocument());
    expect(screen.getByText("priorInMetaDesc")).toBeInTheDocument();
    expect(screen.queryByText("subscribedSince")).not.toBeInTheDocument();
    expect(screen.queryByText("notRegistered")).not.toBeInTheDocument();
  });

  it("if Meta does NOT confirm (not live), the old 'not registered' state is shown", async () => {
    asPriorRegistered();
    verifyResponse = { live: false, registration_source: "none", checks: { meta_confirms_connected: false }, errors: ["x"] };
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("registrationUnverified")).toBeInTheDocument());
    fireEvent.click(screen.getByText("verifyWithMeta"));
    await waitFor(() => expect(screen.getByText("notRegistered")).toBeInTheDocument());
    expect(screen.queryByText("registeredPriorInMeta")).not.toBeInTheDocument();
  });

  it("not activated (disconnected / prepared): unchanged 'not registered'", async () => {
    asPriorRegistered({ status: "disconnected", subscribed_apps_at: null });
    render(<WhatsAppConfig />);
    await waitFor(() => expect(screen.getByText("notRegistered")).toBeInTheDocument());
    expect(screen.queryByText("registrationUnverified")).not.toBeInTheDocument();
  });
});
