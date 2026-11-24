import type { AskClass, DigestItem, Loop, Message, Sensitivity, Thread } from './types'

const GREETING = /^(hey|hi|hello|yo|morning|good morning|quick q|quick question|just checking|btw|fyi)\b[\s,!—–-]*/i
const POLITE_PREFIX = /^(can|could|would|will)\s+you\s+(please\s+)?/i
const PLEASE_PREFIX = /^please\s+/i
const MENTION_PREFIX = /^@[a-z0-9_]+\s+/i
const TRAILING_POLITE = /\s*(thanks|thank you|thx|cheers|when you get a chance|if you can|please)\s*[.!?]*$/i
const NO_ACTION = /\b(no action needed|no action required|for your info|just fyi|no rush|nothing needed)\b/i
const REQUEST_MARKER = /\b(can|could|would|please|need|sign|send|approve|book|share|confirm|review|call|let me know|due)\b/i
const DEADLINE_MARKER = /\b(by|before|asap|urgent|eod|tonight|deadline|due|today|tomorrow|mon|tues|wednes|thurs|fri|satur|sun)day?\b/i
const OBJECT_NOUN = /\b(contract|deck|doc|document|file|invoice|agreement|budget|proposal|report|numbers|arr)\b/i

/**
 * "Clear" asks are direct requests. "Possible" asks are hedged or social and
 * should never produce a default commitment — the user gets a neutral draft
 * and a review step. "None" is conversation, not an obligation.
 */
const SOCIAL =
  /^(how are you|how'?s it going|how was|what'?s up|did you see|did you watch|good morning|good night|thanks|thank you|lol|haha)\b/i
const HEDGE =
  /\b(maybe|perhaps|might|possibly|not sure|i think|i guess|could be|if possible|no rush|when you get a chance|would be great|let me know if|if you'?re free|sometime|catch up)\b/i
const SENSITIVE =
  /\b(money|payment|pay|paid|transfer|wire|invoice|refund|contract|agreement|legal|lawyer|sign|signature|budget|approve|approval|loan|invest|investment|equity|bet|wager|purchase|deposit|commit|commitment|guarantee|promise|arr|revenue|valuation|funding|raise|term sheet)\b/i

export interface AskInsight {
  ask: string | null
  classification: AskClass | 'none'
  sensitivity: Sensitivity
  reason: string
}

/** Compact one-line ask for a 576x288 card. */
export function shorten(text: string, max = 46): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  return (at > max * 0.55 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[\s,.;:—-]+$/, '')
}

function stripArticles(text: string): string {
  return text.replace(/\bthe\s+/gi, '').replace(/\s{2,}/g, ' ').trim()
}

