/**
 * End-to-end journey against the real SDK + simulator automation API.
 * Drives the exact demo path, asserts app log markers and non-blank
 * framebuffers, and writes the README screenshots to docs/.
 *
 * Run: npm run test:e2e
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { PNG } from 'pngjs'

const SIM = 'http://127.0.0.1:9898'
const API = 'http://127.0.0.1:8787'
const APP = 'http://127.0.0.1:5200'
const DOCS = 'docs'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let lastId = -1

interface ConsoleEntry {
  id: number
  level: string
  message: string
  ts: number
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return (await res.json()) as T
}

async function input(action: string): Promise<void> {
  const res = await json<{ ok: boolean }>(`${SIM}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  assert.equal(res.ok, true, `input ${action}`)
}

async function consoleEntries(since = -1): Promise<ConsoleEntry[]> {
  const suffix = since >= 0 ? `?since_id=${since}` : ''
  const data = await json<{ entries: ConsoleEntry[] }>(`${SIM}/api/console${suffix}`)
  return data.entries
}

async function waitLog(pattern: RegExp, timeoutMs = 25_000): Promise<ConsoleEntry> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const entries = await consoleEntries(lastId)
    for (const entry of entries) {
      if (entry.id > lastId) lastId = entry.id
      if (pattern.test(entry.message)) {
        console.log(`  log · ${entry.message.slice(0, 120)}`)
        return entry
      }
    }
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${pattern}`)
}

async function shot(name: string): Promise<{ lit: number; hash: string }> {
  const res = await fetch(`${SIM}/api/screenshot/glasses`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const png = PNG.sync.read(buffer)
  assert.equal(png.width, 576, `${name} width`)
  assert.equal(png.height, 288, `${name} height`)
  let lit = 0
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] > 0) lit += 1
  assert.ok(lit > 400, `${name} framebuffer is blank (${lit} lit pixels)`)
  assert.ok(lit < 40_000, `${name} framebuffer looks wrong (${lit} lit pixels)`)
  fs.mkdirSync(DOCS, { recursive: true })
  const scale = 2
  const preview = new PNG({ width: png.width * scale, height: png.height * scale })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const alpha = png.data[(y * png.width + x) * 4 + 3]
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = (((y * scale + dy) * preview.width) + (x * scale + dx)) * 4
          preview.data[o] = 0
          preview.data[o + 1] = alpha
          preview.data[o + 2] = 0
          preview.data[o + 3] = 255
        }
      }
    }
  }
  fs.writeFileSync(`${DOCS}/${name}.png`, PNG.sync.write(preview))
  const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 10)
  console.log(`  shot · docs/${name}.png lit=${lit} hash=${hash}`)
  return { lit, hash }
}

function ensurePreview(): void {
  try {
    execFileSync('curl', ['-sf', '--max-time', '1', APP], { stdio: 'ignore' })
    return
  } catch {
    /* start it */
  }
  const child = spawn(
    'npx',
    ['vite', 'preview', '--config', 'app/vite.config.ts', '--host', '127.0.0.1', '--port', '5200'],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  fs.writeFileSync('/tmp/relay-preview.pid', String(child.pid))
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await sleep(300)
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function main(): Promise<void> {
  console.log('Relay E2E · building and booting the stack')
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
  execFileSync('bash', ['tools/server.sh', 'start'], { stdio: 'inherit' })
  ensurePreview()
  await waitHttp(`${APP}/`)
  await waitHttp(`${API}/health`)

  console.log('Relay E2E · starting the simulator fresh')
  execFileSync('bash', ['tools/sim.sh', 'restart', `${APP}/?fresh=1`], { stdio: 'inherit' })
  await waitHttp(`${SIM}/api/ping`)
  await waitLog(/RELAY READY loops=5 demo=true offline=false/, 40_000)

  console.log('Relay E2E · brief')
  await sleep(900)
  const brief = await shot('brief')

  console.log('Relay E2E · open Ana')
  await input('click')
  await waitLog(/RELAY OPEN Ana Ruiz/)
  await sleep(500)
  const detail = await shot('detail')
  assert.notEqual(detail.hash, brief.hash, 'detail differs from brief')

  console.log('Relay E2E · hold the ring')
  await input('long_press')
  await sleep(1300)
  await shot('listening')
  await input('long_press_release')
  await waitLog(/RELAY HEARD yeah tell her I'll send it by 4:30/)
  await waitLog(/RELAY DRAFT Yes — I'll send it by 4:30\./)
  await sleep(400)
  const draft = await shot('draft')
  assert.notEqual(draft.hash, detail.hash, 'draft differs from detail')

  console.log('Relay E2E · send')
  await input('click')
  await waitLog(/RELAY SENT Ana Ruiz remaining=4/)
  await sleep(350)
  const sent = await shot('sent')
  assert.notEqual(sent.hash, draft.hash, 'sent differs from draft')

  await waitLog(/RELAY BRIEF/, 8_000)
  await sleep(400)
  const afterSend = await shot('brief-after')
  assert.notEqual(afterSend.hash, brief.hash, 'brief updated after send')

  console.log('Relay E2E · contextual menu → digest')
  await input('context_menu')
  await sleep(700)
  await shot('menu')
  await input('click')
  await waitLog(/RELAY DIGEST/)
  await sleep(500)
  await shot('digest')
  await input('double_click')
  await waitLog(/RELAY BRIEF/)

  console.log('Relay E2E · contextual menu → connect Telegram')
  await input('context_menu')
  await sleep(500)
  await input('down')
  await sleep(300)
  await input('click')
  const pair = await waitLog(/RELAY PAIR \d{6}/)
  const code = pair.message.match(/(\d{6})$/)?.[1]
  assert.ok(code, 'pair code present')
  await sleep(400)
  await shot('pair')
  await input('double_click')
  await waitLog(/RELAY BRIEF/)

  console.log('Relay E2E · sensitive review gate')
  await input('click')
  await waitLog(/RELAY OPEN Launch team/)
  await sleep(500)
  await shot('detail-check')
  const beforeReview = lastId
  await input('click')
  await sleep(800)
  const afterTap = await consoleEntries(beforeReview)
  assert.ok(!afterTap.some(e => /RELAY SENT/.test(e.message)), 'sensitive tap must open review, not send')
  await shot('draft-check')
  await input('double_click')
  await sleep(500)
  await input('double_click')
  await waitLog(/RELAY BRIEF/)

  console.log('Relay E2E · second track · markets')
  await input('context_menu')
  await sleep(700)
  await input('down')
  await sleep(300)
  await input('down')
  await sleep(300)
  await input('click')
  await waitLog(/RELAY MARKET/)
  await sleep(1_500)
  await shot('market')
  await input('click')
  await waitLog(/RELAY MARKET CONFIRM/)
  await sleep(500)
  await shot('market-confirm')
  await input('click')
  await waitLog(/RELAY DERISK/)
  await sleep(500)
  await shot('market-done')
  await input('double_click')
  await waitLog(/RELAY BRIEF/)

  const all = await consoleEntries(-1)
  const errors = all.filter(e => e.level === 'error' || /create page failed|render failed/.test(e.message))
  assert.deepEqual(errors.map(e => e.message), [], 'no app errors in console')

  console.log('\nPASS · full journey')
  console.log(`  brief lit=${brief.lit} · detail lit=${detail.lit} · draft lit=${draft.lit} · sent lit=${sent.lit}`)
  console.log(`  pair code=${code} · screenshots in ${DOCS}/`)
}

main().catch(err => {
  console.error('\nFAIL ·', err instanceof Error ? err.message : err)
  process.exit(1)
})
