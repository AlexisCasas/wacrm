// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

import { ContactSidebar } from "./contact-sidebar";
import type { Contact } from "@/types";

// P3 — Inbox tag administration. ContactSidebar receives `contact.tags`
// as a prop (already embedded by INBOX_CONVERSATION_SELECT — no fetch
// of its own for the contact's OWN tags) and reports every successful
// assign/remove/create upward via `onTagsChanged`, never mutating its
// own local copy of the assigned-tags list. The account-wide tag
// CATALOG (for the picker) is its own one-time fetch, mocked below.

const messages: Record<string, string> = {
  contactInfo: "Contact info",
  tags: "Tags",
  notes: "Notes",
  deals: "Deals",
  noTags: "No tags",
  noDeals: "No deals",
  addNotePlaceholder: "Add a note...",
  addTagAria: "Add tag",
  removeTagAria: "Remove {name}",
  tagsSearchPlaceholder: "Search tags...",
  tagsNoResults: "No tags found",
  tagsCatalogEmpty: "No tags in this account yet",
  createTagButton: "Create new tag",
  createTagNamePlaceholder: "Tag name",
  createTagSave: "Create",
  createTagCancel: "Cancel",
  toastTagCreated: "Tag created",
  errorAssignTag: "Couldn't assign tag. Please try again.",
  errorRemoveTag: "Couldn't remove tag. Please try again.",
  errorNameRequired: "Tag name is required",
  errorNameTooLong: "Tag name must be {max} characters or fewer",
  errorInvalidColor: "Please choose a valid color",
  errorDuplicateTag: "A tag with this name already exists",
  errorCreateTag: "Couldn't create tag. Please try again.",
  errorAssignAfterCreate:
    "Tag created, but couldn't be assigned to this contact. Pick it from the list to try again.",
  selectConversation: "Select a conversation",
};

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    let str = messages[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  },
  useLocale: () => "en",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({
  accountId: "acct-1" as string | null,
  canSendMessages: true,
  canEditSettings: true,
  allTags: [] as { id: string; name: string; color: string }[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    accountId: h.accountId,
    canSendMessages: h.canSendMessages,
    canEditSettings: h.canEditSettings,
  }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => {
          if (table === "tags") {
            return Promise.resolve({ data: h.allTags, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  }),
}));

const tagApi = vi.hoisted(() => {
  class FakeTagApiError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    addContactTag: vi.fn(),
    deleteContactTag: vi.fn(),
    createTag: vi.fn(),
    FakeTagApiError,
  };
});
const FakeTagApiError = tagApi.FakeTagApiError;

vi.mock("@/lib/contacts/tag-api", () => ({
  addContactTag: tagApi.addContactTag,
  deleteContactTag: tagApi.deleteContactTag,
  createTag: tagApi.createTag,
  TagApiError: tagApi.FakeTagApiError,
}));

import { toast } from "sonner";

function tag(id: string, name: string, color = "#3b82f6") {
  return { id, name, color, account_id: "acct-1", user_id: "u-1", created_at: "2026-01-01T00:00:00Z" };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact-1",
    user_id: "u-1",
    account_id: "acct-1",
    phone: "+15550000000",
    name: "Juan Pérez",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  h.accountId = "acct-1";
  h.canSendMessages = true;
  h.canEditSettings = true;
  h.allTags = [tag("t1", "Favoritos"), tag("t2", "Pendiente"), tag("t3", "Reclamo")];
  tagApi.addContactTag.mockReset();
  tagApi.deleteContactTag.mockReset();
  tagApi.createTag.mockReset();
  tagApi.addContactTag.mockResolvedValue({ added: true, dispatched: true });
  tagApi.deleteContactTag.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ContactSidebar — reading existing tags", () => {
  it("renders the contact's currently assigned tags", async () => {
    render(<ContactSidebar contact={makeContact({ tags: [tag("t1", "Favoritos")] })} />);
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();
  });

  it("shows the empty state when the contact has no tags", async () => {
    render(<ContactSidebar contact={makeContact({ tags: [] })} />);
    expect(await screen.findByText("No tags")).toBeInTheDocument();
  });
});

