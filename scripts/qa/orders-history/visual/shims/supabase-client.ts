// Inert stand-in: every query resolves to an empty result.
const chain: Record<string, unknown> = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => chain) })
export const createClient = () => ({ from: () => chain, auth: { getUser: async () => ({ data: { user: null } }) } })
