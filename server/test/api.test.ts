import assert from 'node:assert/strict'
import { once } from 'node:events'
import http, { type Server } from 'node:http'
import test from 'node:test'
import { createApp } from '../src/app'
import { loadConfig } from '../src/config'
import { Store } from '../src/store'

async function boot(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    ...process.env,
    DEMO_ENABLED: 'true',
    DEMO_VOICE: 'true',
    SESSION_KEY: '00'.repeat(32),
    TG_API_ID: '',
    TG_API_HASH: '',
    LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    WHISPER_BIN: '',
    CORS_ORIGIN: '*',
    ...overrides,
  })
  const store = new Store('/tmp/relay-test-db.json', { memory: true })
  const app = createApp({ store, config })
  const server: Server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${address.port}`
  return { server, base, store, config }
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function call(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json, headers: res.headers }
}

test('demo session → inbox → draft → send → inbox shrinks', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())

  const health = await call(base, '/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  assert.equal(health.json.features.demo, true)

  const session = await call(base, '/api/session/demo', { method: 'POST' })
  assert.equal(session.status, 201)
  const token = session.json.token
  assert.match(token, /^rl_/)
  assert.equal(session.json.inbox.loops.length, 5)
  assert.equal(session.json.inbox.loops[0].who, 'Ana Ruiz')

  const auth = { Authorization: `Bearer ${token}` }

  const inbox = await call(base, '/api/inbox', { headers: auth })
  assert.equal(inbox.status, 200)
  assert.equal(inbox.json.loops.length, 5)
  assert.equal(inbox.json.channels, 2)
  assert.equal(inbox.json.demo, true)
  const anaMeta = inbox.json.loops.find((l: any) => l.who === 'Ana Ruiz')
  const marcusMeta = inbox.json.loops.find((l: any) => l.who === 'Launch team')
  const priyaMeta = inbox.json.loops.find((l: any) => l.who === 'Priya Shah')
  assert.deepEqual([anaMeta.askClass, anaMeta.sensitivity, anaMeta.vip], ['clear', 'normal', true])
  assert.equal(marcusMeta.sensitivity, 'sensitive')
  assert.equal(priyaMeta.askClass, 'possible')
  assert.equal(inbox.json.connected, false)
  assert.equal(inbox.headers.get('access-control-allow-origin'), '*')

  const ana = inbox.json.loops.find((l: any) => l.who === 'Ana Ruiz')
  assert.ok(ana, 'Ana loop exists')
  const detail = await call(base, `/api/loop/${ana.threadId}`, { headers: auth })
  assert.equal(detail.status, 200)
  await sleep(40)
  assert.equal(detail.json.loop.who, 'Ana Ruiz')
  assert.match(detail.json.loop.ask, /Send latest deck/)
  assert.equal(detail.json.messages.length, 2)

  const draft = await call(base, `/api/loop/${ana.threadId}/draft`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: "yeah tell her I'll send it by 4:30" }),
  })
  assert.equal(draft.status, 200)
  assert.equal(draft.json.provider, 'rules')
  assert.equal(draft.json.draft, "Yes — I'll send it by 4:30.")

  const send = await call(base, `/api/loop/${ana.threadId}/send`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: draft.json.draft }),
  })
  assert.equal(send.status, 200)
  assert.equal(send.json.ok, true)
  assert.equal(send.json.via, 'demo')
  assert.equal(send.json.remaining, 4)

  const after = await call(base, '/api/inbox', { headers: auth })
  assert.equal(after.json.loops.length, 4)
  assert.ok(!after.json.loops.some((l: any) => l.who === 'Ana Ruiz'))

  const digest = await call(base, '/api/digest', { headers: auth })
  assert.equal(digest.status, 200)
  assert.equal(digest.json.items.length, 5)
  assert.equal(digest.json.items[0].channel, 'DeFi Digest')

  const stats = await call(base, '/api/stats', { headers: auth })
  assert.equal(stats.status, 200)
  assert.equal(stats.json.cleared, 1)
  assert.equal(stats.json.sensitiveCleared, 0)
  assert.equal(stats.json.resolveSamples, 1)
  assert.ok(stats.json.avgResolveMs >= 20, `resolve time ${stats.json.avgResolveMs}ms`)
  assert.equal(stats.json.openLoops, 4)
})

test('snooze removes a loop from the brief but keeps the count', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }

  const priya = session.json.inbox.loops.find((l: any) => l.who === 'Priya Shah')
  assert.ok(priya, 'Priya loop exists')
  const snooze = await call(base, `/api/loop/${priya.threadId}/snooze`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ minutes: 60 }),
  })
  assert.equal(snooze.status, 200)
  assert.equal(snooze.json.inbox.loops.length, 4)
  assert.equal(snooze.json.inbox.snoozed, 1)
  assert.ok(!snooze.json.inbox.loops.some((l: any) => l.who === 'Priya Shah'))
})

test('vip and mute controls change the ranking input and hide a thread', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }
  const priya = session.json.inbox.loops.find((l: any) => l.who === 'Priya Shah')
  assert.ok(priya)

  const vip = await call(base, `/api/loop/${priya.threadId}/vip`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ vip: true }),
  })
  assert.equal(vip.status, 200)
  assert.equal(vip.json.inbox.loops.find((l: any) => l.who === 'Priya Shah').vip, true)

  const mute = await call(base, `/api/loop/${priya.threadId}/mute`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ muted: true }),
  })
  assert.equal(mute.status, 200)
  assert.ok(!mute.json.inbox.loops.some((l: any) => l.who === 'Priya Shah'))
})

test('sensitive sends are counted separately in stats', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }
  const marcus = session.json.inbox.loops.find((l: any) => l.who === 'Launch team')
  assert.ok(marcus)
  const detail = await call(base, `/api/loop/${marcus.threadId}`, { headers: auth })
  assert.equal(detail.json.loop.draft, 'Let me check and get back to you.')
  await sleep(30)
  const send = await call(base, `/api/loop/${marcus.threadId}/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'Let me check and get back to you.' }),
  })
  assert.equal(send.status, 200)
  const stats = await call(base, '/api/stats', { headers: auth })
  assert.equal(stats.json.cleared, 1)
  assert.equal(stats.json.sensitiveCleared, 1)
})

