export type CallingConnectionState =
  | RTCPeerConnectionState
  | RTCIceConnectionState

export interface AudioPeerConnectionCallbacks {
  onRemoteStream?: (stream: MediaStream) => void
  onConnectionState?: (state: CallingConnectionState) => void
}

/**
 * Create an audio-only peer connection. ICE servers are injected by the
 * caller; no TURN provider or static credentials are hard-coded here.
 */
export function createAudioPeerConnection(
  iceServers: RTCIceServer[] = [],
  callbacks: AudioPeerConnectionCallbacks = {},
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers })

  pc.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track])
    callbacks.onRemoteStream?.(stream)
  }
  pc.oniceconnectionstatechange = () => {
    callbacks.onConnectionState?.(pc.iceConnectionState)
  }
  pc.onconnectionstatechange = () => {
    callbacks.onConnectionState?.(pc.connectionState)
  }

  return pc
}

/** Resolve only after all local ICE candidates have been gathered. */
export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 12_000,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      pc.removeEventListener('icegatheringstatechange', handleStateChange)
      if (timeout !== undefined) clearTimeout(timeout)
    }

    const handleStateChange = () => {
      if (pc.iceGatheringState !== 'complete') return
      cleanup()
      resolve()
    }

    pc.addEventListener('icegatheringstatechange', handleStateChange)
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error('call_ice_gathering_timeout'))
    }, timeoutMs)

    // State may have changed between the initial check and listener setup.
    handleStateChange()
  })
}

/** Stop every local audio/video track without throwing on partially-ended streams. */
export function stopCallingMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    if (track.readyState !== 'ended') track.stop()
  }
}

/** Remove event handlers before closing so stale callbacks cannot update React state. */
export function closeCallingPeerConnection(pc: RTCPeerConnection | null | undefined): void {
  if (!pc) return
  pc.ontrack = null
  pc.oniceconnectionstatechange = null
  pc.onconnectionstatechange = null
  if (pc.signalingState !== 'closed') pc.close()
}

export function readLocalSdp(
  pc: RTCPeerConnection,
  expectedType: 'offer' | 'answer',
): string {
  const description = pc.localDescription
  if (!description || description.type !== expectedType || !description.sdp
    || description.sdp.length > 65_536 || !/^v=0(?:\r?\n)/.test(description.sdp)) {
    throw new Error(expectedType === 'offer' ? 'call_local_offer_unavailable' : 'call_local_answer_unavailable')
  }
  return description.sdp
}
