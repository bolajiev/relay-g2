import type { Account, Loop, Message } from '../../../shared/types'
import type { Config } from '../config'

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

function cleanDraft(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^["'`]+|["'`]+$/g, '')
  text = text.replace(/^(draft|reply|message)\s*:\s*/i, '')
  text = text.replace(/\s*\n+\s*/g, ' ')
  text = text.replace(/\s{2,}/g, ' ')
  if (text.length > 240) {
    const cut = text.slice(0, 241)
    const at = cut.lastIndexOf(' ')
    text = (at > 160 ? cut.slice(0, at) : text.slice(0, 240)).trim()
  }
  return text
}

/**
 * Optional LLM upgrade. Returns null when no key is configured or the provider
 * fails, so callers always fall back to the deterministic drafter.
 */
export async function draftWithAI(
  config: Config,
  account: Account,
  loop: Loop,
  messages: Message[],
  intent?: string,
): Promise<string | null> {
  if (!config.llm.enabled) return null

  const style = account.styleSamples.slice(0, 8).join('\n')
  const context = messages
    .slice(-4)
    .map(m => `${m.direction === 'out' ? 'Me' : m.author}: ${m.text}`)
    .join('\n')

  const system = [
    'You write one Telegram reply for a busy person wearing smart glasses.',
    'Return only the message text, no quotes, no preamble, no explanation.',
    'Sound human and specific. Max 220 characters. No emojis. No greeting or sign-off.',
    'Preserve every fact, time and commitment from the spoken intent. Fix filler words.',
    'Never add a commitment, amount, date or agreement that is not present in the spoken intent.',
    'If the intent is hedged or uncertain, keep that uncertainty. Do not turn maybe into yes.',
    "Match the user's voice from the style samples.",
  ].join(' ')

  const user = [
    `Recipient: ${loop.who} (${loop.where})`,
    `What they need: ${loop.ask}`,
    `Recent thread:\n${context}`,
    style ? `How I usually reply:\n${style}` : '',
    intent ? `What I said out loud: "${intent}"` : 'No spoken intent — write the obvious short reply.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.35,
        max_tokens: 160,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn('[relay] llm http', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as ChatResponse
    const text = data.choices?.[0]?.message?.content
    if (!text) return null
    const cleaned = cleanDraft(text)
    return cleaned || null
  } catch (err) {
    console.warn('[relay] llm failed:', err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
