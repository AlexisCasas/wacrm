// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useState } from "react";

import { MessageThread } from "./message-thread";
import type { Contact, Conversation, Message } from "@/types";

const h = vi.hoisted(() => {
  let resolveMessages: (value: { data: Message[]; error: null }) => void;
  return {
    messageFetch: new Promise<{ data: Message[]; error: null }>((resolve) => {
      resolveMessages = resolve;
    }),
    resolveMessages: (rows: Message[]) => resolveMessages({ data: rows, error: null }),
    resetMessageFetch() {
      this.messageFetch = new Promise<{ data: Message[]; error: null }>((resolve) => {
        resolveMessages = resolve;
      });
      this.resolveMessages = (rows: Message[]) => resolveMessages({ data: rows, error: null });
    },
  };
});

const resizeObservers: Array<() => void> = [];

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "agent-1" } }) }));
vi.mock("@/hooks/use-can", () => ({ useCan: () => false }));
vi.mock("@/hooks/use-presence", () => ({
  usePresence: () => ({ getPresence: () => "offline", getRow: () => null, now: new Date() }),
}));
vi.mock("@/components/presence/presence-dot", () => ({ PresenceDot: () => null }));
vi.mock("@/lib/presence", () => ({ presenceLabel: () => "offline" }));
vi.mock("@/lib/media/gallery", () => ({ collectMediaGallery: () => [] }));
vi.mock("@/lib/storage/upload-media", () => ({
  CHAT_MEDIA_BUCKET: "chat-media",
  deleteAccountMedia: vi.fn(),
}));
vi.mock("@/lib/whatsapp/template-body", () => ({ renderTemplateBody: () => "template" }));
vi.mock("./reply-quote", () => ({ buildReplyPreview: () => "reply" }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("./message-bubble", () => ({
  MessageBubble: ({ message }: { message: Message }) => <div>{message.id}</div>,
}));
vi.mock("./message-actions", () => ({
  MessageActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./message-composer", () => ({
  CHAT_MEDIA_BUCKET: "chat-media",
  MessageComposer: ({
    onSend,
    onSendMedia,
    onSendInteractive,
    onOpenTemplates,
  }: {
    onSend: (text: string) => void;
    onSendMedia: (payload: { kind: "image"; mediaUrl: string; path: string }) => void;
    onSendInteractive: (payload: { body: string }) => void;
    onOpenTemplates: () => void;
  }) => (
    <>
      <button onClick={() => onSend("outbound")}>send-text</button>
      <button onClick={() => onSendMedia({ kind: "image", mediaUrl: "https://media.test/image", path: "image" })}>send-media</button>
      <button onClick={() => onSendInteractive({ body: "interactive" })}>send-interactive</button>
      <button onClick={onOpenTemplates}>open-template</button>
    </>
  ),
}));
vi.mock("./template-picker", () => ({
  TemplatePicker: ({ open, onSelect }: { open: boolean; onSelect: (template: { name: string; language: string; body_text: string }, values: { body: string[] }) => void }) =>
    open ? <button onClick={() => onSelect({ name: "welcome", language: "en", body_text: "hello" }, { body: [] })}>send-template</button> : null,
}));
vi.mock("./ai-thread-banner", () => ({ AiThreadBanner: () => null }));
vi.mock("./flow-start-picker", () => ({ FlowStartPicker: () => null }));
vi.mock("./media-lightbox", () => ({ MediaLightbox: () => null }));
vi.mock("@/components/ui/badge", () => ({ Badge: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children }: { children: ReactNode }) => <button>{children}</button> }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const result = Promise.resolve({ data: [], error: null });
    return {
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          update: () => builder,
          order: () => (table === "messages" ? h.messageFetch : result),
          then: result.then.bind(result),
        };
        return builder;
      },
      channel: () => ({ on: () => ({ on: () => ({ on: () => ({ subscribe: () => ({}) }) }) }) }),
      removeChannel: vi.fn(),
    };
  },
}));

