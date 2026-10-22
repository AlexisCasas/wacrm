// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
const toastWarning = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

const state = vi.hoisted(() => ({ accountRole: "owner" as string | null, enabled: true as boolean | null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountRole: state.accountRole, accountId: "acct-1" }) }));
vi.mock("@/hooks/use-audio-guide-enabled", () => ({ useAudioGuideEnabled: () => state.enabled }));
const stage = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/audio-guide/stage-client", () => ({ stageVoiceNote: (...a: unknown[]) => stage.fn(...a) }));

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
  toastWarning.mockReset();
  toastInfo.mockReset();
  stage.fn.mockReset();
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

describe("/audio-guide: adding an audio (E7)", () => {
  const detail = { id: "p1", product_key: "taladro", display_name: "Taladro Pro", active: true, revision: 3, items: [] as unknown[] };
  const summary = { ...detail, item_count: 0, active_item_count: 0 };
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let detailGets: number;
  let postAnswer: () => Response;

  beforeEach(() => {
    posts = [];
    detailGets = 0;
    postAnswer = () => reply(201, { product: { ...detail, revision: 4 } });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return postAnswer();
      }
      if (url.startsWith("/api/audio-guide/products/p1")) { detailGets++; return reply(200, { product: detail }); }
      if (url.startsWith("/api/audio-guide/products")) return reply(200, { products: [summary] });
      return reply(200, {});
    });
  });

  const openProductAndPick = async (file: File) => {
    render(<AudioGuideAdmin />);
    fireEvent.click(await screen.findByText("Taladro Pro"));
    const input = (await screen.findByTestId("audio-file-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  };
  const ogg = () => new File([new Uint8Array([1, 2, 3])], "aspiradora-portatil.ogg", { type: "audio/ogg" });

  it("a repaired file is added with the staged path and the person is told, with the detected length", async () => {
    stage.fn.mockResolvedValue({ ok: true, path: `account-acct-1/voice-staging/1700000000000-aspiradora-portatil.ogg`, fileName: "aspiradora-portatil.ogg", repaired: true, durationMs: 44240 });
    await openProductAndPick(ogg());
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith("audioRepaired"));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/audio-guide/products/p1/items");
    expect(posts[0].body).toMatchObject({ expected_revision: 3, path: "account-acct-1/voice-staging/1700000000000-aspiradora-portatil.ogg", label: "aspiradora-portatil" });
    expect(toastSuccess).toHaveBeenCalledWith("audioAdded");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("an untouched file is added without the repair notice", async () => {
    stage.fn.mockResolvedValue({ ok: true, path: "account-acct-1/voice-staging/1700000000000-a.ogg", fileName: "a.ogg", repaired: false, durationMs: 3000 });
    await openProductAndPick(ogg());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("audioAdded"));
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("a file that is really damaged is refused with a clear message, uploads nothing and calls no API", async () => {
    stage.fn.mockResolvedValue({ ok: false, problem: "corrupt" });
    await openProductAndPick(ogg());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("errorCorrupt"));
    expect(posts).toHaveLength(0);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("the same audio again (a retry that had in fact worked): informed, the sequence is reloaded, nothing is added and no repair notice is shown", async () => {
    stage.fn.mockResolvedValue({ ok: true, path: "account-acct-1/voice-staging/1700000000000-a.ogg", fileName: "a.ogg", repaired: true, durationMs: 3000 });
    postAnswer = () => reply(409, { error: "duplicate_audio" });
    await openProductAndPick(ogg());
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("errorDuplicateAudio"));
    await waitFor(() => expect(detailGets).toBeGreaterThanOrEqual(2)); // the initial load plus the reload
    expect(posts).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalledWith("audioAdded");
  });

  it("a stale revision still reloads and asks to repeat (unchanged behaviour)", async () => {
    stage.fn.mockResolvedValue({ ok: true, path: "account-acct-1/voice-staging/1700000000000-a.ogg", fileName: "a.ogg", repaired: false, durationMs: 3000 });
    postAnswer = () => reply(409, { error: "revision_conflict", revision: 9 });
    await openProductAndPick(ogg());
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("conflict"));
    expect(posts).toHaveLength(1);
  });
});