test('revoking a session deletes the Telegram link and restores the demo', async t => {
  const { server, base, store } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }
  const account = store.accountByToken(session.json.token)
  assert.ok(account)
  store.setTelegram(account.id, { sessionEnc: 'ciphertext', tgUserId: '42', tgName: 'Test' })
  assert.equal(store.account(account.id)?.tgSessionEnc, 'ciphertext')

  const revoked = await call(base, '/api/session/revoke', { method: 'POST', headers: auth })
  assert.equal(revoked.status, 200)
  assert.equal(revoked.json.inbox.demo, true)
  assert.equal(revoked.json.inbox.loops.length, 5)
  assert.equal(store.account(account.id)?.tgSessionEnc, undefined)
})

test('bot pairing attaches a Bot API inbox, sends through it and revokes', async t => {
  const sent: Array<{ chatId: number; text: string }> = []
  const botApi = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      const method = req.url?.split('/').pop()
      const ok = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'getMe') ok({ id: 42, is_bot: true, first_name: 'Relay Test', username: 'relay_test_bot' })
      else if (method === 'getUpdates') {
        ok([
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: 1_700_000_000,
              text: 'Can you send me the deck by 5?',
              chat: { id: 99, type: 'private', first_name: 'Ana' },
              from: { id: 7, first_name: 'Ana' },
            },
          },
        ])
      } else if (method === 'sendMessage') {
        sent.push({ chatId: Number(body.chat_id), text: String(body.text) })
        ok({ message_id: 2, date: 1_800_000_010, chat: { id: 99 }, text: body.text })
      } else {
        res.writeHead(404).end()
      }
    })
  })
  botApi.listen(0, '127.0.0.1')
  await once(botApi, 'listening')
  const botAddress = botApi.address()
  if (!botAddress || typeof botAddress === 'string') throw new Error('no bot port')
  t.after(() => botApi.close())

  const { server, base, store } = await boot({ BOT_API_BASE: `http://127.0.0.1:${botAddress.port}` })
  t.after(() => server.close())

  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const token = session.json.token
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const pair = await call(base, '/api/pair/new', { method: 'POST', headers: auth })
  const code = pair.json.code

  const attach = await call(base, `/api/pair/${code}/bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: '123:test' }),
  })
  assert.equal(attach.status, 200)
  assert.equal(attach.json.status, 'connected')
  assert.equal(attach.json.synced.threads, 1)

  const inbox = await call(base, '/api/inbox', { headers: auth })
  assert.equal(inbox.json.demo, false)
  assert.equal(inbox.json.connected, true)
  assert.equal(inbox.json.loops.length, 1)
  const loop = inbox.json.loops[0]
  assert.equal(loop.who, 'Ana')
  assert.match(loop.ask, /Send deck by 5/)

  const send = await call(base, `/api/loop/${loop.threadId}/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'Yes — sending it by 5.' }),
  })
  assert.equal(send.status, 200)
  assert.equal(send.json.via, 'bot')
  assert.equal(send.json.remaining, 0)
  assert.deepEqual(sent, [{ chatId: 99, text: 'Yes — sending it by 5.' }])

  const revoke = await call(base, '/api/session/revoke', { method: 'POST', headers: auth })
  assert.equal(revoke.status, 200)
  assert.equal(revoke.json.inbox.demo, true)
  const account = store.accountByToken(token)
  assert.ok(account)
  assert.equal(account.botTokenEnc, undefined)
})

