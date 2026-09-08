// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { MessageComposer } from "./message-composer";

// ---------------------------------------------------------------------------
// P0.1 — OGG voice notes uploaded from disk, plus the existing recorder,
// both end up on the exact same send path with voiceNote=true. Also covers
// the Document picker's auto-redirect for a manually-picked .ogg.
//
// The byte-level OGG/Opus signature check itself is covered exhaustively in
// src/lib/media/ogg-opus.test.ts, which runs in the default "node" test
// environment where File/Blob.arrayBuffer() are the real Node implementation.
// jsdom's Blob polyfill (needed here for rendering) doesn't reliably support
// that API, so `looksLikeOpusOgg` is mocked below (controllable per test) —
// `hasOggExtension` and `normalizeOggFile` stay real, since neither touches
// Blob internals. This file is about the composer's WIRING: which picker
// produces which draft, and what reaches onSendMedia.
// ---------------------------------------------------------------------------

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
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));

vi.mock("@/hooks/use-can", () => ({
  useCan: () => true,
}));

let uploadCalls: Array<{ bucket: string; file: File }> = [];
vi.mock("@/lib/storage/upload-media", () => ({
  uploadAccountMedia: vi.fn(async (bucket: string, file: File) => {
    uploadCalls.push({ bucket, file });
    return { publicUrl: `https://cdn.test/${file.name}`, path: `acct-1/${file.name}` };
  }),
  deleteAccountMedia: vi.fn(async () => {}),
  MEDIA_MAX_BYTES_BY_KIND: {
    image: 5 * 1024 * 1024,
    video: 16 * 1024 * 1024,
    audio: 16 * 1024 * 1024,
    document: 16 * 1024 * 1024,
  },
}));

// Controllable per test — see the file-level comment above for why this is
// mocked rather than left real under jsdom.
let mockIsOpus = true;
vi.mock("@/lib/media/ogg-opus", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    looksLikeOpusOgg: vi.fn(async () => mockIsOpus),
  };
});

// Captures the last constructed fake Recorder so a test can simulate
// opus-recorder finishing a take via `.ondataavailable(bytes)`.
let lastRecorder: {
  ondataavailable: ((bytes: Uint8Array) => void) | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} | null = null;
vi.mock("opus-recorder", () => ({
  default: class FakeRecorder {
    ondataavailable: ((bytes: Uint8Array) => void) | null = null;
    constructor() {
      lastRecorder = this;
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  },
}));

function renderComposer(onSendMedia = vi.fn()) {
  render(
    <MessageComposer
      conversationId="conv-1"
      sessionExpired={false}
      onSend={vi.fn()}
      onSendMedia={onSendMedia}
      onSendInteractive={vi.fn()}
      onOpenTemplates={vi.fn()}
    />,
  );
  return onSendMedia;
}

function oggFile(name: string, type = "audio/ogg"): File {
  return new File(["fake-ogg-bytes"], name, { type });
}

async function openAttachMenu() {
  fireEvent.click(screen.getByTitle("attachMedia"));
}

function voiceNoteInput(): HTMLInputElement {
  return document.querySelector('input[type="file"][accept*="ogg"]') as HTMLInputElement;
}

function documentInput(): HTMLInputElement {
  // Only the document picker's accept list mentions PDF — image/video/
  // voice-note accepts don't, so this is an unambiguous match.
  return Array.from(document.querySelectorAll('input[type="file"]')).find((i) =>
    (i as HTMLInputElement).accept.includes("pdf"),
  ) as HTMLInputElement;
}

/**
 * The draft preview's Send button. Once a draft is staged, the whole
 * attach-menu / textarea row unmounts (see MessageComposer's render
 * ternary), so MediaDraftPreview's two buttons — "removeAttachment"
 * (has its own aria-label) and Send (icon-only) — are the only ones
 * left in the tree.
 */
function findSendButton(): HTMLElement {
  const send = screen
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-label") !== "removeAttachment");
  if (!send) throw new Error("Send button not found in draft preview");
  return send;
}

beforeEach(() => {
  uploadCalls = [];
  lastRecorder = null;
  mockIsOpus = true;
  toastError.mockClear();
  toastSuccess.mockClear();
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => ({})) },
    configurable: true,
  });
  // jsdom has no AudioContext — the recorder gate only checks it exists.
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = class {};
});

afterEach(() => {
  cleanup();
});

describe("MessageComposer — attach menu separates upload vs. record voice note", () => {
  it("shows both 'Upload voice note' and 'Record voice note' as distinct entries", async () => {
    renderComposer();
    await openAttachMenu();
    expect(screen.getByText("uploadVoiceNote")).toBeInTheDocument();
    expect(screen.getByText("recordVoiceNote")).toBeInTheDocument();
  });
});

