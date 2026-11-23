import type { DigestItem, Loop, Message, ScreenName } from '../../shared/types'
import { ageLabel, shorten } from '../../shared/loops'

export interface TextBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  color: 0 | 1 | 2 | 3 | 4
  border?: number
  borderColor?: number
  pad?: number
  radius?: number
  capture?: boolean
}

export interface ListBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
  itemWidth: number
  border?: number
  borderColor?: number
  pad?: number
  capture: true
}

export interface MenuEntry {
  id: number
  name: string
}

export interface View {
  boxes: TextBox[]
  list?: ListBox
  menu: MenuEntry[]
}

export interface ViewState {
  screen: ScreenName
  loops: Loop[]
  selected: number
  detail: { loop: Loop; messages: Message[] } | null
  draft: string
  draftProvider: 'llm' | 'rules' | 'demo' | 'offline' | ''
  digest: DigestItem[]
  sent: { who: string; remaining: number } | null
  pair: { code: string; status: 'waiting' | 'connected'; expiresAt: number; url?: string } | null
  note: string
  demo: boolean
  offline: boolean
  snoozed: number
  listeningSeconds: number
  listeningBars: number[]
  listeningSource: 'glasses' | 'ring' | 'phone' | ''
  busy: boolean
}

/**
 * Firmware metrics measured in the simulator: a glyph line is ~24 px, average
 * glyph ~8.6 px. One-line containers need >= 40 px height; two-line containers
 * need >= 72 px. Anything shorter draws a scroll indicator down the right edge.
 */
const W = 576
const H = 288
const M = 16
const LINE = 24
const CHAR = 8.6
const HEADER_H = 40
const FOOTER_Y = 248
const FOOTER_H = 40
export const LIST_ITEM_MAX = 58

export const SCREEN_MENU: MenuEntry[] = [
  { id: 1, name: 'Digest' },
  { id: 2, name: 'Connect Telegram' },
  { id: 3, name: 'Refresh' },
]

function capture(): TextBox {
  return { id: 1, name: 'capture', x: 0, y: 0, w: W, h: H, content: ' ', color: 4, capture: true }
}

function box(partial: Omit<TextBox, 'content'> & { content: string }): TextBox {
  return partial
}

function header(text: string, color: 0 | 1 | 2 | 3 | 4 = 3): TextBox {
  return box({ id: 2, name: 'header', x: M, y: 0, w: W - M * 2, h: HEADER_H, content: text, color, pad: 2 })
}

function footer(state: ViewState, fallback: string): TextBox {
  const content = state.note ? shorten(state.note, 58) : fallback
  return box({ id: 20, name: 'footer', x: M, y: FOOTER_Y, w: W - M * 2, h: FOOTER_H, content, color: state.note ? 3 : 2, pad: 2 })
}

function badge(state: ViewState): string {
  if (state.offline) return 'OFFLINE DEMO'
  if (state.demo) return 'DEMO'
  return ''
}

export function bootView(): View {
  const boxes: TextBox[] = [capture()]
  boxes.push(box({ id: 3, name: 'brand', x: M, y: 80, w: W - M * 2, h: 120, content: 'R E L A Y\n\nReply debt, cleared.', color: 4, pad: 8 }))
  boxes.push(box({ id: 20, name: 'footer', x: M, y: FOOTER_Y, w: W - M * 2, h: FOOTER_H, content: 'loading your brief...', color: 2, pad: 2 }))
  return { boxes, menu: [] }
}

