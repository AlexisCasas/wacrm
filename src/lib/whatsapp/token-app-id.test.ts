import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTokenAppId } from './meta-api'

// getTokenAppId: which Meta app a token belongs to. It must never throw, never put the token in the URL, and only accept a numeric id, so a
// failure to identify can never be mistaken for "the right app is subscribed".

afterEach(() => vi.unstubAllGlobals())
const stub = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const f = vi.fn(impl)
  vi.stubGlobal('fetch', f)
  return f
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('getTokenAppId', () => {
  it('reads GET /app?fields=id with the token in the Authorization header only', async () => {
    const f = stub(async () => json({ id: '1000000000000001' }))
    expect(await getTokenAppId({ accessToken: 'SECRET-TOKEN' })).toBe('1000000000000001')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://graph.facebook.com/v21.0/app?fields=id')
    expect(String(url)).not.toContain('SECRET-TOKEN')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET-TOKEN')
  })

  it.each([
    ['a Meta error status', () => Promise.resolve(json({ error: { message: 'x' } }, 400))],
    ['a server error', () => Promise.resolve(json({}, 500))],
    ['no id in the answer', () => Promise.resolve(json({}))],
    ['a non-numeric id', () => Promise.resolve(json({ id: 'abc' }))],
    ['a numeric id sent as a number', () => Promise.resolve(json({ id: 123456 }))],
    ['an unparseable body', () => Promise.resolve(new Response('not json', { status: 200 }))],
    ['a network failure', () => Promise.reject(new Error('network down'))],
  ])('returns null (never throws) on %s', async (_n, impl) => {
    stub(impl)
    await expect(getTokenAppId({ accessToken: 't' })).resolves.toBeNull()
  })
})
