import { describe, expect, it } from "vitest";

import {
  buildVoiceNoteObjectPath,
  isSafeStagingPath,
  isVoiceNoteUrlForAccount,
  parseVoiceNoteUrl,
  stagedObjectTimestamp,
} from "./voice-note-path";

const ACCOUNT = "046ff8c2-1111-4222-8333-444455556666";
const OTHER = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const SHA = "a".repeat(64);
const ORIGIN = "https://supabase.example.test";
const url = (account = ACCOUNT, sha = SHA) =>
  `${ORIGIN}/storage/v1/object/public/voice-notes/account-${account}/${sha}.ogg`;

describe("buildVoiceNoteObjectPath", () => {
  it("is content-addressed and account-scoped", () => {
    expect(buildVoiceNoteObjectPath(ACCOUNT.toUpperCase(), SHA)).toBe(`account-${ACCOUNT}/${SHA}.ogg`);
  });
  it("refuses malformed ids and hashes", () => {
    expect(() => buildVoiceNoteObjectPath("not-a-uuid", SHA)).toThrow();
    expect(() => buildVoiceNoteObjectPath(ACCOUNT, "short")).toThrow();
    expect(() => buildVoiceNoteObjectPath(ACCOUNT, "A".repeat(64))).toThrow();
  });
});

describe("isSafeStagingPath", () => {
  const STAGE = `account-${ACCOUNT}/voice-staging`;
  it("accepts a file in the caller's own account staging folder", () => {
    expect(isSafeStagingPath(ACCOUNT, `${STAGE}/1700000000000-guia_1.ogg`)).toBe(true);
    expect(isSafeStagingPath(ACCOUNT, `${STAGE}/x.OGG`)).toBe(true);
  });
  it("rejects the Inbox's own media and every other folder of the bucket", () => {
    expect(isSafeStagingPath(ACCOUNT, `account-${ACCOUNT}/1700000000000-memo.ogg`)).toBe(false);
    expect(isSafeStagingPath(ACCOUNT, `account-${ACCOUNT}/other/1700000000000-memo.ogg`)).toBe(false);
    expect(isSafeStagingPath(ACCOUNT, `${STAGE}/deeper/x.ogg`)).toBe(false);
  });
  it("rejects another account's folder and anything outside an account folder", () => {
    expect(isSafeStagingPath(ACCOUNT, `account-${OTHER}/voice-staging/x.ogg`)).toBe(false);
    expect(isSafeStagingPath(ACCOUNT, `x.ogg`)).toBe(false);
    expect(isSafeStagingPath(ACCOUNT, `/${STAGE}/x.ogg`)).toBe(false);
  });
  it("rejects traversal, encoding tricks and odd characters", () => {
    for (const bad of [
      `account-${ACCOUNT}/../account-${OTHER}/voice-staging/x.ogg`,
      `${STAGE}/../x.ogg`,
      `${STAGE}/./x.ogg`,
      `${STAGE}//x.ogg`,
      `${STAGE}/%2e%2e/x.ogg`,
      `${STAGE}/a\\b.ogg`,
      `${STAGE}/a\u0000.ogg`,
      `${STAGE}/a b.ogg`,
      `${STAGE}/x.mp3`,
      `${STAGE}/${"a".repeat(200)}.ogg`,
    ]) {
      expect(isSafeStagingPath(ACCOUNT, bad)).toBe(false);
    }
    expect(isSafeStagingPath(ACCOUNT, undefined)).toBe(false);
    expect(isSafeStagingPath(ACCOUNT, 42)).toBe(false);
  });
});

describe("stagedObjectTimestamp (what a cleanup may recognise)", () => {
  const STAGE = `account-${ACCOUNT}/voice-staging`;
  it("recognises exactly the editor's naming and returns when it was staged", () => {
    expect(stagedObjectTimestamp(`${STAGE}/1700000000123-guia_1.ogg`)).toEqual({ accountId: ACCOUNT, stagedAtMs: 1700000000123 });
  });
  it.each([
    ["an Inbox voice note in the account folder", `account-${ACCOUNT}/1700000000123-memo.ogg`],
    ["the same name in another folder", `account-${ACCOUNT}/voice/1700000000123-guia.ogg`],
    ["a promoted voice note", `account-${ACCOUNT}/${"a".repeat(64)}.ogg`],
    ["a name without the editor's timestamp", `${STAGE}/guia.ogg`],
    ["a short timestamp", `${STAGE}/17000-guia.ogg`],
    ["another extension", `${STAGE}/1700000000123-guia.mp3`],
    ["a nested path", `${STAGE}/x/1700000000123-guia.ogg`],
    ["traversal", `${STAGE}/../1700000000123-guia.ogg`],
    ["a malformed account folder", `account-nope/voice-staging/1700000000123-guia.ogg`],
    ["a non-string", 12],
  ])("does NOT recognise %s", (_name, path) => {
    expect(stagedObjectTimestamp(path)).toBeNull();
  });
});

describe("voice note URLs", () => {
  it("parses the canonical public URL", () => {
    expect(parseVoiceNoteUrl(url())).toEqual({ accountId: ACCOUNT, sha256: SHA, origin: ORIGIN });
  });
  it("accepts only the owner account, the recorded hash and the pinned origin", () => {
    expect(isVoiceNoteUrlForAccount(url(), ACCOUNT, { origin: ORIGIN, sha256: SHA })).toBe(true);
    expect(isVoiceNoteUrlForAccount(url(OTHER), ACCOUNT, { origin: ORIGIN })).toBe(false);
    expect(isVoiceNoteUrlForAccount(url(), ACCOUNT, { origin: ORIGIN, sha256: "b".repeat(64) })).toBe(false);
    expect(isVoiceNoteUrlForAccount(url(), ACCOUNT, { origin: "https://evil.example" })).toBe(false);
    expect(isVoiceNoteUrlForAccount(url(), "not-a-uuid", { origin: null })).toBe(false);
  });
  it("rejects other buckets, extensions, queries, credentials and non-http schemes", () => {
    const base = `${ORIGIN}/storage/v1/object/public`;
    for (const bad of [
      `${base}/flow-media/account-${ACCOUNT}/${SHA}.ogg`,
      `${base}/chat-media/account-${ACCOUNT}/${SHA}.ogg`,
      `${base}/voice-notes/account-${ACCOUNT}/${SHA}.mp3`,
      `${base}/voice-notes/account-${ACCOUNT}/${SHA}.ogg?download=1`,
      `${base}/voice-notes/account-${ACCOUNT}/${SHA}.ogg#x`,
      `${base}/voice-notes/account-${ACCOUNT}/sub/${SHA}.ogg`,
      `${base}/voice-notes/account-${ACCOUNT}/${"g".repeat(64)}.ogg`,
      `https://user:pw@supabase.example.test/storage/v1/object/public/voice-notes/account-${ACCOUNT}/${SHA}.ogg`,
      `ftp://supabase.example.test/storage/v1/object/public/voice-notes/account-${ACCOUNT}/${SHA}.ogg`,
      "javascript:alert(1)",
      "",
    ]) {
      expect(parseVoiceNoteUrl(bad)).toBeNull();
    }
    expect(parseVoiceNoteUrl(undefined)).toBeNull();
  });
});