export function briefView(state: ViewState): View {
  const boxes: TextBox[] = []
  const bits = ['RELAY', `${state.loops.length} WAITING`]
  if (state.snoozed > 0) bits.push(`${state.snoozed} LATER`)
  const label = badge(state)
  if (label) bits.push(label)
  boxes.push(header(bits.join(' · '), 3))
  const footerText = footer(state, 'TAP open · SWIPE move · HOLD refresh')

  if (!state.loops.length) {
    boxes.push(capture())
    boxes.push(
      box({
        id: 3,
        name: 'empty',
        x: M,
        y: 88,
        w: W - M * 2,
        h: 100,
        content: "Nothing waiting.\nYou're clear.",
        color: 4,
        border: 1,
        borderColor: 7,
        radius: 5,
        pad: 12,
      }),
    )
    boxes.push(footerText)
    return { boxes, menu: SCREEN_MENU }
  }

  const items = state.loops.slice(0, 4).map(loop =>
    shorten(`${loop.who} — ${loop.ask}`, LIST_ITEM_MAX),
  )
  boxes.push(footerText)
  return {
    boxes,
    list: {
      id: 3,
      name: 'inbox',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 196,
      items,
      itemWidth: W - M * 2 - 12,
      border: 0,
      pad: 2,
      capture: true,
    },
    menu: SCREEN_MENU,
  }
}

export function detailView(state: ViewState): View {
  const loop = state.detail?.loop ?? state.loops[0]
  const boxes: TextBox[] = [capture()]
  if (!loop) {
    boxes.push(header('RELAY · NOTHING WAITING'))
    boxes.push(footer(state, 'DOUBLE back'))
    return { boxes, menu: SCREEN_MENU }
  }
  const where = loop.kind === 'dm' ? 'DM' : loop.kind === 'group' ? 'GROUP' : 'CHANNEL'
  boxes.push(header(`◀ ${loop.who.toUpperCase()} · ${where} · ${ageLabel(loop.ageMinutes)}`, 3))
  boxes.push(
    box({
      id: 3,
      name: 'ask',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 88,
      content: `NEEDS\n${loop.ask}`,
      color: 4,
      border: 1,
      borderColor: 9,
      radius: 5,
      pad: 4,
    }),
  )
  const draftText = state.busy ? 'writing your reply...' : shorten(state.draft || loop.draft, 168)
  boxes.push(
    box({
      id: 5,
      name: 'draft',
      x: M,
      y: 136,
      w: W - M * 2,
      h: 104,
      content: `DRAFT${state.draftProvider === 'llm' ? ' · AI' : ''}\n${draftText}`,
      color: 4,
      border: 1,
      borderColor: 6,
      radius: 5,
      pad: 4,
    }),
  )
  boxes.push(footer(state, 'TAP send · HOLD speak · SWIPE later'))
  return { boxes, menu: SCREEN_MENU }
}

const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export function listeningHeader(state: ViewState): string {
  const secs = Math.max(0, Math.floor(state.listeningSeconds))
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
  const source = state.listeningSource === 'ring' ? ' · RING' : state.listeningSource === 'phone' ? ' · PHONE' : ''
  return `● REC ${clock}${source}${state.demo ? ' · DEMO' : ''}`
}

export function listeningWave(state: ViewState): string {
  const bars = state.listeningBars.length ? state.listeningBars : Array.from({ length: 48 }, () => 0.08)
  return bars
    .slice(-48)
    .map(v => BARS[Math.max(0, Math.min(7, Math.round(Math.min(1, v * 3.2) * 7)))])
    .join('')
}

export function listeningView(state: ViewState): View {
  const boxes: TextBox[] = [capture()]
  boxes.push(header(listeningHeader(state), 4))
  boxes.push(
    box({
      id: 3,
      name: 'instruction',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 64,
      content: "Speak like you'd text.\nRelease to clean it up.",
      color: 3,
      pad: 2,
    }),
  )
  boxes.push(box({ id: 4, name: 'wave', x: M, y: 112, w: W - M * 2, h: 40, content: listeningWave(state), color: 4, pad: 2 }))
  boxes.push(
    box({
      id: 5,
      name: 'hint',
      x: M,
      y: 156,
      w: W - M * 2,
      h: 80,
      content: 'No live transcript by design.\nAI drafts, you approve.',
      color: 2,
      pad: 2,
    }),
  )
  boxes.push(footer(state, 'RELEASE to draft · DOUBLE cancel'))
  return { boxes, menu: [] }
}

