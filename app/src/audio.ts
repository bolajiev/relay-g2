import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

const MAX_BYTES = 16_000 * 2 * 20 // 20 seconds of 16 kHz s16 mono

/**
 * Accumulates raw PCM from the G2 mic while the user holds the ring.
 * The SDK emits 100 ms frames; we keep a rolling RMS history for the
 * waveform and the full buffer for one transcription call on release.
 */
export class MicCapture {
  private chunks: Uint8Array[] = []
  private bytes = 0
  private history: number[] = []
  private active = false
  private startAt = 0
  source: 'glasses' | 'phone' = 'glasses'
  lastFrameAt = 0

  async start(bridge: EvenAppBridge): Promise<void> {
    this.chunks = []
    this.bytes = 0
    this.history = []
    this.active = true
    this.startAt = Date.now()
    this.lastFrameAt = 0
    try {
      const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
      this.source = ok ? 'glasses' : 'phone'
      if (!ok) {
        await bridge.audioControl(true, AudioInputSource.Phone)
        this.source = 'phone'
      }
    } catch (err) {
      console.warn('RELAY audio start failed', err)
      this.source = 'phone'
      try {
        await bridge.audioControl(true, AudioInputSource.Phone)
      } catch {
        /* no mic available; demo fallback handles it */
      }
    }
  }

  push(frame: Uint8Array): void {
    if (!this.active || !frame.length) return
    if (this.bytes >= MAX_BYTES) return
    const copy = new Uint8Array(frame.length)
    copy.set(frame)
    this.chunks.push(copy)
    this.bytes += copy.length
    this.lastFrameAt = Date.now()
    this.history.push(rms(copy))
    if (this.history.length > 60) this.history.splice(0, this.history.length - 60)
  }

  bars(): number[] {
    return this.history.slice(-48)
  }

  get elapsedMs(): number {
    return this.startAt ? Date.now() - this.startAt : 0
  }

  get size(): number {
    return this.bytes
  }

  async stop(bridge: EvenAppBridge): Promise<Uint8Array> {
    this.active = false
    try {
      await bridge.audioControl(false)
    } catch {
      /* best effort */
    }
    const out = new Uint8Array(this.bytes)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    this.bytes = 0
    return out
  }

  cancel(): void {
    this.active = false
    this.chunks = []
    this.bytes = 0
    this.history = []
  }
}

export function rms(frame: Uint8Array): number {
  let sum = 0
  let count = 0
  for (let i = 0; i + 1 < frame.length; i += 8) {
    const v = (frame[i] | (frame[i + 1] << 8)) << 16 >> 16
    sum += v * v
    count += 1
  }
  if (!count) return 0
  return Math.sqrt(sum / count) / 32768
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
