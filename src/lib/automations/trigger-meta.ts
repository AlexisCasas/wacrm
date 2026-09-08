import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

const PILL_CLASS: Record<AutomationTriggerType, string> = {
  new_message_received: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  first_inbound_message: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  keyword_match: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  new_contact_created: 'border-primary/30 bg-primary/10 text-primary',
  conversation_assigned: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  tag_added: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  time_based: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  interactive_reply: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
}

const UNKNOWN_PILL_CLASS = 'border-slate-500/30 bg-slate-500/10 text-muted-foreground'

/**
 * `t` must be scoped to `Automations.builder.triggers` — the same
 * catalogue entries the trigger picker uses, so a trigger type's label
 * reads identically everywhere it's shown.
 */
export function triggerMeta(
  type: AutomationTriggerType | string,
  t: (key: string) => string,
): TriggerMeta {
  const known = Object.prototype.hasOwnProperty.call(PILL_CLASS, type)
  if (!known) {
    return { label: type, pillClass: UNKNOWN_PILL_CLASS }
  }
  return {
    label: t(`${type}.label`),
    pillClass: PILL_CLASS[type as AutomationTriggerType],
  }
}

/**
 * `t` must be scoped to `Common.relativeTime`.
 */
export function formatRelative(
  iso: string | null | undefined,
  t: (key: string, values?: Record<string, number>) => string,
): string {
  if (!iso) return t('never')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('never')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('justNow')
  if (diffSec < 3600) return t('minutesAgo', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('hoursAgo', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('daysAgo', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