export function draftView(state: ViewState): View {
  const loop = state.detail?.loop
  const boxes: TextBox[] = [capture()]
  if (!loop) {
    boxes.push(header('RELAY · NO DRAFT'))
    boxes.push(footer(state, 'DOUBLE back'))
    return { boxes, menu: SCREEN_MENU }
  }
  const provider = state.draftProvider === 'llm' ? ' · AI' : state.draftProvider === 'demo' ? ' · VOICE DEMO' : ''
  boxes.push(header(`DRAFT → ${shorten(loop.who.toUpperCase(), 20)}${provider}`, 3))
  boxes.push(
    box({
      id: 3,
      name: 'draft',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 192,
      content: state.busy ? 'Transcribing...' : state.draft || loop.draft,
      color: 4,
      border: 1,
      borderColor: 10,
      radius: 5,
      pad: 8,
    }),
  )
  boxes.push(footer(state, 'TAP send · HOLD redo · SWIPE later'))
  return { boxes, menu: SCREEN_MENU }
}

export function sentView(state: ViewState): View {
  const sent = state.sent ?? { who: 'Telegram', remaining: 0 }
  const boxes: TextBox[] = [capture()]
  boxes.push(header('SENT', 2))
  boxes.push(
    box({
      id: 3,
      name: 'sent',
      x: M,
      y: 56,
      w: W - M * 2,
      h: 100,
      content: `● Sent to ${shorten(sent.who, 26)}\n${sent.remaining > 0 ? `${sent.remaining} still waiting` : "You're clear."}`,
      color: 4,
      border: 1,
      borderColor: 8,
      radius: 5,
      pad: 12,
    }),
  )
  boxes.push(
    box({
      id: 4,
      name: 'meta',
      x: M,
      y: 172,
      w: W - M * 2,
      h: 40,
      content: 'Going back to the brief...',
      color: 2,
      pad: 2,
    }),
  )
  boxes.push(footer(state, 'TAP next now · DOUBLE exit'))
  return { boxes, menu: SCREEN_MENU }
}

export function digestView(state: ViewState): View {
  const boxes: TextBox[] = []
  boxes.push(header(`DIGEST · ${state.digest.length} ITEMS`, 3))
  const footerBox = footer(state, 'TAP refresh · DOUBLE back')
  if (!state.digest.length) {
    boxes.push(capture())
    boxes.push(
      box({
        id: 3,
        name: 'empty',
        x: M,
        y: 56,
        w: W - M * 2,
        h: 100,
        content: 'No channel updates.\nQuiet is good.',
        color: 3,
        border: 1,
        borderColor: 6,
        radius: 5,
        pad: 12,
      }),
    )
    boxes.push(footerBox)
    return { boxes, menu: SCREEN_MENU }
  }
  boxes.push(footerBox)
  const items = state.digest.slice(0, 4).map(i => shorten(`${i.channel} · ${ageLabel(i.ageMinutes)} — ${i.text}`, LIST_ITEM_MAX))
  return {
    boxes,
    list: {
      id: 3,
      name: 'digest',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 196,
      items,
      itemWidth: W - M * 2 - 12,
      border: 0,
      pad: 2,
      capture: true,
    },
    menu: SCREEN_MENU,
  }
}

export function pairView(state: ViewState): View {
  const boxes: TextBox[] = [capture()]
  const code = state.pair?.code ?? '------'
  const spaced = code.split('').join(' ')
  const connected = state.pair?.status === 'connected'
  boxes.push(header(connected ? 'TELEGRAM CONNECTED' : 'CONNECT TELEGRAM', connected ? 4 : 3))
  boxes.push(
    box({
      id: 3,
      name: 'body',
      x: M,
      y: 44,
      w: W - M * 2,
      h: 88,
      content: connected
        ? 'Syncing your chats.\nYou can go back to the brief.'
        : `On your phone open:\n${shorten(state.pair?.url ?? 'relay.app/pair', 34)}\nThen enter this code:`,
      color: 3,
      pad: 2,
    }),
  )
  if (!connected) {
    boxes.push(
      box({
        id: 4,
        name: 'code',
        x: M,
        y: 136,
        w: W - M * 2,
        h: 64,
        content: spaced,
        color: 4,
        border: 1,
        borderColor: 9,
        radius: 5,
        pad: 14,
      }),
    )
  }
  boxes.push(
    box({
      id: 5,
      name: 'status',
      x: M,
      y: 204,
      w: W - M * 2,
      h: 36,
      content: connected ? 'synced · tap to continue' : 'waiting for your phone...',
      color: 2,
      pad: 2,
    }),
  )
  boxes.push(footer(state, connected ? 'TAP continue' : 'TAP refresh · DOUBLE back'))
  return { boxes, menu: connected ? SCREEN_MENU : [] }
}

