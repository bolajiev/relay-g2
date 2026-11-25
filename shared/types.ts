export type AccountKind = 'demo' | 'telegram' | 'bot'
export type AskClass = 'clear' | 'possible'
export type Sensitivity = 'normal' | 'sensitive'
export type MarketSource = 'hyperliquid' | 'fixture'
export type ThreadKind = 'dm' | 'group' | 'channel'
export type Direction = 'in' | 'out'
export type ScreenName =
  | 'boot'
  | 'market'
  | 'market-confirm'
  | 'market-done'
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
  stats?: AccountStats
  tgUserId?: string
  tgName?: string
  /** AES-GCM encrypted GramJS StringSession. Never sent to the client. */
  tgSessionEnc?: string
  /** AES-GCM encrypted Bot API token for bot-inbox mode. */
  botTokenEnc?: string
  botId?: string
  botName?: string
  paperPositions?: PaperPosition[]
}

export interface AccountStats {
  cleared: number
  sensitiveCleared: number
  totalResolveMs: number
  resolveSamples: number
  paperDeRisks?: number
}

export interface PaperPosition {
  id: string
  asset: string
  side: 'long' | 'short'
  size: number
  entry: number
  leverage: number
  liquidationPrice: number
  openedAt: number
  closedAt?: number
}

export interface MarketSignal {
  channel: string
  text: string
  ageMinutes: number
  asset: string
}

export interface MarketView {
  signal: MarketSignal
  asset: string
  markPrice: number
  funding: number
  openInterest: number
  prevDayPrice: number
  source: MarketSource
  paper: true
  position: PaperPosition & {
    pnlUsd: number
    pnlPct: number
    liqDistancePct: number
  }
}

export interface Thread {
  id: string
  accountId: string
  title: string
  kind: ThreadKind
  /** 3 = VIP / direct ask, 2 = regular, 1 = low signal */
  priority: 1 | 2 | 3
  muted: boolean
  vip?: boolean
  snoozedUntil?: number
  /** Set when the user opens the loop; used for resolve-time metrics. */
  viewedAt?: number
  tgPeer?: string
  /** Bot API chat id, used by bot-inbox mode. */
  botChatId?: string
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
  askClass: AskClass
  sensitivity: Sensitivity
  vip: boolean
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