const contact: Contact = {
  id: "contact-a",
  account_id: "account-1",
  user_id: "agent-1",
  name: "Ada",
  phone: "+15550000000",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function conversation(id = "conversation-a"): Conversation {
  return {
    id,
    user_id: "agent-1",
    contact_id: contact.id,
    status: "open",
    unread_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    last_message_at: "2026-01-01T00:00:00Z",
  };
}

function message(id: string, conversationId = "conversation-a"): Message {
  return {
    id,
    conversation_id: conversationId,
    sender_type: "customer",
    content_type: "text",
    content_text: id,
    status: "sent",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function threadProps(messages: Message[], activeConversation = conversation()) {
  return {
    conversation: activeConversation,
    contact,
    messages,
    onMessagesLoaded: vi.fn(),
    onNewMessage: vi.fn(),
    onMessageActivityFailed: vi.fn(),
    onMessageActivityConfirmed: vi.fn(),
    onUpdateMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onAssignChange: vi.fn(),
  };
}

function ThreadHarness({ initialMessages }: { initialMessages: Message[] }) {
  const [threadMessages, setThreadMessages] = useState(initialMessages);
  const props = threadProps(threadMessages);
  return (
    <>
      <MessageThread
        {...props}
        onMessagesLoaded={setThreadMessages}
        onNewMessage={(next) => setThreadMessages((current) => [...current, next])}
        onUpdateMessage={(id, updates) => setThreadMessages((current) => current.map((currentMessage) => currentMessage.id === id ? { ...currentMessage, ...updates } : currentMessage))}
      />
      <button
        onClick={() =>
          setThreadMessages((current) => {
            const temporary = current.find((currentMessage) => currentMessage.id.startsWith("temp-"));
            return temporary
              ? [
                  ...current.filter((currentMessage) => currentMessage.id !== temporary.id),
                  { ...temporary, id: "persisted-replacement", status: "sent" },
                ]
              : current;
          })
        }
      >
        replace-temporary
      </button>
    </>
  );
}

function ConversationSwitchHarness({ initialMessages }: { initialMessages: Message[] }) {
  const conversationA = conversation();
  const conversationB = conversation("conversation-b");
  const [activeConversation, setActiveConversation] = useState(conversationA);
  const [threadMessages, setThreadMessages] = useState(initialMessages);
  const props = threadProps(threadMessages, activeConversation);
  return (
    <>
      <button
        onClick={() => {
          setActiveConversation(conversationB);
          setThreadMessages([]);
        }}
      >
        switch-to-b
      </button>
      <MessageThread
        {...props}
        onMessagesLoaded={setThreadMessages}
        onNewMessage={(next) => setThreadMessages((current) => [...current, next])}
      />
    </>
  );
}

function ResyncHarness({ initialMessages }: { initialMessages: Message[] }) {
  const [threadMessages, setThreadMessages] = useState(initialMessages);
  const [resyncToken, setResyncToken] = useState(0);
  const props = threadProps(threadMessages);
  return (
    <>
      <button onClick={() => setResyncToken((current) => current + 1)}>resync</button>
      <MessageThread
        {...props}
        resyncToken={resyncToken}
        onMessagesLoaded={setThreadMessages}
      />
    </>
  );
}

function attachScrollMetrics(element: HTMLElement, scrollHeight = 1_000, clientHeight = 200) {
  let top = 0;
  let height = scrollHeight;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollTop: { configurable: true, get: () => top, set: (next: number) => { top = next; } },
  });
  return { setHeight: (next: number) => { height = next; } };
}

afterEach(cleanup);
beforeEach(() => {
  h.resetMessageFetch();
  resizeObservers.length = 0;
  class TestResizeObserver {
    constructor(private readonly callback: () => void) {
      resizeObservers.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

describe("MessageThread scroll follow", () => {
  it("opens fetched history at bottom, but preserves a reader above when an inbound row arrives", async () => {
    const initial = [message("one"), message("two")];
    const props = threadProps(initial);
    const view = render(<MessageThread {...props} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);

    await act(async () => h.resolveMessages(initial));
    expect(scroll.scrollTop).toBe(800);

    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_100);
    view.rerender(<MessageThread {...threadProps([...initial, message("inbound")])} />);
    expect(scroll.scrollTop).toBe(120);
  });

  it("follows an inbound row near bottom, while status-only and temp-to-persist updates do not force a reader upward", async () => {
    const initial = [message("temp-send")];
    const props = threadProps(initial);
    const view = render(<MessageThread {...props} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);

    await act(async () => h.resolveMessages(initial));
    scroll.scrollTop = 700;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_100);
    view.rerender(<MessageThread {...threadProps([...initial, message("inbound")])} />);
    expect(scroll.scrollTop).toBe(900);

    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_200);
    view.rerender(<MessageThread {...threadProps([{ ...message("persisted-send"), status: "sent" }])} />);
    expect(scroll.scrollTop).toBe(120);
  });

  it("preserves the exact position through a same-history resync", async () => {
    const initial = [message("one"), message("two")];
    const refetched = [{ ...initial[0], status: "read" as const, content_text: "updated" }, initial[1]];
    const view = render(<ResyncHarness initialMessages={initial} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    h.resetMessageFetch();
    fireEvent.click(view.getByText("resync"));
    await act(async () => h.resolveMessages(refetched));
    expect(scroll.scrollTop).toBe(120);
  });

  it("keeps a reader above in place when a resync discovers a missed message", async () => {
    const initial = [message("one")];
    const missed = [...initial, message("missed")];
    const view = render(<ResyncHarness initialMessages={initial} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_100);
    h.resetMessageFetch();
    fireEvent.click(view.getByText("resync"));
    await act(async () => h.resolveMessages(missed));
    expect(scroll.scrollTop).toBe(120);
  });

  it("keeps bottom when a resync discovers a missed message", async () => {
    const initial = [message("one")];
    const missed = [...initial, message("missed")];
    const view = render(<ResyncHarness initialMessages={initial} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    scroll.scrollTop = 800;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_100);
    h.resetMessageFetch();
    fireEvent.click(view.getByText("resync"));
    await act(async () => h.resolveMessages(missed));
    expect(scroll.scrollTop).toBe(900);
  });

  it("does not show A's rows while B is loading, then initializes B after B's rows render", async () => {
    const messagesA = [message("a-message")];
    const messagesB = [message("b-message", "conversation-b")];
    const view = render(<ConversationSwitchHarness initialMessages={messagesA} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(messagesA));

    h.resetMessageFetch();
    fireEvent.click(view.getByText("switch-to-b"));
    expect(view.queryByText("a-message")).not.toBeInTheDocument();
    expect(view.queryByText("b-message")).not.toBeInTheDocument();

    metrics.setHeight(1_400);
    scroll.scrollTop = 50;
    await act(async () => h.resolveMessages(messagesB));
    expect(view.getByText("b-message")).toBeInTheDocument();
    expect(scroll.scrollTop).toBe(1_200);
  });

  it("follows delayed media height only at bottom and starts a newly selected thread at bottom", async () => {
    const initial = [message("media")];
    const view = render(<MessageThread {...threadProps(initial)} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_100);
    act(() => resizeObservers.forEach((callback) => callback()));
    expect(scroll.scrollTop).toBe(120);

    scroll.scrollTop = 900;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_200);
    act(() => resizeObservers.forEach((callback) => callback()));
    expect(scroll.scrollTop).toBe(1_000);

    h.resetMessageFetch();
    const conversationB = conversation("conversation-b");
    const messagesB = [message("b-message", conversationB.id)];
    metrics.setHeight(1_400);
    scroll.scrollTop = 50;
    view.rerender(<MessageThread {...threadProps(messagesB, conversationB)} />);
    await act(async () => h.resolveMessages(messagesB));
    expect(scroll.scrollTop).toBe(1_200);
  });

  it("moves to bottom for optimistic text, media, interactive, and template sends", async () => {
    const initial = [message("initial")];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const view = render(<ThreadHarness initialMessages={initial} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    for (const [button, height] of [["send-text", 1_100], ["send-media", 1_200], ["send-interactive", 1_300], ["open-template", 1_350]] as const) {
      scroll.scrollTop = 120;
      fireEvent.scroll(scroll);
      metrics.setHeight(height);
      await act(async () => fireEvent.click(view.getByText(button)));
      if (button === "open-template") {
        await act(async () => fireEvent.click(view.getByText("send-template")));
      }
      expect(scroll.scrollTop).toBe(height - 200);
    }
  });

  it("does not treat a persisted replacement as another message after the agent scrolls up", async () => {
    const initial = [message("initial")];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const view = render(<ThreadHarness initialMessages={initial} />);
    const scroll = view.container.querySelector<HTMLElement>(".overflow-y-auto")!;
    const metrics = attachScrollMetrics(scroll);
    await act(async () => h.resolveMessages(initial));

    await act(async () => fireEvent.click(view.getByText("send-text")));
    scroll.scrollTop = 120;
    fireEvent.scroll(scroll);
    metrics.setHeight(1_200);
    await act(async () => fireEvent.click(view.getByText("replace-temporary")));
    expect(scroll.scrollTop).toBe(120);
  });
});
