// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const auth = vi.hoisted(() => ({ accountId: null as string | null }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: auth.accountId }) }));

import { resetVoiceNoteCapabilityCache, useAudioGuideEnabled, useVoiceNoteCapabilities } from "./use-audio-guide-enabled";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "c35b393f-9492-4321-80f2-987766c224d0";

const answer = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const fetchMock = vi.fn<(url: string) => Promise<Response>>();

beforeEach(() => {
  resetVoiceNoteCapabilityCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  auth.accountId = A;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useVoiceNoteCapabilities / useAudioGuideEnabled", () => {
  it("asks nothing and reports 'unknown' until the account is known", () => {
    auth.accountId = null;
    const { result } = renderHook(() => useAudioGuideEnabled());
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the specialised module follows product_audios, not enabled", async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: true, product_audios: false }));
    const { result } = renderHook(() => ({ module: useAudioGuideEnabled(), caps: useVoiceNoteCapabilities() }));
    await waitFor(() => expect(result.current.module).toBe(false));
    expect(result.current.caps).toEqual({ enabled: true, productAudios: false }); // Multimedia audio is still on
  });

  it("an enabled account (pilot, Keyler) gets the module", async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: true, product_audios: true }));
    const { result } = renderHook(() => useAudioGuideEnabled());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("fails closed: a reply without product_audios (the old shape), a refusal or a network error all mean 'no module'", async () => {
    for (const make of [() => answer(200, { enabled: true }), () => answer(401, { error: "Unauthorized" }), () => answer(500, {}), () => Promise.reject(new Error("offline"))]) {
      resetVoiceNoteCapabilityCache();
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => make());
      const { result, unmount } = renderHook(() => useAudioGuideEnabled());
      await waitFor(() => expect(result.current).toBe(false));
      unmount();
    }
  });

  it("a failure is not remembered: the next mount asks again and can see the module", async () => {
    fetchMock.mockResolvedValueOnce(answer(500, {}));
    const first = renderHook(() => useAudioGuideEnabled());
    await waitFor(() => expect(first.result.current).toBe(false));
    first.unmount();
    fetchMock.mockResolvedValueOnce(answer(200, { enabled: true, product_audios: true }));
    const second = renderHook(() => useAudioGuideEnabled());
    await waitFor(() => expect(second.result.current).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an enabled answer is remembered per account (one request for several components)", async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: true, product_audios: true }));
    const a = renderHook(() => useAudioGuideEnabled());
    const b = renderHook(() => useAudioGuideEnabled());
    await waitFor(() => expect(a.result.current).toBe(true));
    await waitFor(() => expect(b.result.current).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("switching account in the same session never shows or reuses the previous account's answer", async () => {
    fetchMock.mockImplementation(async () => answer(200, auth.accountId === A ? { enabled: true, product_audios: true } : { enabled: true, product_audios: false }));
    const { result, rerender } = renderHook(() => useAudioGuideEnabled());
    await waitFor(() => expect(result.current).toBe(true));

    auth.accountId = B;
    rerender();
    // Right after the switch the answer for A must not be shown for B: it is unknown until B's own answer arrives.
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    auth.accountId = A;
    rerender();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("the commercial account (Multimedia audio yes, module no) is told apart from a fully disabled one", async () => {
    fetchMock.mockResolvedValue(answer(200, { enabled: false, product_audios: false }));
    const { result } = renderHook(() => useVoiceNoteCapabilities());
    await waitFor(() => expect(result.current).toEqual({ enabled: false, productAudios: false }));
  });
});