describe("MessageComposer — Upload voice note", () => {
  it("a valid OGG/Opus file is staged as an audio draft, never a document", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), { target: { files: [oggFile("memo.ogg")] } });

    // Draft preview renders an <audio> control, never the document block.
    await waitFor(() => expect(document.querySelector("audio")).toBeInTheDocument());
    expect(screen.queryByText("memo.ogg")).toBeInTheDocument(); // optional filename display
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].file.type).toBe("audio/ogg");
  });

  it("rejects a .ogg file that is not actually Opus, with the exact i18n error, and never uploads it", async () => {
    mockIsOpus = false;
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), { target: { files: [oggFile("not-opus.ogg")] } });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("voiceNoteInvalidFormat"));
    expect(uploadCalls).toHaveLength(0);
    expect(document.querySelector("audio")).not.toBeInTheDocument();
  });

  it("rejects a file whose name doesn't end in .ogg, without reading its bytes", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), {
      target: { files: [new File(["whatever"], "memo.mp3", { type: "audio/mpeg" })] },
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("voiceNoteInvalidFormat"));
    expect(uploadCalls).toHaveLength(0);
  });

  it("normalizes an empty-type OGG to audio/ogg before upload", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), { target: { files: [oggFile("memo.ogg", "")] } });

    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(uploadCalls[0].file.type).toBe("audio/ogg");
  });

  // Regression guard: chat-media's bucket allow-list (migration 023)
  // does NOT include audio/opus — a browser reporting that MIME for a
  // valid OGG/Opus file used to reach uploadAccountMedia unnormalized
  // and get rejected by Storage. Every file that reaches upload for
  // this feature must carry exactly "audio/ogg", never the browser's
  // raw MIME string.
  it("normalizes audio/opus to audio/ogg before upload (bucket allow-list compatibility)", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), {
      target: { files: [oggFile("memo.ogg", "audio/opus")] },
    });

    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(uploadCalls[0].file.type).toBe("audio/ogg");
  });
});

describe("MessageComposer — Document picker auto-detects a picked .ogg", () => {
  it("a valid OGG/Opus picked via Document is redirected into the voice-note flow (never uploaded as a document)", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("document"));

    fireEvent.change(documentInput(), { target: { files: [oggFile("memo.ogg")] } });

    await waitFor(() => expect(document.querySelector("audio")).toBeInTheDocument());
    expect(uploadCalls).toHaveLength(1);
  });

  it("an invalid .ogg picked via Document is rejected, not uploaded as a document", async () => {
    mockIsOpus = false;
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("document"));

    fireEvent.change(documentInput(), { target: { files: [oggFile("not-opus.ogg")] } });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("voiceNoteInvalidFormat"));
    expect(uploadCalls).toHaveLength(0);
  });

  it("a real document (non-.ogg) still uploads as a document, unaffected", async () => {
    renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("document"));

    fireEvent.change(documentInput(), {
      target: { files: [new File(["%PDF-1.4"], "invoice.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(uploadCalls).toHaveLength(1));
    expect(screen.getByText("invoice.pdf")).toBeInTheDocument();
    expect(document.querySelector("audio")).not.toBeInTheDocument();
  });
});

describe("MessageComposer — sendDraft wires voiceNote through to onSendMedia", () => {
  it("an uploaded voice note sends with voiceNote=true", async () => {
    const onSendMedia = renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("uploadVoiceNote"));

    fireEvent.change(voiceNoteInput(), { target: { files: [oggFile("memo.ogg")] } });
    await waitFor(() => expect(document.querySelector("audio")).toBeInTheDocument());

    fireEvent.click(findSendButton());

    expect(onSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "audio", voiceNote: true }),
    );
  });

  it("a recorded voice note sends with voiceNote=true", async () => {
    const onSendMedia = renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("recordVoiceNote"));

    await waitFor(() => expect(lastRecorder).not.toBeNull());
    // Simulate opus-recorder finishing with a real (non-empty) take.
    lastRecorder!.ondataavailable?.(new Uint8Array([1, 2, 3]));

    await waitFor(() => expect(document.querySelector("audio")).toBeInTheDocument());

    fireEvent.click(findSendButton());

    expect(onSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "audio", voiceNote: true }),
    );
  });

  it("a normal image draft sends with voiceNote left unset (false)", async () => {
    const onSendMedia = renderComposer();
    await openAttachMenu();
    fireEvent.click(screen.getByText("photo"));

    const imageInput = Array.from(document.querySelectorAll('input[type="file"]')).find((i) =>
      (i as HTMLInputElement).accept.includes("image/png"),
    ) as HTMLInputElement;
    fireEvent.change(imageInput, {
      target: { files: [new File(["img"], "pic.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(document.querySelector("img")).toBeInTheDocument());

    fireEvent.click(findSendButton());

    expect(onSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", voiceNote: false }),
    );
  });
});