describe("ContactSidebar — assign (agent+)", () => {
  it("persists via addContactTag BEFORE reporting the change, then calls onTagsChanged with the updated list", async () => {
    const onTagsChanged = vi.fn();
    render(
      <ContactSidebar
        contact={makeContact({ tags: [] })}
        onTagsChanged={onTagsChanged}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Add tag"));
    const row = await screen.findByText("Favoritos");
    fireEvent.click(row);

    await waitFor(() => expect(tagApi.addContactTag).toHaveBeenCalledWith("contact-1", "t1"));
    await waitFor(() =>
      expect(onTagsChanged).toHaveBeenCalledWith("contact-1", [tag("t1", "Favoritos")]),
    );
  });

  it("assigning multiple tags calls onTagsChanged once per successful assignment", async () => {
    const onTagsChanged = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagsChanged={onTagsChanged} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Favoritos"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByText("Pendiente"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledTimes(2));
    expect(onTagsChanged).toHaveBeenLastCalledWith("contact-1", [tag("t2", "Pendiente")]);
  });

  it("a failed assignment shows an error and NEVER calls onTagsChanged (no ghost chip)", async () => {
    tagApi.addContactTag.mockRejectedValue(new Error("network down"));
    const onTagsChanged = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagsChanged={onTagsChanged} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Favoritos"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't assign tag. Please try again."));
    expect(onTagsChanged).not.toHaveBeenCalled();
  });

  it("hides the add control entirely for a viewer (agent+ required)", async () => {
    h.canSendMessages = false;
    render(<ContactSidebar contact={makeContact({ tags: [tag("t1", "Favoritos")] })} />);
    await screen.findByText("Favoritos");
    expect(screen.queryByLabelText("Add tag")).not.toBeInTheDocument();
    // Read-only chip: no remove control either.
    expect(screen.queryByLabelText("Remove Favoritos")).not.toBeInTheDocument();
  });
});

