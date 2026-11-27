"use client";

import { useState } from "react";
import type { Contact, Tag } from "@/types";
import { useAuth } from "@/hooks/use-auth";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { LogisticsSidebar } from "@/components/inbox/logistics-sidebar";

type SupervisorView = "commercial" | "logistics";

interface OperationalSidebarProps {
  contact: Contact | null;
  conversationId: string | null;
  onTagsChanged: (contactId: string, tags: Tag[]) => void;
  onTagCreated: () => void;
  onContactUpdated: (contact: Contact) => void;
}

export function OperationalSidebar({
  contact,
  conversationId,
  onTagsChanged,
  onTagCreated,
  onContactUpdated,
}: OperationalSidebarProps) {
  const { profile } = useAuth();
  const [supervisorView, setSupervisorView] =
    useState<SupervisorView>("commercial");

  const role = profile?.operational_role ?? null;

  const commercialPanel = (
    <ContactSidebar
      contact={contact}
      conversationId={conversationId}
      onTagsChanged={onTagsChanged}
      onTagCreated={onTagCreated}
      onContactUpdated={onContactUpdated}
    />
  );

  if (role === "logistics") {
    return <LogisticsSidebar conversationId={conversationId} />;
  }

  if (role !== "supervisor") {
    // Preserve the historical path for Commercial and legacy/null roles.
    return commercialPanel;
  }

  return (
    <div className="flex h-full flex-col border-l bg-background">
      <div className="border-b p-2">
        <div
          className="grid grid-cols-2 rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="Vista operativa"
        >
          <button
            type="button"
            role="tab"
            aria-selected={supervisorView === "commercial"}
            onClick={() => setSupervisorView("commercial")}
            className={`rounded-md px-3 py-2 text-xs font-medium transition ${
              supervisorView === "commercial"
                ? "bg-background shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            Comercial
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={supervisorView === "logistics"}
            onClick={() => setSupervisorView("logistics")}
            className={`rounded-md px-3 py-2 text-xs font-medium transition ${
              supervisorView === "logistics"
                ? "bg-background shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            Logística
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {supervisorView === "commercial" ? (
          commercialPanel
        ) : (
          <LogisticsSidebar conversationId={conversationId} />
        )}
      </div>
    </div>
  );
}
