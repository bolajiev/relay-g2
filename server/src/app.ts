import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import type { Config } from './config'
import { ServiceError } from './errors'
import { RateLimiter, decryptSecret, encryptSecret } from './security'
import { draftReply } from '../../shared/loops'
import type { Account } from '../../shared/types'
import type { Store } from './store'
import { draftWithAI } from './services/ai'
import { transcribe } from './services/stt'
import { TelegramService } from './services/telegram'
import { pairPage } from './pages/pair'

export interface AppDeps {
  store: Store
  config: Config
  telegram?: TelegramService
  now?: () => number
}

function publicAccount(account: Account) {
  return {
    id: account.id,
    kind: account.kind,
    displayName: account.displayName,
    username: account.username,
    connected: Boolean(account.tgSessionEnc),
  }
}

function bearer(req: Request): string {
  const header = req.header('authorization') ?? ''
  return header.replace(/^Bearer\s+/i, '').trim()
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

export function createApp(deps: AppDeps): express.Express {
  const { store, config } = deps
  const now = deps.now ?? (() => Date.now())
  const telegram = deps.telegram ?? new TelegramService(config)
  const app = express()

  app.set('trust proxy', true)
  app.disable('x-powered-by')
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? '*' : (Array.isArray(config.corsOrigin) ? config.corsOrigin : config.corsOrigin.split(',').map(s => s.trim())),
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86400,
    }),
  )
  app.use(express.json({ limit: '4mb' }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const started = Date.now()
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) {
        console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`)
      }
    })
    next()
  })

  const auth = (req: Request, res: Response): Account | null => {
    const account = store.accountByToken(bearer(req))
    if (!account) {
      res.status(401).json({ error: 'unauthorized', message: 'Pair the glasses again or start a demo session.' })
      return null
    }
    return account
  }

  const pairStartLimit = new RateLimiter(10, 10 * 60_000)
  const pairVerifyLimit = new RateLimiter(20, 10 * 60_000)

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'relay',
      version: '0.1.0',
      time: new Date(now()).toISOString(),
      features: {
        demo: config.demoEnabled,
        telegram: config.telegram.enabled,
        llm: config.llm.enabled,
        stt: config.stt.enabled || Boolean(config.stt.localBin),
      },
      stats: store.stats(),
    })
  })

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Relay</title>
<body style="background:#0b0f0c;color:#b9ffcf;font:16px/1.5 ui-monospace,monospace;padding:48px;max-width:720px">
<h1 style="letter-spacing:.2em">RELAY</h1>
<p>Reply debt, cleared. A Telegram reply layer for Even G2.</p>
<ul>
<li><a style="color:#7dff9b" href="/pair">Pair page</a></li>
<li><a style="color:#7dff9b" href="/health">Health</a></li>
</ul>
<p style="color:#5e7a66">Demo mode is on: the glasses app creates a fictional inbox with no setup.</p>
</body>`)
  })

  app.get('/pair', (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code.replace(/\D/g, '').slice(0, 6) : ''
    res.type('html').send(pairPage({ code, telegramAvailable: config.telegram.enabled }))
  })

  app.post('/api/session/demo', (_req, res) => {
    if (!config.demoEnabled) {
      res.status(403).json({ error: 'demo_disabled' })
      return
    }
    const { account, token } = store.createDemoAccount(now())
    res.status(201).json({
      token,
      account: publicAccount(account),
      inbox: store.inbox(account.id, now()),
      features: { telegram: config.telegram.enabled, llm: config.llm.enabled, stt: config.stt.enabled, voiceDemo: config.demoVoice },
    })
  })

  app.get('/api/me', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    res.json({
      account: publicAccount(account),
      features: { telegram: config.telegram.enabled, llm: config.llm.enabled, stt: config.stt.enabled, voiceDemo: config.demoVoice },
    })
  })

  app.get('/api/inbox', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    res.json({ ...store.inbox(account.id, now()), serverTime: now() })
  })

  app.get('/api/loop/:id', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const detail = store.detail(account.id, req.params.id, now())
    if (!detail) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }
    res.json(detail)
  })

  app.post('/api/loop/:id/draft', async (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const detail = store.detail(account.id, req.params.id, now())
    if (!detail) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }
    const intent = typeof req.body?.intent === 'string' ? req.body.intent.trim().slice(0, 600) : undefined
    const rules = draftReply(detail.loop, intent)
    const ai = await draftWithAI(config, account, detail.loop, detail.messages, intent)
    res.json({ draft: ai ?? rules, provider: ai ? 'llm' : 'rules' })
  })

  app.post('/api/loop/:id/send', async (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const body = text(req.body?.text, 1200)
    if (!body) {
      res.status(400).json({ error: 'bad_text', message: 'Message must be 1–1200 characters.' })
      return
    }
    const detail = store.detail(account.id, req.params.id, now())
    if (!detail) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }

    let via: 'demo' | 'telegram' = 'demo'
    if (account.tgSessionEnc) {
      const plain = decryptSecret(account.tgSessionEnc, config.sessionKey)
      const peer = store.threads(account.id).find(t => t.id === req.params.id)?.tgPeer
      if (!peer) {
        res.status(409).json({ error: 'missing_peer' })
        return
      }
      try {
        await telegram.send(account.id, plain, peer, body)
        via = 'telegram'
      } catch (err) {
        if (err instanceof ServiceError) {
          res.status(err.status).json({ error: err.code, message: err.message })
          return
        }
        res.status(502).json({ error: 'telegram_send_failed', message: err instanceof Error ? err.message : 'send failed' })
        return
      }
    }

    const result = store.send(account.id, req.params.id, body, now())
    if (!result) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }
    res.json({ ok: true, via, sentAt: result.message.at, remaining: result.remaining })
  })

  app.post('/api/loop/:id/snooze', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const minutes = Math.max(5, Math.min(10_080, numberValue(req.body?.minutes, 180)))
    const ok = store.snooze(account.id, req.params.id, minutes, now())
    if (!ok) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }
    res.json({ ok: true, minutes, inbox: store.inbox(account.id, now()) })
  })

  app.post('/api/loop/:id/mute', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const muted = Boolean(req.body?.muted)
    const ok = store.setMuted(account.id, req.params.id, muted)
    if (!ok) {
      res.status(404).json({ error: 'loop_not_found' })
      return
    }
    res.json({ ok: true, muted, inbox: store.inbox(account.id, now()) })
  })

  app.get('/api/digest', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    res.json({ items: store.digest(account.id, now()) })
  })

  app.post('/api/transcribe', async (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const demoUtterance = typeof req.body?.demoUtterance === 'string' ? req.body.demoUtterance.trim().slice(0, 300) : ''
    if (demoUtterance && account.kind === 'demo' && config.demoVoice) {
      res.json({ text: demoUtterance, provider: 'demo' })
      return
    }
    if (typeof req.body?.pcm !== 'string' || !req.body.pcm) {
      res.status(400).json({ error: 'no_audio' })
      return
    }
    const pcm = Buffer.from(req.body.pcm, 'base64')
    if (pcm.length < 1600 || pcm.length > 1_500_000 || pcm.length % 2 !== 0) {
      res.status(400).json({ error: 'bad_audio', message: 'Send 16 kHz signed 16-bit mono PCM.' })
      return
    }
    const sampleRate = Math.max(8_000, Math.min(48_000, numberValue(req.body?.sampleRate, 16_000)))
    const result = await transcribe(config, pcm, sampleRate)
    if (!result) {
      res.status(503).json({
        error: 'stt_not_configured',
        message: 'Add an STT key (OPENAI_API_KEY) or a WHISPER_BIN, or use demo voice.',
      })
      return
    }
    res.json(result)
  })

  app.post('/api/demo/reset', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    store.resetDemo(account.id, now())
    res.json({ ok: true, inbox: store.inbox(account.id, now()) })
  })

  app.get('/api/export', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    res.json({
      account: publicAccount(account),
      threads: store.threads(account.id),
      messages: store.messages(account.id),
      loops: store.inbox(account.id, now()).loops,
    })
  })

  app.delete('/api/account', async (req, res) => {
    const account = auth(req, res)
    if (!account) return
    await telegram.disconnect(account.id)
    store.deleteAccount(account.id)
    res.json({ ok: true })
  })

  app.post('/api/pair/new', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const pair = store.createPairCode(account.id, now())
    res.json({
      code: pair.code,
      expiresAt: pair.expiresAt,
      pairUrl: `${config.publicUrl}/pair?code=${pair.code}`,
      telegramAvailable: config.telegram.enabled,
    })
  })

  app.get('/api/pair/:code', (req, res) => {
    const account = auth(req, res)
    if (!account) return
    const rec = store.getPair(req.params.code, now())
    if (!rec || rec.accountId !== account.id) {
      res.status(410).json({ error: 'pair_expired' })
      return
    }
    res.json({
      status: rec.connectedAt ? 'connected' : 'waiting',
      expiresAt: rec.expiresAt,
      telegramAvailable: config.telegram.enabled,
    })
  })

  app.post('/api/pair/:code/telegram/start', async (req, res) => {
    if (!pairStartLimit.allow(clientKey(req))) {
      res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait a minute.' })
      return
    }
    const rec = store.getPair(req.params.code, now())
    if (!rec) {
      res.status(410).json({ error: 'pair_expired' })
      return
    }
    const phone = text(req.body?.phone, 32)
    if (!phone) {
      res.status(400).json({ error: 'bad_phone' })
      return
    }
    try {
      const result = await telegram.startLogin(rec.code, phone)
      res.json({ ok: true, ...result })
    } catch (err) {
      if (err instanceof ServiceError) {
        res.status(err.status).json({ error: err.code, message: err.message })
        return
      }
      throw err
    }
  })

  app.post('/api/pair/:code/telegram/verify', async (req, res) => {
    if (!pairVerifyLimit.allow(clientKey(req))) {
      res.status(429).json({ error: 'rate_limited' })
      return
    }
    const rec = store.getPair(req.params.code, now())
    if (!rec) {
      res.status(410).json({ error: 'pair_expired' })
      return
    }
    const phoneCode = text(req.body?.phoneCode, 12)
    if (!phoneCode) {
      res.status(400).json({ error: 'bad_code' })
      return
    }
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : undefined
    try {
      const result = await telegram.verify(rec.accountId, rec.code, phoneCode, password)
      if (result.status === 'password') {
        res.json({ status: 'password', hint: result.hint ?? null })
        return
      }
      const sessionEnc = encryptSecret(result.session, config.sessionKey)
      store.setTelegram(rec.accountId, {
        sessionEnc,
        tgUserId: result.profile.id,
        tgName: result.profile.name,
        username: result.profile.username,
        styleSamples: result.snapshot.styleSamples,
      })
      if (result.snapshot.threads.length) {
        store.replaceSnapshot(rec.accountId, result.snapshot.threads, result.snapshot.messages)
      }
      store.markPairConnected(rec.code, now())
      res.json({
        status: 'connected',
        profile: result.profile,
        synced: { threads: result.snapshot.threads.length, messages: result.snapshot.messages.length },
      })
    } catch (err) {
      if (err instanceof ServiceError) {
        res.status(err.status).json({ error: err.code, message: err.message })
        return
      }
      throw err
    }
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceError) {
      res.status(err.status).json({ error: err.code, message: err.message })
      return
    }
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error('[relay] unhandled:', message)
    res.status(500).json({ error: 'internal_error' })
  })

  return app
}
