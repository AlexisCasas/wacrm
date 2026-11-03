/** Compare current contact custom values with the original form snapshot.
 * Field definitions are account-scoped by the caller; this helper is pure.
 * Empty and missing values compare equal; whitespace-only edits are ignored.
 */
export function changedCustomFieldIds<T extends { id: string }>(
  fields: readonly T[],
  next: Readonly<Record<string, string>>,
  previous: Readonly<Record<string, string>>,
): string[] {
  return fields
    .filter((field) => (next[field.id] ?? "").trim() !== (previous[field.id] ?? "").trim())
    .map((field) => field.id);
}
