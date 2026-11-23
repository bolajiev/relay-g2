import 'dotenv/config'
import crypto from 'node:crypto'
import path from 'node:path'

export interface Config {
  port: number
  dataFile: string
  publicUrl: string
  sessionKey: Buffer
  demoEnabled: boolean
  corsOrigin: string | string[]
  telegram: { enabled: boolean; apiId: number; apiHash: string }
  llm: { enabled: boolean; baseUrl: string; apiKey: string; model: string }
  stt: { enabled: boolean; baseUrl: string; apiKey: string; model: string; localBin: string }
  demoVoice: boolean
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionKeyRaw = env.SESSION_KEY ?? ''
  let sessionKey: Buffer
  if (/^[0-9a-f]{64}$/i.test(sessionKeyRaw)) {
    sessionKey = Buffer.from(sessionKeyRaw, 'hex')
  } else {
    // Stable dev key so restarts can still decrypt local sessions. Never use in prod.
    sessionKey = crypto.createHash('sha256').update(sessionKeyRaw || 'relay-local-dev-only').digest()
    if (env.NODE_ENV === 'production') {
      console.warn('[relay] SESSION_KEY missing in production — refusing to store Telegram sessions.')
    }
  }

  const apiId = Number(env.TG_API_ID ?? 0)
  const apiHash = env.TG_API_HASH ?? ''
  const llmKey = env.LLM_API_KEY ?? ''
  const sttKey = env.OPENAI_API_KEY ?? env.STT_API_KEY ?? ''

  return {
    port: Number(env.PORT ?? 8787),
    dataFile: path.resolve(env.DATA_FILE ?? 'server/data/db.json'),
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
    sessionKey,
    demoEnabled: bool(env.DEMO_ENABLED, true),
    corsOrigin: env.CORS_ORIGIN ?? '*',
    telegram: {
      enabled: Boolean(apiId && apiHash),
      apiId,
      apiHash,
    },
    llm: {
      enabled: Boolean(llmKey),
      baseUrl: (env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: llmKey,
      model: env.LLM_MODEL ?? 'gpt-4o-mini',
    },
    stt: {
      enabled: Boolean(sttKey),
      baseUrl: (env.STT_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey: sttKey,
      model: env.STT_MODEL ?? 'whisper-1',
      localBin: env.WHISPER_BIN ?? '',
    },
    demoVoice: bool(env.DEMO_VOICE, true),
  }
}
