import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeCallingPeerConnection,
  createAudioPeerConnection,
  readLocalSdp,
  stopCallingMediaStream,
  waitForIceGatheringComplete,
} from './calling-webrtc'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Calling WebRTC helpers', () => {
  it('resolves immediately when ICE gathering is already complete', async () => {
    const pc = { iceGatheringState: 'complete' } as RTCPeerConnection
    await expect(waitForIceGatheringComplete(pc)).resolves.toBeUndefined()
  })

  it('waits for the ICE gathering complete event', async () => {
    let listener: (() => void) | undefined
    const pc = {
      iceGatheringState: 'gathering',
      addEventListener: vi.fn((_name: string, callback: () => void) => { listener = callback }),
      removeEventListener: vi.fn(),
    } as unknown as RTCPeerConnection

    const waiting = waitForIceGatheringComplete(pc, 1000)
    Object.defineProperty(pc, 'iceGatheringState', { value: 'complete', configurable: true })
    listener?.()

    await expect(waiting).resolves.toBeUndefined()
    expect(pc.removeEventListener).toHaveBeenCalledWith('icegatheringstatechange', expect.any(Function))
  })

  it('fails with a bounded timeout when ICE never completes', async () => {
    vi.useFakeTimers()
    const pc = {
      iceGatheringState: 'gathering',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as RTCPeerConnection

    const waiting = waitForIceGatheringComplete(pc, 250)
    const assertion = expect(waiting).rejects.toThrow('call_ice_gathering_timeout')
    await vi.advanceTimersByTimeAsync(250)
    await assertion
    expect(pc.removeEventListener).toHaveBeenCalled()
  })

  it('creates an audio-only peer connection and forwards remote tracks/state', () => {
    const remoteStream = { getTracks: () => [] } as unknown as MediaStream
    const track = {} as MediaStreamTrack
    const pc = {
      ontrack: null as ((event: RTCTrackEvent) => void) | null,
      oniceconnectionstatechange: null as (() => void) | null,
      onconnectionstatechange: null as (() => void) | null,
      iceConnectionState: 'connected',
      connectionState: 'connected',
    }
    const constructor = vi.fn(() => pc)
    vi.stubGlobal('RTCPeerConnection', constructor)
    const onRemoteStream = vi.fn()
    const onConnectionState = vi.fn()

    const result = createAudioPeerConnection([], { onRemoteStream, onConnectionState })
    expect(constructor).toHaveBeenCalledWith({ iceServers: [] })
    pc.ontrack?.({ streams: [remoteStream], track } as unknown as RTCTrackEvent)
    pc.oniceconnectionstatechange?.()
    pc.onconnectionstatechange?.()
    expect(onRemoteStream).toHaveBeenCalledWith(remoteStream)
    expect(onConnectionState).toHaveBeenCalledWith('connected')
    expect(result).toBe(pc)
  })

  it('stops local tracks and closes the peer connection safely', () => {
    const stop = vi.fn()
    const stream = {
      getTracks: () => [
        { readyState: 'live', stop },
        { readyState: 'ended', stop: vi.fn() },
      ],
    } as unknown as MediaStream
    stopCallingMediaStream(stream)
    expect(stop).toHaveBeenCalledTimes(1)

    const close = vi.fn()
    const pc = {
      signalingState: 'stable',
      ontrack: vi.fn(),
      oniceconnectionstatechange: vi.fn(),
      onconnectionstatechange: vi.fn(),
      close,
    } as unknown as RTCPeerConnection
    closeCallingPeerConnection(pc)
    expect(pc.ontrack).toBeNull()
    expect(pc.oniceconnectionstatechange).toBeNull()
    expect(pc.onconnectionstatechange).toBeNull()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not close a peer connection that is already closed', () => {
    const close = vi.fn()
    const pc = { signalingState: 'closed', close } as unknown as RTCPeerConnection
    closeCallingPeerConnection(pc)
    expect(close).not.toHaveBeenCalled()
  })

  it('returns only a valid local SDP of the expected type', () => {
    const pc = {
      localDescription: { type: 'offer', sdp: 'v=0\r\n' },
    } as RTCPeerConnection
    expect(readLocalSdp(pc, 'offer')).toBe('v=0\r\n')
    expect(() => readLocalSdp(pc, 'answer')).toThrow('call_local_answer_unavailable')
  })
})