export function errorView(state: ViewState): View {
  const boxes: TextBox[] = [capture()]
  boxes.push(header('RELAY', 4))
  boxes.push(
    box({
      id: 3,
      name: 'error',
      x: M,
      y: 56,
      w: W - M * 2,
      h: 120,
      content: state.offline ? "Can't reach Relay.\nRunning the local demo inbox." : state.note || 'Something went wrong.\nTry again.',
      color: 3,
      border: 1,
      borderColor: 6,
      radius: 5,
      pad: 10,
    }),
  )
  boxes.push(footer(state, 'TAP retry · DOUBLE exit'))
  return { boxes, menu: [] }
}

export function viewFor(state: ViewState): View {
  switch (state.screen) {
    case 'boot':
      return bootView()
    case 'brief':
      return briefView(state)
    case 'detail':
      return detailView(state)
    case 'listening':
      return listeningView(state)
    case 'draft':
      return draftView(state)
    case 'sent':
      return sentView(state)
    case 'digest':
      return digestView(state)
    case 'pair':
      return pairView(state)
    case 'error':
      return errorView(state)
    default:
      return briefView(state)
  }
}

/** Validate the contract the firmware enforces; used by tests and before render. */
export function validateView(view: View): string[] {
  const errors: string[] = []
  const boxes = view.boxes
  const list = view.list
  const captures = boxes.filter(b => b.capture).length + (list?.capture ? 1 : 0)
  if (captures !== 1) errors.push(`expected exactly 1 capture container, got ${captures}`)
  const total = boxes.length + (list ? 1 : 0)
  if (total > 8) errors.push(`too many containers: ${total}`)
  if (list && list.items.length > 20) errors.push('list has more than 20 items')
  if (list && list.items.some(i => i.length > 64)) errors.push('list item longer than 64 chars')
  const ids = new Set<number>()
  for (const b of boxes) {
    if (ids.has(b.id)) errors.push(`duplicate container id ${b.id}`)
    ids.add(b.id)
    if (b.content.length > 1000) errors.push(`container ${b.name} content too long (${b.content.length})`)
    if (b.x < 0 || b.y < 0 || b.x + b.w > 576 || b.y + b.h > 288) errors.push(`container ${b.name} outside canvas`)
    if (b.color < 0 || b.color > 4) errors.push(`container ${b.name} bad textColor`)
  }
  if (list) {
    if (ids.has(list.id)) errors.push(`duplicate container id ${list.id}`)
    if (list.x < 0 || list.y < 0 || list.x + list.w > 576 || list.y + list.h > 288) errors.push('list outside canvas')
  }
  return errors
}

/** Estimated text fit, used to catch the scrollbar regression in tests. */
export function overflow(view: View): string[] {
  const bad: string[] = []
  for (const b of view.boxes) {
    if (b.capture) continue
    const pad = b.pad ?? 4
    const innerW = b.w - pad * 2
    const innerH = b.h - pad * 2
    const perLine = Math.max(1, Math.floor(innerW / CHAR))
    const lines = b.content.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0)
    if (lines * LINE > innerH + 2) bad.push(`${b.name}: ${lines} lines > ${innerH}px`)
  }
  return bad
}

/** Containers that are neither capture nor list, for overlap tests. */
export function visibleBoxes(view: View): TextBox[] {
  return view.boxes.filter(b => !b.capture)
}

export const LAYOUT = { W, H, M, LINE, CHAR, HEADER_H, FOOTER_Y, FOOTER_H }
