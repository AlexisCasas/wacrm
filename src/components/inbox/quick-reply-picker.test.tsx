// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { QuickReply } from "@/types";
import { QuickReplyPicker, filterQuickReplies } from "./quick-reply-picker";

const messages: Record<string, string> = {
  quickReplies: "Respuestas rápidas",
  quickRepliesEmpty: "Aún no hay respuestas rápidas.",
  quickRepliesSearchPlaceholder: "Buscar por título o contenido...",
  quickRepliesNoMatches: "Ninguna coincide.",
  quickRepliesClearSearch: "Limpiar búsqueda",
};
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
}));

function qr(id: string, title: string, content_text: string): QuickReply {
  return {
    id,
    title,
    kind: "text",
    content_text,
    interactive_payload: null,
  } as unknown as QuickReply;
}

const items = [
  qr("1", "Horario de atención", "Atendemos de lunes a viernes"),
  qr("2", "Dirección", "Estamos en la Avenida Principal"),
  qr("3", "Precios", "Consulta nuestro catálogo de HORARIO extendido"),
];

const ids = (list: QuickReply[]) => list.map((q) => q.id);

describe("filterQuickReplies", () => {
  it("returns everything for an empty or blank query", () => {
    expect(filterQuickReplies(items, "")).toBe(items);
    expect(ids(filterQuickReplies(items, "   "))).toEqual(["1", "2", "3"]);
  });

  it("matches by title and by content, keeping original order", () => {
    expect(ids(filterQuickReplies(items, "horario"))).toEqual(["1", "3"]);
    expect(ids(filterQuickReplies(items, "avenida"))).toEqual(["2"]);
  });

  it("ignores case, accents and extra whitespace", () => {
    expect(ids(filterQuickReplies(items, "  DIRECCION "))).toEqual(["2"]);
    expect(ids(filterQuickReplies(items, "atención"))).toEqual(["1"]);
    expect(ids(filterQuickReplies(items, "lunes   a  viernes"))).toEqual(["1"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterQuickReplies(items, "zzz")).toEqual([]);
  });
});

describe("QuickReplyPicker", () => {
  const onPick = vi.fn();

  beforeEach(() => {
    onPick.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ quick_replies: items }),
      })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderPicker = (open = true) =>
    render(<QuickReplyPicker open={open} onOpenChange={() => {}} onPick={onPick} />);
  const search = () => screen.getByPlaceholderText("Buscar por título o contenido...");

  it("focuses the search, filters live and picks the filtered reply", async () => {
    renderPicker();
    await screen.findByText("Precios");
    expect(document.activeElement).toBe(search());
    fireEvent.change(search(), { target: { value: "DIRECCION" } });
    expect(screen.queryByText("Precios")).toBeNull();
    fireEvent.click(screen.getByText("Dirección"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].id).toBe("2");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state and clears the query", async () => {
    renderPicker();
    await screen.findByText("Precios");
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(screen.getByText("Ninguna coincide.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Limpiar búsqueda"));
    expect((search() as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Precios")).toBeTruthy();
  });

  it("navigates with arrows and picks with Enter", async () => {
    renderPicker();
    await screen.findByText("Precios");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onPick.mock.calls[0][0].id).toBe("2");
  });

  it("resets the query when closed and reopened", async () => {
    const { rerender } = renderPicker();
    await screen.findByText("Precios");
    fireEvent.change(search(), { target: { value: "dir" } });
    rerender(<QuickReplyPicker open={false} onOpenChange={() => {}} onPick={onPick} />);
    rerender(<QuickReplyPicker open onOpenChange={() => {}} onPick={onPick} />);
    await waitFor(() => expect((search() as HTMLInputElement).value).toBe(""));
    expect(await screen.findByText("Precios")).toBeTruthy();
  });
});
