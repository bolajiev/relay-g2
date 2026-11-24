import type { Message, Thread } from './types'

export interface SeedData {
  threads: Thread[]
  messages: Message[]
  styleSamples: string[]
}

const MIN = 60_000

/**
 * Fictional inbox used by demo mode. Deliberately mundane: a deck, a budget,
 * a coffee invite, an investor question, a contract. No real people, no
 * financial advice, no live money.
 */
export function createSeed(accountId: string, now = Date.now()): SeedData {
  const tid = (name: string): string => `${accountId}_${name}`
  const t = (name: string, title: string, kind: Thread['kind'], priority: 1 | 2 | 3, lastAgoMin: number, extra: Partial<Thread> = {}): Thread => ({
    id: tid(name),
    accountId,
    title,
    kind,
    priority,
    muted: false,
    lastMessageAt: now - lastAgoMin * MIN,
    ...extra,
  })

  const threads: Thread[] = [
    t('ana', 'Ana Ruiz', 'dm', 3, 2, { vip: true, tgPeer: '@ana_demo' }),
    t('marcus', 'Launch team', 'group', 3, 9, { vip: true, tgPeer: '-100demo' }),
    t('priya', 'Priya Shah', 'dm', 2, 26),
    t('daniel', 'Daniel Okafor', 'dm', 3, 41, { vip: true }),
    t('sofia', 'Sofia Marin', 'dm', 2, 65),
    t('design', 'Design team', 'group', 1, 55),
    t('defi', 'DeFi Digest', 'channel', 1, 20),
    t('ai', 'AI Daily', 'channel', 1, 55),
    t('nadia', 'Nadia (Acme)', 'dm', 1, 300),
  ]

  const m = (
    name: string,
    threadName: string,
    direction: Message['direction'],
    author: string,
    text: string,
    agoMin: number,
  ): Message => ({
    id: `${tid(threadName)}_${name}`,
    threadId: tid(threadName),
    direction,
    author,
    text,
    at: now - agoMin * MIN,
  })

  const messages: Message[] = [
    // Ana — the hero loop
    m('1', 'ana', 'out', 'You', "Here's the v3 deck. Would love your read before tomorrow.", 38),
    m('2', 'ana', 'in', 'Ana Ruiz', 'Hey! Can you send me the latest deck before the design review at 5? Need it to lock the narrative.', 2),

    // Launch team — budget approval
    m('1', 'marcus', 'in', 'Sam Ortiz', 'Venue is confirmed for the 12th. Deposit is due this week.', 70),
    m('2', 'marcus', 'in', 'Marcus Lee', '@you can you approve the $2k budget for the offsite? Need to book today or we lose the venue.', 9),

    // Priya — coffee
    m('1', 'priya', 'in', 'Priya Shah', 'Great meeting you at Devconnect.', 90),
    m('2', 'priya', 'out', 'You', "Likewise! Let's compare notes properly.", 80),
    m('3', 'priya', 'in', 'Priya Shah', 'Loved the demo today! Are you free Thursday for coffee? Would be great to compare notes.', 26),

    // Daniel — investor ask
    m('1', 'daniel', 'in', 'Daniel Okafor', "Intro from Priya — she said you're the person to talk to.", 130),
    m('2', 'daniel', 'out', 'You', "Ha, she's generous. Happy to chat.", 120),
    m('3', 'daniel', 'in', 'Daniel Okafor', "Quick q — what's your ARR? Considering the round and want to move fast.", 41),

    // Sofia — contract
    m('1', 'sofia', 'in', 'Sofia Marin', 'Sent over the contract. Please sign by Friday so we can start Monday.', 65),

    // Design team — explicitly no action
    m('1', 'design', 'in', 'Design team', 'Final logo files are in Figma, no action needed. Nice work everyone!', 55),

    // Channels — digest only
    m('1', 'defi', 'in', 'DeFi Digest', 'EigenLayer unlocks 12M tokens next week.', 20),
    m('2', 'defi', 'in', 'DeFi Digest', 'Base TVL crosses $8B as onchain activity accelerates.', 75),
    m('3', 'defi', 'in', 'DeFi Digest', 'USDC yields tick up to 6.1% on Aave.', 180),
    m('1', 'ai', 'in', 'AI Daily', 'OpenAI ships realtime voice API v2 with lower latency.', 55),
    m('2', 'ai', 'in', 'AI Daily', "Anthropic expands Claude's context window for enterprise.", 160),

    // Closed loop — last message is ours
    m('1', 'nadia', 'in', 'Nadia (Acme)', 'Thanks — got it!', 300),
    m('2', 'nadia', 'out', 'You', 'Anytime.', 295),
  ]

  const latestByThread = new Map<string, number>()
  for (const msg of messages) {
    const prev = latestByThread.get(msg.threadId) ?? 0
    if (msg.at > prev) latestByThread.set(msg.threadId, msg.at)
  }
  for (const thread of threads) {
    thread.lastMessageAt = latestByThread.get(thread.id) ?? thread.lastMessageAt
  }

  return {
    threads,
    messages,
    styleSamples: [
      'Sure — sending now.',
      'Yes, Thursday works.',
      'Approved — go ahead.',
      "On it — I'll take a look today.",
      'Happy to share — I will send the numbers over.',
    ],
  }
}

/** Scripted voice used only in demo mode when no microphone/STT is available. */
export const DEMO_UTTERANCES: Record<string, string> = {
  ana: "yeah tell her I'll send it by 4:30",
  marcus: 'yeah approve it, go ahead and book',
  priya: "yes thursday works, ask her what time",
  daniel: "we're at 1.2 million ARR, growing 18 percent month over month",
  sofia: "I'll review and sign it by friday",
}

export function demoUtteranceFor(threadId: string): string {
  const key = Object.keys(DEMO_UTTERANCES).find(name => threadId.endsWith(`_${name}`))
  return (key ? DEMO_UTTERANCES[key] : undefined) ?? "yeah tell them I'll take care of it today"
}