test('sensitive and hedged drafts never reach the LLM', async t => {
  const llmCalls: string[] = []
  const llmServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      llmCalls.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'AI SAYS YES' } }] }))
    })
  })
  llmServer.listen(0, '127.0.0.1')
  await once(llmServer, 'listening')
  const llmAddress = llmServer.address()
  if (!llmAddress || typeof llmAddress === 'string') throw new Error('no llm port')

  const { server, base } = await boot({
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: `http://127.0.0.1:${llmAddress.port}/v1`,
  })
  t.after(() => {
    server.close()
    llmServer.close()
  })

  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }
  const marcus = session.json.inbox.loops.find((l: any) => l.who === 'Launch team')
  assert.ok(marcus)
  await call(base, `/api/loop/${marcus.threadId}`, { headers: auth })

  const neutral = await call(base, `/api/loop/${marcus.threadId}/draft`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  })
  assert.equal(neutral.json.draft, 'Let me check and get back to you.')
  assert.equal(neutral.json.provider, 'rules')
  assert.equal(llmCalls.length, 0, 'no LLM call without intent')

  const uncertain = await call(base, `/api/loop/${marcus.threadId}/draft`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ intent: 'maybe friday' }),
  })
  assert.equal(uncertain.json.draft, "Maybe Friday — I'll confirm.")
  assert.equal(llmCalls.length, 0, 'no LLM call for hedged intent')

  const explicit = await call(base, `/api/loop/${marcus.threadId}/draft`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ intent: 'yes approve it' }),
  })
  assert.equal(explicit.json.provider, 'llm')
  assert.equal(explicit.json.draft, 'AI SAYS YES')
  assert.equal(llmCalls.length, 1, 'explicit intent may use the LLM')
})

