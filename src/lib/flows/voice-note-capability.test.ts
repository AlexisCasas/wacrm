import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_NOTE_ACCOUNT_IDS_ENV, isVoiceNoteEnabledForAccount } from "./voice-note-capability";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

afterEach(() => vi.unstubAllEnvs());

describe("isVoiceNoteEnabledForAccount", () => {
  it("is off by default", () => {
    delete process.env[VOICE_NOTE_ACCOUNT_IDS_ENV];
    expect(isVoiceNoteEnabledForAccount(A)).toBe(false);
    vi.stubEnv(VOICE_NOTE_ACCOUNT_IDS_ENV, "");
    expect(isVoiceNoteEnabledForAccount(A)).toBe(false);
  });

  it("enables only the listed accounts", () => {
    vi.stubEnv(VOICE_NOTE_ACCOUNT_IDS_ENV, ` ${A} , garbage ,`);
    expect(isVoiceNoteEnabledForAccount(A)).toBe(true);
    expect(isVoiceNoteEnabledForAccount(A.toUpperCase())).toBe(true);
    expect(isVoiceNoteEnabledForAccount(B)).toBe(false);
  });

  it("never matches a malformed account id", () => {
    vi.stubEnv(VOICE_NOTE_ACCOUNT_IDS_ENV, A);
    for (const bad of ["", "*", "all", `${A}x`, undefined as unknown as string]) {
      expect(isVoiceNoteEnabledForAccount(bad)).toBe(false);
    }
  });

  it("is independent of the F04/F06 and scope flags", () => {
    vi.stubEnv("FLOW_AUTHORING_SCOPE", "all");
    vi.stubEnv("FLOW_EXECUTION_SCOPE", "all");
    vi.stubEnv("FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS", A);
    vi.stubEnv("FLOW_SUBFLOW_AUTHORING_ACCOUNT_IDS", A);
    delete process.env[VOICE_NOTE_ACCOUNT_IDS_ENV];
    expect(isVoiceNoteEnabledForAccount(A)).toBe(false);
  });
});

describe("isMediaAudioEnabledForAccount (Multimedia audio scope)", () => {
  it("keeps today's behavior unless FLOW_MEDIA_AUDIO_SCOPE=all", async () => {
    const { isMediaAudioEnabledForAccount } = await import("./voice-note-capability");
    delete process.env[VOICE_NOTE_ACCOUNT_IDS_ENV];
    delete process.env.FLOW_MEDIA_AUDIO_SCOPE;
    expect(isMediaAudioEnabledForAccount(A)).toBe(false);
    vi.stubEnv(VOICE_NOTE_ACCOUNT_IDS_ENV, A);
    expect(isMediaAudioEnabledForAccount(A)).toBe(true);
    expect(isMediaAudioEnabledForAccount(B)).toBe(false);
    for (const v of ["", "none", "true", "1"]) {
      vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", v);
      expect(isMediaAudioEnabledForAccount(B)).toBe(false);
    }
  });

  it("offers Multimedia audio to every valid account (current and future) when scope is all, and never widens the product module", async () => {
    const { isMediaAudioEnabledForAccount } = await import("./voice-note-capability");
    delete process.env[VOICE_NOTE_ACCOUNT_IDS_ENV];
    vi.stubEnv("FLOW_MEDIA_AUDIO_SCOPE", " ALL ");
    expect(isMediaAudioEnabledForAccount(A)).toBe(true);
    expect(isMediaAudioEnabledForAccount(B)).toBe(true);
    expect(isVoiceNoteEnabledForAccount(B)).toBe(false);
    for (const bad of ["", "*", "all", `${A}x`, undefined as unknown as string]) {
      expect(isMediaAudioEnabledForAccount(bad)).toBe(false);
    }
  });
});
