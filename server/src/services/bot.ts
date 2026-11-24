import crypto from 'node:crypto'
import type { Config } from '../config'
import { ServiceError } from '../errors'
import type { TelegramSnapshot } from './telegram'

interface BotUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface BotChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel' | string
  title?: string
  first_name?: string
  last_name?: string
  username?: string
}

interface BotMessage {
  message_id: number
  date: number
  text?: string
  chat: BotChat
  from?: BotUser
}

interface BotUpdate {
  update_id: number
  message?: BotMessage
}

function hash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 18)
}

/**
 * Bot API mode: a shared inbox for a Telegram bot/community.
 *
 * A bot cannot see a user's personal DMs (that is the MTProto user-session
 * path); it sees messages sent to the bot or to groups where the bot is a
 * member/admin. This mode is for team/community inboxes and for a live
 * Telegram read/write test without a phone login code.
 */
export class BotService {
  constructor(private readonly config: Config) {}

  private async call<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(`${this.config.botApiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: T; description?: string; error_code?: number }
        | null
      if (!res.ok || !data?.ok) {
        throw new ServiceError(400, 'bot_api_error', data?.description ?? `Bot API ${method} failed (${res.status})`)
      }
      return data.result as T
    } catch (err) {
      if (err instanceof ServiceError) throw err
      throw new ServiceError(502, 'bot_api_unreachable', err instanceof Error ? err.message : 'Bot API unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  async me(token: string): Promise<BotUser> {
    const me = await this.call<BotUser>(token, 'getMe')
    if (!me?.id) throw new ServiceError(400, 'bot_invalid', 'Bot token was not accepted by Telegram.')
    return me
  }

  async snapshot(token: string, accountId: string): Promise<TelegramSnapshot> {
    const me = await this.me(token)
    const updates = await this.call<BotUpdate[]>(token, 'getUpdates', {
      timeout: 0,
      allowed_updates: ['message'],
    })

    const threads = new Map<string, TelegramSnapshot['threads'][number]>()
    const messages: TelegramSnapshot['messages'] = []

    for (const update of updates) {
      const m = update.message
      if (!m?.text?.trim() || !m.chat?.id) continue
      const threadId = `th_bot_${hash(`${accountId}:${m.chat.id}`)}`
      const kind: 'dm' | 'group' | 'channel' =
        m.chat.type === 'private' ? 'dm' : m.chat.type === 'channel' ? 'channel' : 'group'
      const title =
        m.chat.title ||
        [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') ||
        m.chat.username ||
        'Telegram bot chat'
      const direction = m.from?.id === me.id ? 'out' : 'in'
      const author =
        direction === 'out'
          ? 'You'
          : [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || title

      const at = m.date * 1000
      const thread = threads.get(threadId) ?? {
        id: threadId,
        accountId,
        title,
        kind,
        priority: kind === 'dm' ? 3 : kind === 'group' ? 2 : 1,
        muted: false,
        botChatId: String(m.chat.id),
        lastMessageAt: at,
      }
      if (at > thread.lastMessageAt) thread.lastMessageAt = at
      threads.set(threadId, thread)

      messages.push({
        id: `m_bot_${hash(`${threadId}:${m.message_id}`)}`,
        threadId,
        direction,
        author,
        text: m.text.trim(),
        at,
        tgMessageId: String(m.message_id),
      })
    }

    return {
      threads: [...threads.values()],
      messages: messages.sort((a, b) => a.at - b.at),
      styleSamples: [],
    }
  }

  async send(token: string, chatId: string, text: string): Promise<void> {
    await this.call(token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    })
  }
}
