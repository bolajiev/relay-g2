export type AccountKind = 'demo' | 'telegram'
export type ThreadKind = 'dm' | 'group' | 'channel'
export type Direction = 'in' | 'out'
export type ScreenName =
  | 'boot'
  | 'brief'
  | 'detail'
  | 'listening'
  | 'draft'
  | 'sent'
  | 'digest'
  | 'pair'
  | 'error'

export interface Account {
  id: string
  kind: AccountKind
  displayName: string
  username?: string
  createdAt: number
  styleSamples: string[]
  tgUserId?: string
  tgName?: string
  /** AES-GCM encrypted GramJS StringSession. Never sent to the client. */
  tgSessionEnc?: string
}

export interface Thread {
  id: string
  accountId: string
  title: string
  kind: ThreadKind
  /** 3 = VIP / direct ask, 2 = regular, 1 = low signal */
  priority: 1 | 2 | 3
  muted: boolean
  snoozedUntil?: number
  tgPeer?: string
  lastMessageAt: number
}

export interface Message {
  id: string
  threadId: string
  direction: Direction
  author: string
  text: string
  at: number
  tgMessageId?: string
}

export interface Loop {
  id: string
  threadId: string
  who: string
  where: string
  kind: ThreadKind
  ask: string
  lastMessage: string
  ageMinutes: number
  urgency: 1 | 2 | 3
  score: number
  draft: string
  status: 'open' | 'snoozed'
  priority: 1 | 2 | 3
}

export interface DigestItem {
  channel: string
  text: string
  ageMinutes: number
}

export interface Inbox {
  loops: Loop[]
  snoozed: number
  channels: number
  demo: boolean
  connected: boolean
}

export interface TranscribeResult {
  text: string
  provider: 'openai' | 'local' | 'demo'
}
