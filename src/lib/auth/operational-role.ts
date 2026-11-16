// Operational area of a member (PR-01 Comercial + Logistica). It is INDEPENDENT of the technical account role (owner/admin/agent/viewer):
// nothing here grants or removes a permission. Mirrors `operational_role_enum` in migration 20261121000000.

export type OperationalRole = "commercial" | "logistics" | "supervisor";

export const OPERATIONAL_ROLES: readonly OperationalRole[] = ["commercial", "logistics", "supervisor"] as const;

export function isOperationalRole(value: unknown): value is OperationalRole {
  return typeof value === "string" && (OPERATIONAL_ROLES as readonly string[]).includes(value);
}

/**
 * Which operational areas `caller` may assign to `target` (UI mirror of the SECURITY DEFINER RPC `set_member_operational_role`, migration
 * 20261126000000 — the RPC is the real authority, this only decides what to render). An empty list = read-only (no selector).
 *
 *  - owner/admin (`isAdmin`): commercial | logistics | supervisor (plus "unassigned" = null, handled by the caller), on any member. Being also a
 *    supervisor changes nothing.
 *  - operational supervisor who is not owner/admin: commercial | logistics (plus null) on a member that is NOT owner/admin and NOT currently a supervisor.
 *    Never `supervisor`, never an existing supervisor (another one or itself).
 *  - anyone else: nothing.
 */
export function assignableOperationalRoles(
  caller: { isAdmin: boolean; operationalRole: OperationalRole | null },
  target: { operationalRole: OperationalRole | null; accountRole?: string | null },
): readonly OperationalRole[] {
  if (caller.isAdmin) return OPERATIONAL_ROLES;
  if (caller.operationalRole !== "supervisor") return [];
  if (target.accountRole === "owner" || target.accountRole === "admin") return [];
  if (target.operationalRole === "supervisor") return [];
  return OPERATIONAL_ROLES.filter((r) => r !== "supervisor");
}
