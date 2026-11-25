import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildDigest, buildOpenLoops, countChannels } from '../../shared/loops'
import { createSeed } from '../../shared/seed'
import type { Account, AccountStats, DigestItem, Inbox, Loop, Message, Thread } from '../../shared/types'
import { hashToken, randomPairCode, randomToken } from './security'

interface TokenRecord {
  hash: string
  accountId: string
  createdAt: number
}

interface PairRecord {
  code: string
  accountId: string
  createdAt: number
  expiresAt: number
  connectedAt?: number
}

interface DB {
  version: 1
  accounts: Account[]
  threads: Thread[]
  messages: Message[]
  tokens: TokenRecord[]
  pairCodes: PairRecord[]
}

export interface SendResult {
  message: Message
  remaining: number
}

const EMPTY: DB = { version: 1, accounts: [], threads: [], messages: [], tokens: [], pairCodes: [] }
const emptyStats = (): AccountStats => ({ cleared: 0, sensitiveCleared: 0, totalResolveMs: 0, resolveSamples: 0, paperDeRisks: 0 })
const PAIR_TTL_MS = 10 * 60 * 1000

export class Store {
  private db: DB
  private readonly memory: boolean

  constructor(
    private readonly filePath: string,
    options: { memory?: boolean } = {},
  ) {
    this.memory = options.memory ?? false
    this.db = this.load()
  }

