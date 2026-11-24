import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { buildOpenLoops } from '../../shared/loops'
import { loadConfig } from '../src/config'
import { BotService } from '../src/services/bot'

const NOW = 1_800_000_000_000
let sent: Array<{ chatId: number; text: string }> = []

async function fakeBotApi() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      const method = req.url?.split('/').pop()
      const ok = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'getMe') {
        ok({ id: 42, is_bot: true, first_name: 'Relay Test', username: 'relay_test_bot' })
      } else if (method === 'getUpdates') {
        ok([
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: 1_800_000_000,
              text: 'Can you send me the deck by 5?',
              chat: { id: 99, type: 'private', first_name: 'Ana' },
              from: { id: 7, is_bot: false, first_name: 'Ana' },
            },
          },
        ])
      } else if (method === 'sendMessage') {
        sent.push({ chatId: Number(body.chat_id), text: String(body.text) })
        ok({ message_id: 2, date: 1_800_000_010, chat: { id: body.chat_id }, text: body.text })
      } else {
        res.writeHead(404).end()
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

function configFor(base: string) {
  return loadConfig({
    ...process.env,
    SESSION_KEY: '00'.repeat(32),
    TG_API_ID: '',
    TG_API_HASH: '',
    BOT_API_BASE: base,
  })
}

test('Bot API snapshot maps a private request into a loop and sends a reply', async t => {
  sent = []
  const { server, base } = await fakeBotApi()
  t.after(() => server.close())
  const bot = new BotService(configFor(base))

  const me = await bot.me('123:test')
  assert.equal(me.id, 42)
  assert.equal(me.username, 'relay_test_bot')

  const snapshot = await bot.snapshot('123:test', 'acc_bot')
  assert.equal(snapshot.threads.length, 1)
  assert.equal(snapshot.threads[0].title, 'Ana')
  assert.equal(snapshot.threads[0].kind, 'dm')
  assert.equal(snapshot.threads[0].botChatId, '99')
  assert.equal(snapshot.messages.length, 1)
  assert.equal(snapshot.messages[0].direction, 'in')

  const loops = buildOpenLoops(snapshot.threads, snapshot.messages, NOW)
  assert.equal(loops.length, 1)
  assert.equal(loops[0].who, 'Ana')
  assert.match(loops[0].ask, /Send deck by 5/)

  await bot.send('123:test', '99', 'Yes — sending it by 5.')
  assert.deepEqual(sent, [{ chatId: 99, text: 'Yes — sending it by 5.' }])
})

test('Bot API rejects an invalid token and a webhook conflict cleanly', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  const bot = new BotService(configFor(`http://127.0.0.1:${address.port}`))
  await assert.rejects(() => bot.me('bad:token'), /Unauthorized/)
})
