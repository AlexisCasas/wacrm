// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    t.raw = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) } }));

const state = vi.hoisted(() => ({ accountRole: "owner" as string | null, enabled: true as boolean | null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountRole: state.accountRole, accountId: "acct-1" }) }));
vi.mock("@/hooks/use-audio-guide-enabled", () => ({ useAudioGuideEnabled: () => state.enabled }));
vi.mock("@/lib/audio-guide/stage-client", () => ({ stageVoiceNote: vi.fn() }));

import { AudioGuideAdmin } from "./audio-guide-admin";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

beforeEach(() => {
  state.accountRole = "owner";
  state.enabled = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(reply(200, { products: [] }));
  toastError.mockReset();
  toastSuccess.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/audio-guide: who sees what", () => {
  it.each(["owner", "admin"])("%s of an enabled account can create products and sees no read-only notice", async (role) => {
    state.accountRole = role;
    render(<AudioGuideAdmin />);
    await waitFor(() => expect(screen.getByTestId("new-product")).toBeTruthy());
    expect(screen.queryByTestId("read-only-notice")).toBeNull();
  });

  it.each(["agent", "viewer"])("%s can look but not change: read-only notice, no create button", async (role) => {
    state.accountRole = role;
    render(<AudioGuideAdmin />);
    await waitFor(() => expect(screen.getByTestId("read-only-notice")).toBeTruthy());
    expect(screen.queryByTestId("new-product")).toBeNull();
  });

  it("does not claim 'read only' while the role is still loading", () => {
    state.accountRole = null;
    render(<AudioGuideAdmin />);
    expect(screen.queryByTestId("read-only-notice")).toBeNull();
  });

  it("direct access to /audio-guide with the module off shows the disabled panel and never calls the catalog API", async () => {
    state.enabled = false;
    render(<AudioGuideAdmin />);
    expect(screen.getByTestId("audio-guide-disabled")).toBeTruthy();
    expect(screen.queryByTestId("new-product")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("while the module state is unknown it only shows the loading state and asks nothing", async () => {
    state.enabled = null;
    render(<AudioGuideAdmin />);
    expect(screen.queryByTestId("audio-guide")).toBeNull();
    expect(screen.queryByTestId("audio-guide-disabled")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/audio-guide: the three refusals read differently", () => {
  const listFails = async (status: number, body: unknown) => {
    fetchMock.mockResolvedValue(reply(status, body));
    render(<AudioGuideAdmin />);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    return toastError.mock.calls[0][0];
  };

  it("403 voice_notes_disabled -> module not enabled (not a permissions message, even for an owner)", async () => {
    expect(await listFails(403, { error: "voice_notes_disabled" })).toBe("errorModuleDisabled");
  });

  it("403 for lack of role -> permission message", async () => {
    expect(await listFails(403, { error: "Forbidden" })).toBe("errorForbidden");
  });

  it("401 -> session message", async () => {
    expect(await listFails(401, { error: "Unauthorized" })).toBe("errorUnauthenticated");
  });

  it("anything else keeps the generic message", async () => {
    expect(await listFails(500, { error: "internal_error" })).toBe("errorGeneric");
  });
});