function sentenceCandidates(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/** Extract the most likely ask from one inbound message, or null for chatter. */
function askCandidate(raw: string): string | null {
  if (!raw || !raw.trim()) return null
  if (NO_ACTION.test(raw) && !raw.includes('?')) return null

  const sentences = sentenceCandidates(raw)
  if (!sentences.length) return null

  // Prefer a question that actually asks for something over a social question
  // such as "How are you?" that happens to come first.
  const question =
    sentences.find(s => s.includes('?') && REQUEST_MARKER.test(s)) ??
    sentences.find(s => s.includes('?'))
  const request = sentences.find(s => REQUEST_MARKER.test(s))
  const chosen = question ?? request
  if (!chosen) return null
  if (NO_ACTION.test(chosen) && !chosen.includes('?')) return null

  let candidate = chosen
    .replace(MENTION_PREFIX, '')
    .replace(GREETING, '')
    .replace(POLITE_PREFIX, '')
    .replace(PLEASE_PREFIX, '')
    .replace(/^are (you|we) free\s+/i, 'Confirm ')
    .replace(/^is (it|this) (ok|okay)\s*(if|to)?\s*/i, 'Confirm ')
    .replace(/^what'?s your\s+/i, 'Share your ')
    .replace(/^what is your\s+/i, 'Share your ')
    .replace(/^how (much|many)\s+/i, 'Share ')
    .replace(/^do you have\s+/i, 'Send ')
    .replace(/\bme\b\s*/gi, '')
    .replace(TRAILING_POLITE, '')
    .replace(/^[—–-]+\s*/, '')
    .replace(/\s*[—–-]+\s*$/, '')
    .trim()

  // "Please sign by Friday" in a thread about a contract → "Sign contract by Friday".
  const verb = candidate.match(/^(sign|review|send|approve|book|share)\b/i)?.[1]
  if (verb) {
    const idx = sentences.indexOf(chosen)
    const prev = idx > 0 ? sentences[idx - 1] : ''
    const noun = prev.match(OBJECT_NOUN)?.[1]
    if (noun && !candidate.toLowerCase().includes(noun.toLowerCase())) {
      candidate = candidate.replace(new RegExp(`^${verb}`, 'i'), `${verb} ${noun}`)
    }
  }

  candidate = stripArticles(candidate)
  candidate = candidate.replace(/[?!.]+$/, '').trim()
  if (!candidate) return null
  candidate = candidate.charAt(0).toUpperCase() + candidate.slice(1)
  return shorten(candidate, 46)
}

/**
 * Full classification used by the ranking layer and the UI safety gates.
 * Deterministic on purpose: the demo must work with no LLM key.
 */
export function classifyAsk(raw: string): AskInsight {
  const none = (reason: string): AskInsight => ({ ask: null, classification: 'none', sensitivity: 'normal', reason })
  if (!raw || !raw.trim()) return none('empty')
  if (SOCIAL.test(raw.trim()) && !REQUEST_MARKER.test(raw) && !DEADLINE_MARKER.test(raw)) {
    return none('social message, no request')
  }
  const ask = askCandidate(raw)
  if (!ask) return none('no request, question or deadline')

  const possible = HEDGE.test(raw) || HEDGE.test(ask)
  const sensitive = SENSITIVE.test(raw)
  return {
    ask,
    classification: possible ? 'possible' : 'clear',
    sensitivity: sensitive ? 'sensitive' : 'normal',
    reason: [possible ? 'hedged' : 'direct', sensitive ? 'sensitive topic' : 'low stakes'].join(', '),
  }
}

/** Backwards-compatible wrapper for callers that only need the ask text. */
export function extractAsk(raw: string): string | null {
  return classifyAsk(raw).ask
}

const URGENT_3 =
  /\b(asap|urgent|tonight|right now|eod|end of day|immediately|blocking|blocker|lose the venue|before\b|by [0-9]{1,2}(:[0-9]{2})?\s*(am|pm)?)\b/i
const URGENT_2 = /\b(today|tomorrow|this week|friday|monday|tuesday|wednesday|thursday|soon)\b/i

export function detectUrgency(text: string, priority: 1 | 2 | 3 = 2): 1 | 2 | 3 {
  if (URGENT_3.test(text)) return 3
  if (URGENT_2.test(text)) return 2
  return priority === 3 ? 2 : 1
}

/**
 * Urgency should come from the request, not from social preamble such as
 * "Loved the demo today!". Keep deadline/request clauses, drop the rest.
 */
function urgencyContext(raw: string, ask: string): string {
  const deadlineClauses = sentenceCandidates(raw).filter(
    s => DEADLINE_MARKER.test(s) && /\b(need|by|before|asap|urgent|deadline|due|book|send|sign|approve|today|tomorrow)\b/i.test(s),
  )
  return `${ask}. ${deadlineClauses.join(' ')}`
}

export function ageLabel(minutes: number): string {
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 60 / 24)}d`
}

export function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / 60000))
}

/**
 * Rank open loops: last message inbound, a real ask, urgency dominates VIP
 * status which dominates recency. Channels go to the digest.
 */
export function buildOpenLoops(threads: Thread[], messages: Message[], now = Date.now()): Loop[] {
  const byThread = new Map<string, Message[]>()
  for (const m of messages) {
    const list = byThread.get(m.threadId) ?? []
    list.push(m)
    byThread.set(m.threadId, list)
  }

  const loops: Loop[] = []
  for (const thread of threads) {
    if (thread.muted) continue
    if (thread.kind === 'channel') continue
    const list = (byThread.get(thread.id) ?? []).sort((a, b) => a.at - b.at)
    if (!list.length) continue
    const last = list[list.length - 1]
    if (last.direction !== 'in') continue
    const insight = classifyAsk(last.text)
    if (!insight.ask) continue

    const ageMinutes = minutesBetween(last.at, now)
    const urgency = detectUrgency(urgencyContext(last.text, insight.ask), thread.priority)
    const freshness = Math.max(0, 120 - ageMinutes)
    const score =
      urgency * 1000 +
      thread.priority * 100 +
      (thread.vip ? 200 : 0) +
      freshness +
      (last.text.includes('?') ? 15 : 0)
    const snoozed = typeof thread.snoozedUntil === 'number' && thread.snoozedUntil > now
    loops.push({
      id: thread.id,
      threadId: thread.id,
      who: thread.title,
      where: thread.kind === 'dm' ? 'DM' : thread.kind === 'group' ? 'GROUP' : 'CHANNEL',
      kind: thread.kind,
      ask: insight.ask,
      lastMessage: last.text,
      ageMinutes,
      urgency,
      score,
      draft: defaultDraft({ ask: insight.ask, lastMessage: last.text, who: thread.title }, insight, thread.priority),
      askClass: insight.classification === 'possible' ? 'possible' : 'clear',
      sensitivity: insight.sensitivity,
      vip: Boolean(thread.vip),
      status: snoozed ? 'snoozed' : 'open',
      priority: thread.priority,
    })
  }

  return loops.sort((a, b) => b.score - a.score)
}

const TEMPLATES: Array<{ test: RegExp; draft: (ask: string, msg: string, priority: 1 | 2 | 3) => string }> = [
  { test: /\b(approve|approval|budget|sign.?off)\b/i, draft: () => 'Approved — go ahead.' },
  {
    test: /\b(sign|contract|agreement)\b/i,
    draft: (_ask, msg) => {
      const day = msg.match(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i)?.[0]
      return day ? `Got it — I'll review and sign by ${day}.` : "Got it — I'll review and sign today."
    },
  },
  {
    test: /\b(send|deck|file|doc|contract|invoice|link)\b/i,
    draft: (_ask, msg) => {
      const time = msg.match(/\b(?:by|at)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\b/i)?.[1]
      return time ? `Yes — I'll send it by ${time}.` : 'Yes — sending it now.'
    },
  },
  {
    test: /\b(coffee|lunch|dinner|drinks|meet)\b/i,
    draft: (_ask, msg) => {
      const day = msg.match(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i)?.[0]
      return day ? `Yes, ${day} works for me. What time?` : 'Yes, happy to. What time works?'
    },
  },
  {
    test: /\bfree\b/i,
    draft: (_ask, msg) => {
      const day = msg.match(/\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i)?.[0]
      return day ? `Yes, ${day} works. What time?` : 'Yes — what time works for you?'
    },
  },
  { test: /\b(share|arr|numbers|metrics|revenue)\b/i, draft: () => "Happy to share — I'll send the numbers over today." },
  { test: /\b(review|look|feedback|thoughts|check)\b/i, draft: () => "On it — I'll take a look and get back to you today." },
  { test: /\b(book|reserve|venue)\b/i, draft: () => 'Yes, go ahead and book it.' },
  { test: /\b(call|ring|chat)\b/i, draft: () => "Yes — give me 20 minutes and I'll call you." },
]