describe("ContactSidebar — remove", () => {
  it("persists via deleteContactTag BEFORE reporting the change", async () => {
    const onTagsChanged = vi.fn();
    render(
      <ContactSidebar
        contact={makeContact({ tags: [tag("t1", "Favoritos")] })}
        onTagsChanged={onTagsChanged}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Remove Favoritos"));

    await waitFor(() => expect(tagApi.deleteContactTag).toHaveBeenCalledWith("contact-1", "t1"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledWith("contact-1", []));
  });

  it("a failed removal shows an error and leaves the chip reported as still-assigned", async () => {
    tagApi.deleteContactTag.mockRejectedValue(new Error("network down"));
    const onTagsChanged = vi.fn();
    render(
      <ContactSidebar
        contact={makeContact({ tags: [tag("t1", "Favoritos")] })}
        onTagsChanged={onTagsChanged}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Remove Favoritos"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't remove tag. Please try again."));
    expect(onTagsChanged).not.toHaveBeenCalled();
    // Never removes the DELETE handler's own row-level guard against
    // double-submit remains OFF — nothing else to assert visually
    // since the component never touched local state.
  });
});

describe("ContactSidebar — create (admin+ only)", () => {
  it("hides the create-tag affordance for a non-admin (agent)", async () => {
    h.canEditSettings = false;
    render(<ContactSidebar contact={makeContact()} />);
    fireEvent.click(await screen.findByLabelText("Add tag"));
    await screen.findByPlaceholderText("Search tags...");
    expect(screen.queryByText("Create new tag")).not.toBeInTheDocument();
  });

  it("creates a tag then immediately assigns it to the active contact", async () => {
    const created = tag("t-new", "Cliente frecuente", "#8b5cf6");
    tagApi.createTag.mockResolvedValue(created);
    const onTagsChanged = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagsChanged={onTagsChanged} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    fireEvent.change(await screen.findByPlaceholderText("Tag name"), {
      target: { value: "Cliente frecuente" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(tagApi.createTag).toHaveBeenCalledWith("Cliente frecuente", expect.any(String)),
    );
    await waitFor(() => expect(tagApi.addContactTag).toHaveBeenCalledWith("contact-1", "t-new"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledWith("contact-1", [created]));
    expect(toast.success).toHaveBeenCalledWith("Tag created");
  });

  it("fires onTagCreated exactly once for a new tag definition, regardless of the assignment outcome (P3 — immediate filter availability)", async () => {
    const created = tag("t-new", "Cliente frecuente");
    tagApi.createTag.mockResolvedValue(created);
    const onTagCreated = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagCreated={onTagCreated} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    fireEvent.change(await screen.findByPlaceholderText("Tag name"), {
      target: { value: "Cliente frecuente" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(onTagCreated).toHaveBeenCalledTimes(1));
    expect(onTagCreated).toHaveBeenCalledWith(created);
  });

  it("still fires onTagCreated even when the follow-up assignment to this contact fails (the definition exists either way)", async () => {
    const created = tag("t-new", "Cliente frecuente");
    tagApi.createTag.mockResolvedValue(created);
    tagApi.addContactTag.mockRejectedValue(new Error("network down"));
    const onTagCreated = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagCreated={onTagCreated} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    fireEvent.change(await screen.findByPlaceholderText("Tag name"), {
      target: { value: "Cliente frecuente" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() => expect(onTagCreated).toHaveBeenCalledWith(created));
  });

  it("never fires onTagCreated when assigning or removing an EXISTING tag", async () => {
    const onTagCreated = vi.fn();
    const onTagsChanged = vi.fn();
    const { rerender } = render(
      <ContactSidebar
        contact={makeContact({ tags: [tag("t1", "Favoritos")] })}
        onTagCreated={onTagCreated}
        onTagsChanged={onTagsChanged}
      />,
    );

    // Remove an existing tag.
    fireEvent.click(await screen.findByLabelText("Remove Favoritos"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledWith("contact-1", []));

    // Mirror what the real parent (Inbox page) does after a successful
    // onTagsChanged: patch the contact prop it hands back down.
    rerender(
      <ContactSidebar
        contact={makeContact({ tags: [] })}
        onTagCreated={onTagCreated}
        onTagsChanged={onTagsChanged}
      />,
    );

    // Assign a different existing tag from the picker.
    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Pendiente"));
    await waitFor(() => expect(onTagsChanged).toHaveBeenCalledWith("contact-1", [tag("t2", "Pendiente")]));

    expect(onTagCreated).not.toHaveBeenCalled();
  });

  it("partial failure (created but not assigned) reports a distinct message and does NOT claim the whole thing failed", async () => {
    const created = tag("t-new", "Cliente frecuente");
    tagApi.createTag.mockResolvedValue(created);
    tagApi.addContactTag.mockRejectedValue(new Error("network down"));
    const onTagsChanged = vi.fn();
    render(<ContactSidebar contact={makeContact({ tags: [] })} onTagsChanged={onTagsChanged} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    fireEvent.change(await screen.findByPlaceholderText("Tag name"), {
      target: { value: "Cliente frecuente" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Tag created, but couldn't be assigned to this contact. Pick it from the list to try again.",
      ),
    );
    expect(toast.error).not.toHaveBeenCalledWith("Couldn't create tag. Please try again.");
    expect(onTagsChanged).not.toHaveBeenCalled();
  });

  it("maps a duplicate-name conflict from the server to a localized message", async () => {
    tagApi.createTag.mockRejectedValue(new FakeTagApiError("dup", "tag_name_conflict"));
    render(<ContactSidebar contact={makeContact()} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    fireEvent.change(await screen.findByPlaceholderText("Tag name"), {
      target: { value: "Pendiente" },
    });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A tag with this name already exists"),
    );
  });

  it("rejects submitting an empty name client-side without calling the API", async () => {
    render(<ContactSidebar contact={makeContact()} />);
    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.click(await screen.findByText("Create new tag"));
    const submit = screen.getByText("Create");
    expect(submit).toBeDisabled();
    expect(tagApi.createTag).not.toHaveBeenCalled();
  });
});

describe("ContactSidebar — switching contacts does not leak state", () => {
  it("closes the picker and clears its search when the active contact changes", async () => {
    const { rerender } = render(<ContactSidebar contact={makeContact({ id: "contact-A", tags: [] })} />);

    fireEvent.click(await screen.findByLabelText("Add tag"));
    fireEvent.change(await screen.findByPlaceholderText("Search tags..."), {
      target: { value: "Pend" },
    });
    expect(await screen.findByPlaceholderText("Search tags...")).toHaveValue("Pend");

    rerender(<ContactSidebar contact={makeContact({ id: "contact-B", tags: [] })} />);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Search tags...")).not.toBeInTheDocument();
    });
  });

  it("shows contact B's own tags after switching from contact A, never A's", async () => {
    const { rerender } = render(
      <ContactSidebar contact={makeContact({ id: "contact-A", tags: [tag("t1", "Favoritos")] })} />,
    );
    expect(await screen.findByText("Favoritos")).toBeInTheDocument();

    rerender(
      <ContactSidebar contact={makeContact({ id: "contact-B", tags: [tag("t2", "Pendiente")] })} />,
    );

    expect(await screen.findByText("Pendiente")).toBeInTheDocument();
    expect(screen.queryByText("Favoritos")).not.toBeInTheDocument();
  });
});
