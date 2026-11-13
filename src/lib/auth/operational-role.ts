// Operational area of a member (PR-01 Comercial + Logistica). It is INDEPENDENT of the technical account role (owner/admin/agent/viewer):
// nothing here grants or removes a permission. Mirrors `operational_role_enum` in migration 20261121000000.

export type OperationalRole = "commercial" | "logistics" | "supervisor";

export const OPERATIONAL_ROLES: readonly OperationalRole[] = ["commercial", "logistics", "supervisor"] as const;

export function isOperationalRole(value: unknown): value is OperationalRole {
  return typeof value === "string" && (OPERATIONAL_ROLES as readonly string[]).includes(value);
}