const FILLER =
  /^(um+|uh+|so|yeah|yep|yes|ok|okay|sure|well|like|tell (her|him|them)|say|that|just|actually|basically|kinda|kind of|i mean)\b[\s,]*/i

function tidyIntent(intent: string): string {
  let value = intent.replace(/\s+/g, ' ').trim()
  let previous = ''
  while (previous !== value) {
    previous = value
    value = value.replace(FILLER, '')
  }
  return value.replace(/[.!]+$/, '').trim()
}

function capitalizeDays(text: string): string {
  return text.replace(
    /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/gi,
    m => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase(),
  )
}

function extractTime(text: string): string | undefined {
  return (
    text.match(/\b(?:by|at|around)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\b/i)?.[1] ??
    text.match(/\b([0-9]{1,2}:[0-9]{2}\s*(?:am|pm)?)\b/i)?.[1]
  )
}

export const UNCERTAIN =
  /\b(maybe|perhaps|might|possibly|not sure|i think|i guess|could be|if possible|cannot confirm|can'?t confirm)\b/i

/** Deterministic draft used when no LLM is configured, and as a safety net. */
export function draftReply(
  input: { ask: string; lastMessage: string; who: string },
  intent?: string,
  priority: 1 | 2 | 3 = 2,
): string {
  const { ask, lastMessage } = input
  const rough = intent ? tidyIntent(intent) : ''

  if (rough) {
    // Preserve uncertainty. "maybe Friday" must never become "Yes, Friday works."
    if (UNCERTAIN.test(rough)) {
      let sentence = capitalizeDays(rough)
      sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1)
      const firstPerson = /^(I|we)\b/.test(sentence)
      return shorten(firstPerson ? `${sentence}.` : `${sentence} — I'll confirm.`, 140)
    }
    if (/^(approve|approved|go ahead|do it)\b/i.test(rough)) {
      return 'Approved — go ahead.'
    }
    const day = rough.match(/^(mon|tues|wednes|thurs|fri|satur|sun)day\b/i)?.[0]
    if (day && /\bworks?\b/i.test(rough)) {
      const nice = day.charAt(0).toUpperCase() + day.slice(1).toLowerCase()
      return `Yes, ${nice} works. What time?`
    }
    if (/^(i'?ll|i will|i can|i'?m|i am|we'?ll|we can|we'?re|let'?s|i'?ve)\b/i.test(rough)) {
      const sentence = rough.charAt(0) === 'i' ? `I${rough.slice(1)}` : rough
      return shorten(`Yes — ${capitalizeDays(sentence)}.`, 140)
    }
    const time = extractTime(rough)
    if (time) {
      if (/\b(approve|budget|book|sign)\b/i.test(ask)) {
        return shorten(`Yes — I'll take care of it by ${time}.`, 140)
      }
      return shorten(`Yes — I'll send it by ${time}.`, 140)
    }
    if (/^(send|share|confirm|approve|sign|book|call|review)\b/i.test(rough)) {
      return shorten(`Yes — ${rough.charAt(0).toLowerCase()}${rough.slice(1)}.`, 140)
    }
    return shorten(`${rough.charAt(0).toUpperCase()}${rough.slice(1)}.`, 140)
  }

  for (const t of TEMPLATES) {
    if (t.test.test(ask) || t.test.test(lastMessage)) return t.draft(ask, lastMessage, priority)
  }
  return "Got it — I'll take care of it today."
}

