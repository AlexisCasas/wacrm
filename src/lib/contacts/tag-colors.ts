/**
 * Shared preset palette for tag creation — used by Settings'
 * `TagManager` and the Inbox `ContactSidebar` "create tag" form so
 * both surfaces offer identical swatches. Every value is a valid
 * `#RRGGBB` string, matching what `POST /api/tags` (tag-create.ts)
 * requires server-side.
 */
export interface PresetTagColor {
  name: string;
  value: string;
}

export const PRESET_TAG_COLORS: PresetTagColor[] = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];
