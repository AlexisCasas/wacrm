// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildReplyPreview, ReplyQuote } from "./reply-quote";
import type { Message } from "@/types";

let mediaState: { src: string | null; status: "idle" | "loading" | "ready" | "error" } = {
  src: "https://cdn.test/thumbnail.jpg",
  status: "ready",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-media-blob-url", () => ({
  useMediaBlobUrl: () => mediaState,
}));

const imageQuote = {
  id: "parent-image",
  authorLabel: "You",
  preview: "Promo S/299",
  contentType: "image" as const,
  mediaUrl: "https://cdn.test/thumbnail.jpg",
};

function message(overrides: Partial<Message>): Message {
  return {
    id: "message",
    conversation_id: "conversation",
    sender_type: "customer",
    content_type: "text",
    status: "sent",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  mediaState = { src: "https://cdn.test/thumbnail.jpg", status: "ready" };
  cleanup();
});

describe("ReplyQuote image parent", () => {
  it("keeps a text reply unchanged", () => {
    render(<ReplyQuote id="parent-text" authorLabel="Ada" preview="Plain text" contentType="text" />);

    expect(screen.getByText("Plain text")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders a compact thumbnail beside an image caption and opens the existing viewer", () => {
    const onOpenMedia = vi.fn();
    render(<ReplyQuote {...imageQuote} onOpenMedia={onOpenMedia} />);

    const image = document.querySelector("img") as HTMLImageElement;
    expect(image.src).toBe("https://cdn.test/thumbnail.jpg");
    expect(image.className).toContain("h-10");
    expect(image.className).toContain("shrink-0");
    expect(screen.getByText("Promo S/299")).toBeInTheDocument();
    fireEvent.click(image);
    expect(onOpenMedia).toHaveBeenCalledWith("parent-image");
  });

  it("keeps the localized Photo fallback for an image without a caption", () => {
    const parent = message({ content_type: "image", media_url: "https://cdn.test/photo.jpg" });
    render(<ReplyQuote {...imageQuote} preview={buildReplyPreview(parent, ((key: string) => key) as never)} />);

    expect(screen.getByText("photo")).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeNull();
  });

  it("falls back to usable text when image media is absent or fails", () => {
    const { rerender } = render(<ReplyQuote {...imageQuote} mediaUrl={undefined} preview="photo" />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("photo")).toBeInTheDocument();

    rerender(<ReplyQuote {...imageQuote} />);
    fireEvent.error(document.querySelector("img")!);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Promo S/299")).toBeInTheDocument();
  });

  it("uses a discrete loading placeholder and leaves other media textual", () => {
    mediaState = { src: null, status: "loading" };
    const { rerender } = render(<ReplyQuote {...imageQuote} />);
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.getByText("Promo S/299")).toBeInTheDocument();

    rerender(<ReplyQuote {...imageQuote} contentType="video" />);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("preserves wrapping protections for long captions", () => {
    const { container } = render(<ReplyQuote {...imageQuote} preview={"https://example.test/".repeat(20)} />);
    expect(container.querySelector(".min-w-0 .whitespace-pre-wrap.break-words")).not.toBeNull();
  });
});
