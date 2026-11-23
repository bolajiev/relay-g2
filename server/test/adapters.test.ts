import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { buildOpenLoops } from '../../shared/loops'
import type { Account } from '../../shared/types'
import { createSeed } from '../../shared/seed'
import { loadConfig } from '../src/config'
import { draftWithAI } from '../src/services/ai'
import { transcribe } from '../src/services/stt'

const NOW = 1_800_000_000_000
const seed = createSeed('acc_adapter', NOW)
const loop = buildOpenLoops(seed.threads, seed.messages, NOW)[0]
const account: Account = {
  id: 'acc_adapter',
  kind: 'demo',
  displayName: 'Demo',
  createdAt: NOW,
  styleSamples: ['Sure — sending now.', 'Approved — go ahead.'],
}

async function fakeServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

test('LLM adapter is off without a key and never called', async () => {
  const config = loadConfig({ ...process.env, LLM_API_KEY: '' })
  const result = await draftWithAI(config, account, loop, [], 'by 4:30')
  assert.equal(result, null)
})

test('LLM adapter sends style + intent and cleans the provider response', async t => {
  let captured = ''
  const { server, port } = await fakeServer((req, body, res) => {
    captured = body
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer test-key')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '  "Yes — sending it by 4:30."  ' } }] }))
  })
  t.after(() => server.close())

  const config = loadConfig({
    ...process.env,
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_MODEL: 'test-model',
  })
  const draft = await draftWithAI(config, account, loop, seed.messages.slice(0, 2), "yeah tell her I'll send it by 4:30")
  assert.equal(draft, 'Yes — sending it by 4:30.')
  const payload = JSON.parse(captured)
  assert.equal(payload.model, 'test-model')
  const prompt = JSON.stringify(payload.messages)
  assert.match(prompt, /4:30/)
  assert.match(prompt, /Sure — sending now/)
})

test('STT adapter uploads a WAV and returns the transcript', async t => {
  let sawWav = false
  const { server, port } = await fakeServer((req, body, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions')
    assert.match(String(req.headers['content-type']), /multipart\/form-data/)
    sawWav = body.includes('RIFF') && body.includes('WAVE') && body.includes('audio.wav')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: 'send it by four thirty' }))
  })
  t.after(() => server.close())

  const config = loadConfig({
    ...process.env,
    OPENAI_API_KEY: 'test-key',
    STT_BASE_URL: `http://127.0.0.1:${port}/v1`,
  })
  const result = await transcribe(config, Buffer.alloc(3200, 7), 16_000)
  assert.deepEqual(result, { text: 'send it by four thirty', provider: 'openai' })
  assert.equal(sawWav, true, 'request contained a WAV file part')
})

test('STT adapter reports no provider instead of inventing text', async () => {
  const config = loadConfig({ ...process.env, OPENAI_API_KEY: '', WHISPER_BIN: '' })
  const result = await transcribe(config, Buffer.alloc(3200, 1), 16_000)
  assert.equal(result, null)
})