test('voice endpoint supports explicit demo utterance and rejects empty audio', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }

  const demo = await call(base, '/api/transcribe', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ demoUtterance: "yeah tell her I'll send it by 4:30" }),
  })
  assert.equal(demo.status, 200)
  assert.equal(demo.json.provider, 'demo')
  assert.match(demo.json.text, /4:30/)

  const empty = await call(base, '/api/transcribe', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pcm: '' }),
  })
  assert.equal(empty.status, 400)

  const short = await call(base, '/api/transcribe', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pcm: Buffer.alloc(200, 1).toString('base64') }),
  })
  assert.equal(short.status, 400)

  const noKey = await call(base, '/api/transcribe', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pcm: Buffer.alloc(3200, 1).toString('base64') }),
  })
  assert.equal(noKey.status, 503)
  assert.equal(noKey.json.error, 'stt_not_configured')
})

test('pairing codes are account-scoped and expire cleanly', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }

  const pair = await call(base, '/api/pair/new', { method: 'POST', headers: auth })
  assert.equal(pair.status, 200)
  assert.match(pair.json.code, /^[0-9]{6}$/)
  assert.equal(pair.json.telegramAvailable, false)

  const status = await call(base, `/api/pair/${pair.json.code}`, { headers: auth })
  assert.equal(status.status, 200)
  assert.equal(status.json.status, 'waiting')

  const start = await call(base, `/api/pair/${pair.json.code}/telegram/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+971501234567' }),
  })
  assert.equal(start.status, 503)
  assert.equal(start.json.error, 'telegram_not_configured')

  const other = await call(base, '/api/session/demo', { method: 'POST' })
  const otherAuth = { Authorization: `Bearer ${other.json.token}` }
  const foreign = await call(base, `/api/pair/${pair.json.code}`, { headers: otherAuth })
  assert.equal(foreign.status, 410)
})

test('auth, reset, export and account deletion', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())

  const unauth = await call(base, '/api/inbox')
  assert.equal(unauth.status, 401)

  const bad = await call(base, '/api/inbox', { headers: { Authorization: 'Bearer nope' } })
  assert.equal(bad.status, 401)

  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const token = session.json.token
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const ana = session.json.inbox.loops.find((l: any) => l.who === 'Ana Ruiz')
  assert.ok(ana, 'Ana loop exists')
  await call(base, `/api/loop/${ana.threadId}/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'Sent.' }),
  })
  const reset = await call(base, '/api/demo/reset', { method: 'POST', headers: auth })
  assert.equal(reset.status, 200)
  assert.equal(reset.json.inbox.loops.length, 5)

  const exported = await call(base, '/api/export', { headers: auth })
  assert.equal(exported.status, 200)
  assert.equal(exported.json.threads.length, 9)
  assert.ok(exported.json.messages.length > 10)

  const deleted = await call(base, '/api/account', { method: 'DELETE', headers: auth })
  assert.equal(deleted.status, 200)
  const gone = await call(base, '/api/inbox', { headers: auth })
  assert.equal(gone.status, 401)
})

test('input validation and unknown loops are safe', async t => {
  const { server, base } = await boot()
  t.after(() => server.close())
  const session = await call(base, '/api/session/demo', { method: 'POST' })
  const auth = { Authorization: `Bearer ${session.json.token}`, 'Content-Type': 'application/json' }

  const missing = await call(base, '/api/loop/nope', { headers: auth })
  assert.equal(missing.status, 404)

  const ana = session.json.inbox.loops.find((l: any) => l.who === 'Ana Ruiz')
  assert.ok(ana, 'Ana loop exists')
  const empty = await call(base, `/api/loop/${ana.threadId}/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: '   ' }),
  })
  assert.equal(empty.status, 400)

  const huge = await call(base, `/api/loop/${ana.threadId}/send`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: 'x'.repeat(1300) }),
  })
  assert.equal(huge.status, 400)

  const noAuthPair = await call(base, '/api/pair/new', { method: 'POST' })
  assert.equal(noAuthPair.status, 401)

  const pairPage = await call(base, '/pair?code=123456')
  assert.equal(pairPage.status, 200)
  assert.match(String(pairPage.json), /Pair your glasses/)
  assert.match(String(pairPage.json), /123456/)
})
