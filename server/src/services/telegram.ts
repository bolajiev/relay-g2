import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { Config } from '../config'
import { ServiceError } from '../errors'

/* The GramJS package is CommonJS and only needed when live Telegram is used.
 * Loading it lazily keeps demo mode fast and dependency-light at runtime. */
type AnyClient = {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  invoke: (req: unknown) => Promise<unknown>
  sendCode: (creds: { apiId: number; apiHash: string }, phone: string) => Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }>
  signInWithPassword: (
    creds: { apiId: number; apiHash: string },
    params: { password: () => Promise<string>; onError: () => Promise<boolean> },
  ) => Promise<unknown>
  getMe: () => Promise<{ id?: { toString(): string }; firstName?: string; lastName?: string; username?: string }>
  getDialogs: (params: { limit: number }) => Promise<TelegramDialog[]>
  getMessages: (entity: unknown, params: { limit: number }) => Promise<TelegramMessage[]>
  sendMessage: (entity: unknown, params: { message: string }) => Promise<unknown>
  markAsRead: (entity: unknown) => Promise<unknown>
  getInputEntity: (peer: string) => Promise<unknown>
  session: { save: () => string }
}

interface TelegramDialog {
  title?: string
  name?: string
  isChannel?: boolean
  isGroup?: boolean
  isUser?: boolean
  entity?: {
    id?: { toString(): string } | number | string
    username?: string
    bot?: boolean
    self?: boolean
    title?: string
    firstName?: string
    lastName?: string
  }
}

interface TelegramMessage {
  id?: number
  message?: string
  out?: boolean
  date?: number | Date
  sender?: { firstName?: string; lastName?: string; title?: string; username?: string }
  senderId?: { toString(): string } | number | string
}

interface GramModule {
  TelegramClient: new (session: unknown, apiId: number, apiHash: string, opts: Record<string, unknown>) => AnyClient
  Api: {
    auth: { SignIn: new (args: Record<string, unknown>) => unknown }
    account: { GetPassword: new () => unknown }
  }
}

export interface TelegramSnapshot {
  threads: Array<{
    id: string
    accountId: string
    title: string
    kind: 'dm' | 'group' | 'channel'
    priority: 1 | 2 | 3
    muted: boolean
    tgPeer: string
    lastMessageAt: number
  }>
  messages: Array<{
    id: string
    threadId: string
    direction: 'in' | 'out'
    author: string
    text: string
    at: number
    tgMessageId?: string
  }>
  styleSamples: string[]
}

interface PendingLogin {
  client: AnyClient
  phone: string
  phoneCodeHash: string
  needsPassword: boolean
  createdAt: number
}

const PENDING_TTL_MS = 10 * 60 * 1000
const require = createRequire(import.meta.url)

function hash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 18)
}

function dateMs(value: number | Date | undefined): number {
  if (!value) return Date.now()
  if (value instanceof Date) return value.getTime()
  return value < 1e12 ? value * 1000 : value
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Telegram request failed'
}

function isPasswordNeeded(err: unknown): boolean {
  return /SESSION_PASSWORD_NEEDED/i.test(errorMessage(err))
}