/**
 * Default draft shown before the user speaks. Sensitive topics and hedged
 * asks get a neutral holding reply so Relay never invents a commitment.
 */
export function defaultDraft(
  input: { ask: string; lastMessage: string; who: string },
  insight: Pick<AskInsight, 'classification' | 'sensitivity'>,
  priority: 1 | 2 | 3 = 2,
): string {
  if (insight.sensitivity === 'sensitive' || insight.classification === 'possible') {
    return 'Let me check and get back to you.'
  }
  return draftReply(input, undefined, priority)
}

/** True when the spoken intent itself is hedged; the draft must preserve it. */
export function intentIsUncertain(intent: string): boolean {
  return UNCERTAIN.test(intent)
}

/**
 * Decide whether an optional LLM may rewrite the draft. Sensitive and possible
 * asks are deterministic unless the user gave an explicit, non-hedged intent.
 * This is the server-side guard behind the app's CHECK/MAYBE review screen.
 */
export function draftPolicy(
  loop: Pick<Loop, 'ask' | 'lastMessage' | 'who' | 'askClass' | 'sensitivity' | 'priority'>,
  intent?: string,
): { rules: string; allowAi: boolean } {
  const rules = intent
    ? draftReply(loop, intent, loop.priority)
    : defaultDraft(loop, { classification: loop.askClass, sensitivity: loop.sensitivity }, loop.priority)
  const guarded = loop.sensitivity === 'sensitive' || loop.askClass === 'possible'
  const allowAi = intent !== undefined ? !guarded || !intentIsUncertain(intent) : !guarded
  return { rules, allowAi }
}

export function buildDigest(threads: Thread[], messages: Message[], now = Date.now()): DigestItem[] {
  const channelIds = new Set(threads.filter(t => t.kind === 'channel').map(t => t.id))
  const titleById = new Map(threads.map(t => [t.id, t.title]))
  const items: DigestItem[] = []
  for (const m of messages) {
    if (!channelIds.has(m.threadId) || m.direction !== 'in') continue
    items.push({
      channel: titleById.get(m.threadId) ?? 'Channel',
      text: shorten(m.text, 72),
      ageMinutes: minutesBetween(m.at, now),
    })
  }
  return items.sort((a, b) => a.ageMinutes - b.ageMinutes).slice(0, 6)
}

export function countChannels(threads: Thread[]): number {
  return threads.filter(t => t.kind === 'channel').length
}