  private load(): DB {
    if (this.memory) return structuredClone(EMPTY)
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as DB
      if (parsed.version !== 1) throw new Error('unsupported db version')
      return { ...structuredClone(EMPTY), ...parsed }
    } catch {
      return structuredClone(EMPTY)
    }
  }

  private save(): void {
    if (this.memory) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2))
    fs.renameSync(tmp, this.filePath)
  }

  createDemoAccount(now = Date.now()): { account: Account; token: string } {
    const account: Account = {
      id: `acc_${crypto.randomBytes(8).toString('hex')}`,
      kind: 'demo',
      displayName: 'Demo',
      username: 'you',
      createdAt: now,
      styleSamples: [],
      stats: emptyStats(),
      paperPositions: [],
    }
    const seed = createSeed(account.id, now)
    account.styleSamples = seed.styleSamples
    this.db.accounts.push(account)
    this.db.threads.push(...seed.threads)
    this.db.messages.push(...seed.messages)
    const token = this.issueToken(account.id, now)
    this.save()
    return { account, token }
  }

  issueToken(accountId: string, now = Date.now()): string {
    const token = randomToken()
    this.db.tokens.push({ hash: hashToken(token), accountId, createdAt: now })
    this.save()
    return token
  }

  accountByToken(token: string | undefined): Account | null {
    if (!token) return null
    const hash = hashToken(token)
    const rec = this.db.tokens.find(t => t.hash === hash)
    if (!rec) return null
    return this.db.accounts.find(a => a.id === rec.accountId) ?? null
  }

  account(accountId: string): Account | null {
    return this.db.accounts.find(a => a.id === accountId) ?? null
  }

  threads(accountId: string): Thread[] {
    return this.db.threads.filter(t => t.accountId === accountId)
  }

  messages(accountId: string): Message[] {
    const ids = new Set(this.threads(accountId).map(t => t.id))
    return this.db.messages.filter(m => ids.has(m.threadId))
  }

  inbox(accountId: string, now = Date.now()): Inbox {
    const threads = this.threads(accountId)
    const messages = this.messages(accountId)
    const all = buildOpenLoops(threads, messages, now)
    const account = this.account(accountId)
    return {
      loops: all.filter(l => l.status === 'open'),
      snoozed: all.filter(l => l.status === 'snoozed').length,
      channels: countChannels(threads),
      demo: account?.kind === 'demo',
      connected: Boolean(account?.tgSessionEnc || account?.botTokenEnc),
    }
  }

  detail(accountId: string, threadId: string, now = Date.now()): { loop: Loop; messages: Message[] } | null {
    const thread = this.db.threads.find(t => t.id === threadId && t.accountId === accountId)
    if (!thread) return null
    if (!thread.viewedAt) {
      thread.viewedAt = now
      this.save()
    }
    const messages = this.db.messages.filter(m => m.threadId === threadId).sort((a, b) => a.at - b.at)
    const loop = buildOpenLoops([thread], messages, now)[0]
    if (!loop) return null
    return { loop, messages: messages.slice(-4) }
  }

  send(accountId: string, threadId: string, text: string, now = Date.now(), loop?: Loop | null): SendResult | null {
    const thread = this.db.threads.find(t => t.id === threadId && t.accountId === accountId)
    if (!thread) return null
    if (thread.snoozedUntil) delete thread.snoozedUntil
    const resolveMs = thread.viewedAt ? Math.max(0, now - thread.viewedAt) : 0
    delete thread.viewedAt
    const message: Message = {
      id: `m_${crypto.randomBytes(6).toString('hex')}`,
      threadId,
      direction: 'out',
      author: 'You',
      text,
      at: now,
    }
    this.db.messages.push(message)
    thread.lastMessageAt = now
    const account = this.account(accountId)
    if (account) {
      const stats = (account.stats ??= emptyStats())
      stats.cleared += 1
      if (loop?.sensitivity === 'sensitive') stats.sensitiveCleared += 1
      if (resolveMs > 0) {
        stats.totalResolveMs += resolveMs
        stats.resolveSamples += 1
      }
    }
    this.save()
    const inbox = this.inbox(accountId, now)
    return { message, remaining: inbox.loops.length }
  }

  snooze(accountId: string, threadId: string, minutes: number, now = Date.now()): boolean {
    const thread = this.db.threads.find(t => t.id === threadId && t.accountId === accountId)
    if (!thread) return false
    thread.snoozedUntil = now + Math.max(1, Math.min(minutes, 60 * 24 * 7)) * 60_000
    this.save()
    return true
  }

  paperPosition(accountId: string, asset: string): import('../../shared/types').PaperPosition | null {
    const account = this.account(accountId)
    return account?.paperPositions?.find(p => p.asset === asset) ?? null
  }

  setPaperPosition(accountId: string, position: import('../../shared/types').PaperPosition): void {
    const account = this.account(accountId)
    if (!account) return
    account.paperPositions ??= []
    const idx = account.paperPositions.findIndex(p => p.id === position.id)
    if (idx >= 0) account.paperPositions[idx] = position
    else account.paperPositions.push(position)
    this.save()
  }

  recordPaperDeRisk(accountId: string): void {
    const account = this.account(accountId)
    if (!account) return
    const stats = (account.stats ??= emptyStats())
    stats.paperDeRisks = (stats.paperDeRisks ?? 0) + 1
    this.save()
  }

  setVip(accountId: string, threadId: string, vip: boolean): boolean {
    const thread = this.db.threads.find(t => t.id === threadId && t.accountId === accountId)
    if (!thread) return false
    thread.vip = vip
    thread.priority = vip ? 3 : thread.priority
    this.save()
    return true
  }

  stats(accountId: string): { cleared: number; sensitiveCleared: number; avgResolveMs: number; resolveSamples: number; openLoops: number; snoozed: number } {
    const account = this.account(accountId)
    const s = account?.stats ?? emptyStats()
    const inbox = this.inbox(accountId)
    return {
      cleared: s.cleared,
      sensitiveCleared: s.sensitiveCleared,
      avgResolveMs: s.resolveSamples ? Math.round(s.totalResolveMs / s.resolveSamples) : 0,
      resolveSamples: s.resolveSamples,
      openLoops: inbox.loops.length,
      snoozed: inbox.snoozed,
    }
  }

  setMuted(accountId: string, threadId: string, muted: boolean): boolean {
    const thread = this.db.threads.find(t => t.id === threadId && t.accountId === accountId)
    if (!thread) return false
    thread.muted = muted
    this.save()
    return true
  }

  digest(accountId: string, now = Date.now()): DigestItem[] {
    return buildDigest(this.threads(accountId), this.messages(accountId), now)
  }

  resetDemo(accountId: string, now = Date.now()): boolean {
    const account = this.account(accountId)
    if (!account) return false
    const oldIds = new Set(this.db.threads.filter(t => t.accountId === accountId).map(t => t.id))
    this.db.threads = this.db.threads.filter(t => t.accountId !== accountId)
    this.db.messages = this.db.messages.filter(m => !oldIds.has(m.threadId))
    const seed = createSeed(accountId, now)
    this.db.threads.push(...seed.threads)
    this.db.messages.push(...seed.messages)
    account.styleSamples = seed.styleSamples
    account.stats = emptyStats()
    account.paperPositions = []
    account.kind = 'demo'
    delete account.tgSessionEnc
    delete account.tgUserId
    delete account.tgName
    delete account.botTokenEnc
    delete account.botId
    delete account.botName
    this.save()
    return true
  }

  createPairCode(accountId: string, now = Date.now()): PairRecord {
    const code = randomPairCode()
    const record: PairRecord = { code, accountId, createdAt: now, expiresAt: now + PAIR_TTL_MS }
    this.db.pairCodes = this.db.pairCodes.filter(p => p.expiresAt > now && p.accountId !== accountId)
    this.db.pairCodes.push(record)
    this.save()
    return record
  }

  getPair(code: string, now = Date.now()): PairRecord | null {
    const rec = this.db.pairCodes.find(p => p.code === code)
    if (!rec || rec.expiresAt <= now) return null
    return rec
  }

  markPairConnected(code: string, now = Date.now()): boolean {
    const rec = this.getPair(code, now)
    if (!rec) return false
    rec.connectedAt = now
    this.save()
    return true
  }

  setBot(accountId: string, input: { tokenEnc: string; botId: string; botName: string }): boolean {
    const account = this.account(accountId)
    if (!account) return false
    account.kind = 'bot'
    account.botTokenEnc = input.tokenEnc
    account.botId = input.botId
    account.botName = input.botName
    delete account.tgSessionEnc
    delete account.tgUserId
    delete account.tgName
    this.save()
    return true
  }

  setTelegram(
    accountId: string,
    input: { sessionEnc: string; tgUserId: string; tgName: string; username?: string; styleSamples?: string[] },
  ): boolean {
    const account = this.account(accountId)
    if (!account) return false
    account.kind = 'telegram'
    delete account.botTokenEnc
    delete account.botId
    delete account.botName
    account.tgSessionEnc = input.sessionEnc
    account.tgUserId = input.tgUserId
    account.tgName = input.tgName
    if (input.styleSamples?.length) account.styleSamples = input.styleSamples.slice(0, 12)
    this.save()
    return true
  }

  replaceSnapshot(accountId: string, threads: Thread[], messages: Message[]): void {
    const oldIds = new Set(this.db.threads.filter(t => t.accountId === accountId).map(t => t.id))
    this.db.threads = this.db.threads.filter(t => t.accountId !== accountId)
    this.db.messages = this.db.messages.filter(m => !oldIds.has(m.threadId))
    this.db.threads.push(...threads)
    this.db.messages.push(...messages)
    this.save()
  }

  deleteAccount(accountId: string): boolean {
    const before = this.db.accounts.length
    this.db.accounts = this.db.accounts.filter(a => a.id !== accountId)
    const ids = new Set(this.db.threads.filter(t => t.accountId === accountId).map(t => t.id))
    this.db.threads = this.db.threads.filter(t => t.accountId !== accountId)
    this.db.messages = this.db.messages.filter(m => !ids.has(m.threadId))
    this.db.tokens = this.db.tokens.filter(t => t.accountId !== accountId)
    this.db.pairCodes = this.db.pairCodes.filter(p => p.accountId !== accountId)
    this.save()
    return this.db.accounts.length !== before
  }

  counts(): { accounts: number; threads: number; messages: number } {
    return { accounts: this.db.accounts.length, threads: this.db.threads.length, messages: this.db.messages.length }
  }
}
