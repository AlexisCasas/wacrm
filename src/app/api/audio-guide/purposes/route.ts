import { nameCollectionHandlers } from '@/lib/audio-guide/name-routes'

const handlers = nameCollectionHandlers('purpose')

/** GET /api/audio-guide/purposes  — the account's purposes with how many audios use each. POST { name, active? } — admin. */
export const GET = handlers.GET
export const POST = handlers.POST
