// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { NodeConfigForm } from "./node-config-form";
import type { BuilderNode } from "../shared";

// ---------------------------------------------------------------------------
// fix/flows-multiline-message-editor: send_message's text field must be a
// real multiline Textarea (rows=6), not the single-line Input TextRow
// defaults to. Newlines are never transformed — the runtime and the
// ManyChat wire payload already pass `config.text` through verbatim (see
// src/lib/manychat/api.test.ts for the payload-level proof); this file
// only covers the FORM.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  // Identity translator — assertions target the message KEY.
  useTranslations: () => (key: string) => key,
}));

function sendMessageNode(text: string): BuilderNode {
  return {
    node_key: "greet",
    node_type: "send_message",
    config: { text, next_node_key: "" },
  };
}

afterEach(() => {
  // vitest.config.ts doesn't set `test.globals: true`, so RTL's
  // automatic per-test cleanup never registers — do it explicitly.
  cleanup();
});

describe("NodeConfigForm — send_message uses a multiline Textarea (test A)", () => {
  it("renders a <textarea>, not a single-line <input>, for the message text", () => {
    render(
      <NodeConfigForm
        node={sendMessageNode("")}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={() => {}}
      />,
    );
    expect(screen.getByRole("textbox").tagName).toBe("TEXTAREA");
  });

  it("renders 6 visible rows", () => {
    render(
      <NodeConfigForm
        node={sendMessageNode("")}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={() => {}}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.rows).toBe(6);
  });
});

describe("NodeConfigForm — send_message preserves newlines (test B, D)", () => {
  it("displays a stored multi-line value with every newline intact", () => {
    const text = "Linea 1\nLinea 2\n\nLinea 4";
    render(
      <NodeConfigForm
        node={sendMessageNode(text)}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={() => {}}
      />,
    );
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toBe(text);
  });

  it("never renders a <br> in place of a newline — the raw value is untouched", () => {
    const text = "Linea 1\nLinea 2\n\nLinea 4";
    const { container } = render(
      <NodeConfigForm
        node={sendMessageNode(text)}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={() => {}}
      />,
    );
    expect(container.innerHTML).not.toContain("<br");
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    // A textarea's value is a DOM property, not markup — confirms this
    // isn't rendered as HTML at all (which would be the injection risk
    // an accidental `dangerouslySetInnerHTML` + <br> swap would create).
    expect(textarea.value.split("\n")).toHaveLength(4);
  });
});

describe("NodeConfigForm — send_message edits pass the exact string through (test C)", () => {
  it("onUpdateConfig receives exactly the typed string, newlines and {{vars.contact_name}} included", () => {
    const onUpdateConfig = vi.fn();
    render(
      <NodeConfigForm
        node={sendMessageNode("")}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={onUpdateConfig}
      />,
    );
    const textarea = screen.getByRole("textbox");
    const value = "Hola {{vars.contact_name}}\n\n¿En qué podemos ayudarte?";
    fireEvent.change(textarea, { target: { value } });

    expect(onUpdateConfig).toHaveBeenCalledTimes(1);
    expect(onUpdateConfig).toHaveBeenCalledWith({ text: value });
  });

  it("allows an emoji in the same edit, unmodified", () => {
    const onUpdateConfig = vi.fn();
    render(
      <NodeConfigForm
        node={sendMessageNode("")}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={onUpdateConfig}
      />,
    );
    const textarea = screen.getByRole("textbox");
    const value = "Hola estimado {{vars.contact_name}} 🤗\nGracias por escribirnos.";
    fireEvent.change(textarea, { target: { value } });
    expect(onUpdateConfig).toHaveBeenCalledWith({ text: value });
  });

  it("preserves a leading/trailing blank line on edit (never trimmed)", () => {
    const onUpdateConfig = vi.fn();
    render(
      <NodeConfigForm
        node={sendMessageNode("")}
        allNodes={[]}
        showAdvanced={false}
        onUpdateConfig={onUpdateConfig}
      />,
    );
    const textarea = screen.getByRole("textbox");
    const value = "\nLinea con salto inicial\n";
    fireEvent.change(textarea, { target: { value } });
    expect(onUpdateConfig).toHaveBeenCalledWith({ text: value });
  });
});
