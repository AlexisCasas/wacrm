import { nameItemHandlers } from '@/lib/audio-guide/name-routes'

const handlers = nameItemHandlers('identifier')

/** PATCH /api/audio-guide/identifiers/:id { name?, active? } and DELETE — admin. Deleting one an audio uses is 409 in_use. */
export const PATCH = handlers.PATCH
export const DELETE = handlers.DELETE
