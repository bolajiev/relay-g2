import { buildDigest, buildOpenLoops, countChannels, draftReply } from '../../shared/loops'
import { createSeed } from '../../shared/seed'
import type { DigestItem, Inbox, Loop, Message, Thread } from '../../shared/types'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}

export interface Features {
  telegram: boolean
  llm: boolean
  stt: boolean
  voiceDemo: boolean
}

export interface DraftResult {
  draft: string
  provider: 'llm' | 'rules'
}

export interface PairInfo {
  code: string
  expiresAt: number
  pairUrl: string
  telegramAvailable: boolean
}

const BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const TOKEN_KEY = 'relay.token'

/**
 * Local fallback so the app never shows a black screen or a dead end in
 * judging. It uses the same shared domain code as the server, just in memory.
 */
class LocalStore {
  private threads: Thread[]
  private messages: Message[]
  private now0: number

  constructor() {
    this.now0 = Date.now()
    const seed = createSeed('acc_local', this.now0)
    this.threads = seed.threads
    this.messages = seed.messages
  }

  inbox(): Inbox {
    const all = buildOpenLoops(this.threads, this.messages, Date.now())
    return {
      loops: all.filter(l => l.status === 'open'),
      snoozed: all.filter(l => l.status === 'snoozed').length,
      channels: countChannels(this.threads),
      demo: true,
      connected: false,
    }
  }

  detail(threadId: string): { loop: Loop; messages: Message[] } | null {
    const thread = this.threads.find(t => t.id === threadId)
    if (!thread) return null
    const messages = this.messages.filter(m => m.threadId === threadId).sort((a, b) => a.at - b.at)
    const loop = buildOpenLoops([thread], messages, Date.now())[0]
    if (!loop) return null
    return { loop, messages: messages.slice(-4) }
  }

  draft(threadId: string, intent?: string): DraftResult {
    const detail = this.detail(threadId)
    if (!detail) throw new ApiError(404, 'loop_not_found')
    return { draft: draftReply(detail.loop, intent, detail.loop.priority), provider: 'rules' }
  }

  send(threadId: string, text: string): { remaining: number } {
    const thread = this.threads.find(t => t.id === threadId)
    if (!thread) throw new ApiError(404, 'loop_not_found')
    if (thread.snoozedUntil) delete thread.snoozedUntil
    this.messages.push({
      id: `m_local_${Math.random().toString(36).slice(2)}`,
      threadId,
      direction: 'out',
      author: 'You',
      text,
      at: Date.now(),
    })
    thread.lastMessageAt = Date.now()
    return { remaining: this.inbox().loops.length }
  }

  snooze(threadId: string, minutes: number): void {
    const thread = this.threads.find(t => t.id === threadId)
    if (!thread) throw new ApiError(404, 'loop_not_found')
    thread.snoozedUntil = Date.now() + minutes * 60_000
  }

  digest(): DigestItem[] {
    return buildDigest(this.threads, this.messages, Date.now())
  }
}

export class RelayApi {
  token = localStorage.getItem(TOKEN_KEY) ?? ''
  offline = false
  demo = true
  features: Features = { telegram: false, llm: false, stt: false, voiceDemo: true }
  private local: LocalStore | null = null

  private localStore(): LocalStore {
    if (!this.local) this.local = new LocalStore()
    return this.local
  }

