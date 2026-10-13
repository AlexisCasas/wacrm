import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MockEffectSender } from './test-support/mock-sender'
import { effectOccurrenceKey, parseMessageNode, parseOutboundPayload, renderVarTemplate, type OutboundRequest } from './versioned-messaging'

const node = (node_type: string, config: Record<string, unknown>) => ({ node_key: 'n', node_type, config, position_x: 0, position_y: 0 }) as unknown as Parameters<typeof parseMessageNode>[0]

describe('renderVarTemplate (same semantics as the legacy runner)', () => {
  it('interpolates {{vars.x}} and renders missing values as empty', () => {
    expect(renderVarTemplate('Hi {{vars.name}}, {{vars.n}} items {{vars.missing}}!', { name: 'Ana', n: 3 })).toBe('Hi Ana, 3 items !')
    expect(renderVarTemplate('{{vars.a}}{{vars.b}}', { a: null, b: undefined })).toBe('')
    expect(renderVarTemplate('', { a: 1 })).toBe('')
    expect(renderVarTemplate('{{ vars.name }} {{name}} {{vars.na-me}}', { name: 'x' })).toBe('{{ vars.name }} {{name}} {{vars.na-me}}')
  })
})

describe('parseMessageNode', () => {
  it('builds a deterministic text payload', () => {
    const spec = parseMessageNode(node('send_message', { text: 'Hi {{vars.who}}', next_node_key: 'x' }))!
    expect(spec).toMatchObject({ effectType: 'send_message', nextNodeKey: 'x' })
    expect(spec.build({ who: 'Ana' })).toEqual({ kind: 'text', text: 'Hi Ana' })
    expect(spec.build({ who: 'Ana' })).toEqual(spec.build({ who: 'Ana' }))
  })
  it('builds a media payload with an optional rendered caption and filename', () => {
    const spec = parseMessageNode(node('send_media', { media_type: 'document', media_url: 'https://x.test/a.pdf', caption: 'For {{vars.who}}', filename: 'a.pdf', next_node_key: 'x', manychat_bridge_flow_ns: 'ns' }))!
    expect(spec.effectType).toBe('send_media')
    expect(spec.build({ who: 'Luis' })).toEqual({ kind: 'media', media_type: 'document', media_url: 'https://x.test/a.pdf', caption: 'For Luis', filename: 'a.pdf' })
    expect(parseMessageNode(node('send_media', { media_type: 'image', media_url: 'https://x.test/a.png', next_node_key: 'x' }))!.build({})).toEqual({ kind: 'media', media_type: 'image', media_url: 'https://x.test/a.png' })
  })
  it.each([
    ['send_message', {}], ['send_message', { text: '  ', next_node_key: 'x' }], ['send_message', { text: 'hi' }], ['send_message', { text: 5, next_node_key: 'x' }],
    ['send_media', { media_type: 'audio', media_url: 'https://x.test/a', next_node_key: 'x' }], ['send_media', { media_type: 'image', media_url: 'ftp://x.test/a', next_node_key: 'x' }],
    ['send_media', { media_type: 'image', media_url: 'not a url', next_node_key: 'x' }], ['send_media', { media_type: 'image', media_url: 'https://x.test/a', caption: 3, next_node_key: 'x' }],
    ['send_buttons', { text: 'hi', next_node_key: 'x' }], ['http_fetch', {}],
  ])('rejects %s %j', (type, cfg) => expect(parseMessageNode(node(type, cfg))).toBeNull())
})

describe('parseOutboundPayload', () => {
  it('accepts only what a builder can produce', () => {
    expect(parseOutboundPayload({ kind: 'text', text: 'hi' })).toEqual({ kind: 'text', text: 'hi' })
    expect(parseOutboundPayload({ kind: 'media', media_type: 'video', media_url: 'https://x.test/v.mp4', caption: 'c' })).toEqual({ kind: 'media', media_type: 'video', media_url: 'https://x.test/v.mp4', caption: 'c' })
    for (const bad of [null, [], {}, { kind: 'text' }, { kind: 'media', media_type: 'audio', media_url: 'u' }, { kind: 'sticker', text: 'x' }]) expect(parseOutboundPayload(bad)).toBeNull()
  })
})

describe('MockEffectSender (the only sender in this repository)', () => {
  const req = (n: number): OutboundRequest => ({ effectId: `e${n}`, attemptId: `a${n}`, attempt: 1, occurrenceKey: effectOccurrenceKey('r', n), effectType: 'send_message', contactId: null, conversationId: null, payload: { kind: 'text', text: `t${n}` } })
  it('delivers only for the behaviors that really deliver, and gives unique provider ids', async () => {
    const s = new MockEffectSender().script('accept', 'accept_then_timeout', 'timeout_not_delivered', 'fail_before_send', 'permanent_failure')
    expect(await s.send(req(1))).toMatchObject({ kind: 'accepted' })
    expect(await s.send(req(2))).toEqual({ kind: 'ambiguous', errorCode: 'timeout' })
    expect(await s.send(req(3))).toEqual({ kind: 'ambiguous', errorCode: 'timeout' })
    expect(await s.send(req(4))).toMatchObject({ kind: 'not_dispatched' })
    expect(await s.send(req(5))).toMatchObject({ kind: 'rejected' })
    expect(s.calls).toHaveLength(5)
    expect(s.delivered.map((d) => d.request.effectId)).toEqual(['e1', 'e2'])
    s.script('accept_then_lose_response')
    await expect(s.send(req(6))).rejects.toThrow('response lost')
    expect(s.delivered).toHaveLength(3)
    expect(new Set(s.delivered.map((d) => d.providerMessageId)).size).toBe(3)
    const [x, y] = [await new MockEffectSender().script('accept').send(req(1)), await new MockEffectSender().script('accept').send(req(1))]
    expect(x).not.toEqual(y)                                    // separate doubles never reuse a provider id
  })
})

describe('no network, no provider SDK', () => {
  it('the messaging modules and the interpreter contain no network code or provider imports', () => {
    for (const file of ['versioned-messaging.ts', 'versioned-effects.ts', 'versioned-interpreter.ts', 'test-support/mock-sender.ts']) {
      const src = readFileSync(join(process.cwd(), 'src/lib/flows', file), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|require\(['"]https?['"]\)|axios|graph\.facebook|meta-send|send-message|engine['"]|whatsapp\/|manychat/i)
      expect(code, file).not.toMatch(/process\.env|access_token|SUPABASE_SERVICE_ROLE/)
    }
  })
})
