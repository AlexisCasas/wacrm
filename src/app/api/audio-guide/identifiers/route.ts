import { nameCollectionHandlers } from '@/lib/audio-guide/name-routes'

const handlers = nameCollectionHandlers('identifier')

/** GET /api/audio-guide/identifiers  — the account's identifiers with how many audios use each. POST { name, active? } — admin. */
export const GET = handlers.GET
export const POST = handlers.POST