  private setToken(token: string): void {
    this.token = token
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* private mode */
    }
  }

  private clearToken(): void {
    this.token = ''
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, signal: controller.signal })
      const raw = await res.text()
      let data: any = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }
      if (!res.ok) {
        throw new ApiError(res.status, data?.error ?? 'http_error', data?.message ?? `Request failed (${res.status})`)
      }
      return data as T
    } catch (err) {
      if (err instanceof ApiError) throw err
      throw new ApiError(0, 'offline', 'Relay server unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  async boot(): Promise<Inbox> {
    if (location.search.includes('fresh=1')) this.clearToken()
    if (this.token) {
      try {
        const inbox = await this.request<Inbox>('/api/inbox', {}, 6_000)
        this.demo = inbox.demo
        this.offline = false
        return inbox
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          this.clearToken()
        } else {
          this.offline = true
          this.demo = true
          return this.localStore().inbox()
        }
      }
    }

    try {
      const res = await this.request<{ token: string; inbox: Inbox; features: Features; account: { kind: string } }>(
        '/api/session/demo',
        { method: 'POST' },
        6_000,
      )
      this.setToken(res.token)
      this.demo = res.account.kind === 'demo'
      if (res.features) this.features = res.features
      return res.inbox
    } catch {
      this.offline = true
      this.demo = true
      return this.localStore().inbox()
    }
  }

  async inbox(): Promise<Inbox> {
    if (this.offline) return this.localStore().inbox()
    const inbox = await this.request<Inbox>('/api/inbox', {}, 6_000)
    this.demo = inbox.demo
    return inbox
  }

  async detail(threadId: string): Promise<{ loop: Loop; messages: Message[] }> {
    if (this.offline) {
      const detail = this.localStore().detail(threadId)
      if (!detail) throw new ApiError(404, 'loop_not_found')
      return detail
    }
    return this.request(`/api/loop/${encodeURIComponent(threadId)}`, {}, 6_000)
  }

  async draft(threadId: string, intent?: string): Promise<DraftResult> {
    if (this.offline) return this.localStore().draft(threadId, intent)
    return this.request(`/api/loop/${encodeURIComponent(threadId)}/draft`, {
      method: 'POST',
      body: JSON.stringify({ intent }),
    }, 15_000)
  }

  async send(threadId: string, text: string): Promise<{ ok: boolean; remaining: number; via: string }> {
    if (this.offline) {
      const result = this.localStore().send(threadId, text)
      return { ok: true, remaining: result.remaining, via: 'offline' }
    }
    return this.request(`/api/loop/${encodeURIComponent(threadId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }, 15_000)
  }

  async snooze(threadId: string, minutes: number): Promise<Inbox> {
    if (this.offline) {
      this.localStore().snooze(threadId, minutes)
      return this.localStore().inbox()
    }
    const res = await this.request<{ inbox: Inbox }>(`/api/loop/${encodeURIComponent(threadId)}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    })
    return res.inbox
  }

  async digest(): Promise<DigestItem[]> {
    if (this.offline) return this.localStore().digest()
    const res = await this.request<{ items: DigestItem[] }>('/api/digest', {}, 6_000)
    return res.items
  }

  async transcribePcm(pcmBase64: string): Promise<{ text: string; provider: string }> {
    if (this.offline) throw new ApiError(0, 'offline')
    return this.request('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({ pcm: pcmBase64, sampleRate: 16_000 }),
    }, 30_000)
  }

  async transcribeDemo(utterance: string): Promise<{ text: string; provider: string }> {
    if (this.offline) return { text: utterance, provider: 'demo' }
    return this.request('/api/transcribe', {
      method: 'POST',
      body: JSON.stringify({ demoUtterance: utterance }),
    }, 8_000)
  }

  async pairNew(): Promise<PairInfo> {
    if (this.offline) throw new ApiError(0, 'offline', 'Pairing needs the Relay server.')
    return this.request('/api/pair/new', { method: 'POST' }, 6_000)
  }

  async pairStatus(code: string): Promise<{ status: 'waiting' | 'connected'; expiresAt: number }> {
    if (this.offline) throw new ApiError(0, 'offline')
    return this.request(`/api/pair/${encodeURIComponent(code)}`, {}, 6_000)
  }

  async resetDemo(): Promise<Inbox> {
    if (this.offline) return this.localStore().inbox()
    const res = await this.request<{ inbox: Inbox }>('/api/demo/reset', { method: 'POST' }, 6_000)
    return res.inbox
  }
}
