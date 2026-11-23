import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from '../config'

/** Wrap raw signed 16-bit little-endian mono PCM in a WAV container. */
export function pcmToWav(pcm: Buffer, sampleRate = 16_000): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function openAiTranscribe(config: Config, pcm: Buffer, sampleRate: number): Promise<string | null> {
  const wav = pcmToWav(pcm, sampleRate)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', config.stt.model)
  form.append('language', 'en')
  form.append('response_format', 'json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stt.apiKey}` },
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn('[relay] stt http', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { text?: string }
    return data.text?.trim() || null
  } catch (err) {
    console.warn('[relay] stt failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

function localTranscribe(bin: string, pcm: Buffer, sampleRate: number): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stt-'))
  const wav = path.join(dir, 'audio.wav')
  const outBase = path.join(dir, 'audio')
  fs.writeFileSync(wav, pcmToWav(pcm, sampleRate))
  try {
    const model = process.env.WHISPER_MODEL ?? 'models/ggml-base.en.bin'
    const run = spawnSync(bin, ['-m', model, '-f', wav, '-nt', '-otxt', '-of', outBase], {
      timeout: 60_000,
      encoding: 'utf8',
    })
    if (run.status !== 0) {
      console.warn('[relay] local stt failed', run.stderr?.slice(0, 200))
      return null
    }
    const text = fs.readFileSync(`${outBase}.txt`, 'utf8')
    return text.replace(/\[[^\]]*\]/g, '').trim() || null
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface SttResult {
  text: string
  provider: 'openai' | 'local'
}

export async function transcribe(
  config: Config,
  pcm: Buffer,
  sampleRate = 16_000,
): Promise<SttResult | null> {
  if (config.stt.localBin) {
    const text = localTranscribe(config.stt.localBin, pcm, sampleRate)
    if (text) return { text, provider: 'local' }
  }
  if (config.stt.enabled) {
    const text = await openAiTranscribe(config, pcm, sampleRate)
    if (text) return { text, provider: 'openai' }
  }
  return null
}