function authorOf(m: TelegramMessage): string {
  const s = m.sender
  if (!s) return 'Telegram'
  return s.title || [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || 'Telegram'
}

export class TelegramService {
  private pending = new Map<string, PendingLogin>()
  private clients = new Map<string, AnyClient>()
  private gram: GramModule | null = null;
  private StringSession: (new (session?: string) => { save(): string }) | null = null

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return this.config.telegram.enabled
  }

  private async load(): Promise<{ gram: GramModule; StringSession: new (session?: string) => { save(): string } }> {
    if (!this.gram || !this.StringSession) {
      const gramPath = require.resolve('telegram')
      const sessionsPath = require.resolve('telegram/sessions/index.js')
      const gram = (await import(gramPath)) as unknown as GramModule & { default?: GramModule }
      const sessions = (await import(sessionsPath)) as { StringSession: new (session?: string) => { save(): string } }
      this.gram = gram.TelegramClient ? gram : (gram.default as GramModule)
      this.StringSession = sessions.StringSession
    }
    return { gram: this.gram, StringSession: this.StringSession }
  }

  private async newClient(session = ''): Promise<AnyClient> {
    const { gram, StringSession } = await this.load()
    const client = new gram.TelegramClient(new StringSession(session), this.config.telegram.apiId, this.config.telegram.apiHash, {
      connectionRetries: 2,
      useWSS: true,
      deviceModel: 'Relay G2',
      systemVersion: '1.0.0',
      appVersion: '0.1.0',
      langCode: 'en',
    })
    await client.connect()
    return client
  }

  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [code, p] of this.pending) {
      if (p.createdAt < cutoff) {
        p.client.disconnect().catch(() => undefined)
        this.pending.delete(code)
      }
    }
  }

  async startLogin(code: string, phoneRaw: string): Promise<{ isCodeViaApp: boolean }> {
    if (!this.enabled) throw new ServiceError(503, 'telegram_not_configured', 'Set TG_API_ID and TG_API_HASH.')
    this.sweep()
    const phone = phoneRaw.replace(/[\s()-]/g, '')
    if (!/^\+?[0-9]{7,15}$/.test(phone)) throw new ServiceError(400, 'bad_phone', 'Use international format, e.g. +971501234567.')
    const existing = this.pending.get(code)
    if (existing) await existing.client.disconnect().catch(() => undefined)

    const client = await this.newClient()
    try {
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
        { apiId: this.config.telegram.apiId, apiHash: this.config.telegram.apiHash },
        phone,
      )
      this.pending.set(code, { client, phone, phoneCodeHash, needsPassword: false, createdAt: Date.now() })
      return { isCodeViaApp }
    } catch (err) {
      await client.disconnect().catch(() => undefined)
      throw new ServiceError(400, 'telegram_send_code_failed', errorMessage(err))
    }
  }

  async verify(
    accountId: string,
    code: string,
    phoneCode: string,
    password?: string,
  ): Promise<{ status: 'ok'; session: string; profile: { id: string; name: string; username?: string }; snapshot: TelegramSnapshot } | { status: 'password'; hint?: string }> {
    this.sweep()
    const pending = this.pending.get(code)
    if (!pending) throw new ServiceError(410, 'pair_expired', 'Pairing expired. Generate a new code.')

    const { gram } = await this.load()
    if (!pending.needsPassword) {
      try {
        await pending.client.invoke(
          new gram.Api.auth.SignIn({
            phoneNumber: pending.phone,
            phoneCodeHash: pending.phoneCodeHash,
            phoneCode: phoneCode.replace(/\s/g, ''),
          }),
        )
      } catch (err) {
        if (!isPasswordNeeded(err)) {
          throw new ServiceError(400, 'telegram_code_invalid', errorMessage(err))
        }
        pending.needsPassword = true
      }
    }

    if (pending.needsPassword) {
      if (!password) {
        let hint: string | undefined
        try {
          const pwd = (await pending.client.invoke(new gram.Api.account.GetPassword())) as { hint?: string }
          hint = pwd.hint
        } catch {
          hint = undefined
        }
        return { status: 'password', hint }
      }
      try {
        await pending.client.signInWithPassword(
          { apiId: this.config.telegram.apiId, apiHash: this.config.telegram.apiHash },
          { password: async () => password, onError: async () => true },
        )
      } catch (err) {
        throw new ServiceError(400, 'telegram_password_invalid', errorMessage(err))
      }
    }

    const me = await pending.client.getMe()
    const profile = {
      id: String(me.id ?? ''),
      name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || 'Telegram user',
      username: me.username,
    }
    const snapshot = await this.snapshot(pending.client, accountId)
    const session = pending.client.session.save()
    this.pending.delete(code)
    this.clients.set(accountId, pending.client)
    return { status: 'ok', session, profile, snapshot }
  }

  async snapshot(client: AnyClient, accountId: string): Promise<TelegramSnapshot> {
    const threads: TelegramSnapshot['threads'] = []
    const messages: TelegramSnapshot['messages'] = []
    const style: string[] = []
    let dialogs: TelegramDialog[] = []
    try {
      dialogs = await client.getDialogs({ limit: 12 })
    } catch (err) {
      console.warn('[relay] telegram dialogs failed:', errorMessage(err))
      return { threads, messages, styleSamples: style }
    }

    for (const d of dialogs) {
      const entity = d.entity
      if (!entity || entity.bot || entity.self) continue
      const kind: 'dm' | 'group' | 'channel' = d.isChannel ? (d.isGroup ? 'group' : 'channel') : 'dm'
      const idPart = String(entity.id ?? '')
      if (!idPart) continue
      const threadId = `th_tg_${hash(`${accountId}:${idPart}`)}`
      const title = d.title || d.name || entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || 'Telegram'
      const peer = entity.username ? `@${entity.username}` : idPart

      let msgs: TelegramMessage[] = []
      try {
        msgs = await client.getMessages(entity, { limit: 7 })
      } catch {
        continue
      }
      const mapped = msgs
        .filter(m => Boolean(m.message?.trim()))
        .map(m => ({
          id: `m_tg_${hash(`${threadId}:${m.id ?? Math.random()}`)}`,
          threadId,
          direction: (m.out ? 'out' : 'in') as 'in' | 'out',
          author: m.out ? 'You' : authorOf(m),
          text: m.message!.trim(),
          at: dateMs(m.date),
          tgMessageId: m.id ? String(m.id) : undefined,
        }))
        .sort((a, b) => a.at - b.at)
      if (!mapped.length) continue

      for (const m of mapped) {
        if (m.direction === 'out') style.push(m.text)
      }
      threads.push({
        id: threadId,
        accountId,
        title,
        kind,
        priority: kind === 'dm' ? 3 : kind === 'group' ? 2 : 1,
        muted: false,
        tgPeer: peer,
        lastMessageAt: mapped[mapped.length - 1].at,
      })
      messages.push(...mapped)
    }

    return { threads, messages, styleSamples: style.slice(-12) }
  }

  private async clientFor(accountId: string, sessionEnc: string): Promise<AnyClient> {
    const cached = this.clients.get(accountId)
    if (cached) return cached
    const session = this.decryptSession(sessionEnc)
    const client = await this.newClient(session)
    this.clients.set(accountId, client)
    return client
  }

  private decryptSession(sessionEnc: string): string {
    // The service only needs the plaintext session; decryption stays in the route layer.
    return sessionEnc
  }

  async send(accountId: string, sessionPlain: string, peer: string, text: string): Promise<void> {
    if (!this.enabled) throw new ServiceError(503, 'telegram_not_configured', 'Telegram is not configured on this server.')
    const client = await this.clientFor(accountId, sessionPlain)
    let entity: unknown
    try {
      if (peer.startsWith('@')) entity = await client.getInputEntity(peer)
    } catch {
      entity = undefined
    }
    if (!entity) {
      const dialogs = await client.getDialogs({ limit: 100 })
      const match = dialogs.find(d => d.entity && String(d.entity.id) === peer)
      if (match?.entity) entity = match.entity
    }
    if (!entity) throw new ServiceError(404, 'telegram_peer_not_found', 'That chat is no longer available.')
    await client.sendMessage(entity, { message: text })
    try {
      await client.markAsRead(entity)
    } catch {
      /* read receipts are best-effort */
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const client = this.clients.get(accountId)
    if (client) {
      await client.disconnect().catch(() => undefined)
      this.clients.delete(accountId)
    }
  }
}

/** Keep TypeScript honest about unused imports in this adapter file. */
void path
void fs
