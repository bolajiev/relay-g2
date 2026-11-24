/**
 * One real end-to-end measurement against a running Relay server.
 * Creates a demo account, opens Ana's loop, waits, drafts from a spoken
 * intent, sends, and prints the server's resolve-time metrics.
 *
 * Run: npm run metrics   (server must be on :8787)
 */
const BASE = (process.env.RELAY_API ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const sessionRes = await fetch(`${BASE}/api/session/demo`, { method: 'POST' })
  if (!sessionRes.ok) throw new Error(`demo session failed: ${sessionRes.status}`)
  const session = (await sessionRes.json()) as { token: string }
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }

  const inboxRes = await fetch(`${BASE}/api/inbox`, { headers })
  const inbox = (await inboxRes.json()) as { loops: Array<{ threadId: string; who: string }> }
  const ana = inbox.loops.find(l => l.who === 'Ana Ruiz')
  if (!ana) throw new Error('Ana loop missing')

  const openedAt = Date.now()
  await fetch(`${BASE}/api/loop/${ana.threadId}`, { headers })
  await sleep(800)

  const draftRes = await fetch(`${BASE}/api/loop/${ana.threadId}/draft`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ intent: "yeah tell her I'll send it by 4:30" }),
  })
  const draft = (await draftRes.json()) as { draft: string; provider: string }

  const sendRes = await fetch(`${BASE}/api/loop/${ana.threadId}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: draft.draft }),
  })
  const sent = (await sendRes.json()) as { remaining: number }

  const statsRes = await fetch(`${BASE}/api/stats`, { headers })
  const stats = await statsRes.json()

  console.log(
    JSON.stringify(
      {
        measurement: {
          openedToSentMs: Date.now() - openedAt,
          draft: draft.draft,
          draftProvider: draft.provider,
          remaining: sent.remaining,
        },
        stats,
      },
      null,
      2,
    ),
  )
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
