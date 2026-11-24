import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDigest, buildOpenLoops } from '../../shared/loops'
import { createSeed } from '../../shared/seed'
import type { ScreenName } from '../../shared/types'
import { LAYOUT, overflow, viewFor, validateView, visibleBoxes, type ViewState } from '../src/views'

const NOW = 1_800_000_000_000
const seed = createSeed('acc_view', NOW)
const loops = buildOpenLoops(seed.threads, seed.messages, NOW)

function state(screen: ScreenName): ViewState {
  const detail = {
    loop: loops[0],
    messages: seed.messages.filter(m => m.threadId === loops[0].threadId),
  }
  return {
    screen,
    loops,
    selected: 0,
    detail,
    draft: "Yes — I'll send it by 4:30.",
    draftProvider: 'rules',
    digest: buildDigest(seed.threads, seed.messages, NOW),
    sent: { who: 'Ana Ruiz', remaining: 4 },
    pair: { code: '482913', status: 'waiting', expiresAt: NOW + 600_000 },
    note: '',
    demo: true,
    offline: false,
    snoozed: 0,
    listeningSeconds: 4,
    listeningBars: Array.from({ length: 48 }, (_, i) => (i % 8) / 8),
    listeningSource: 'ring',
    busy: false,
  }
}

const screens: ScreenName[] = ['boot', 'brief', 'detail', 'listening', 'draft', 'sent', 'digest', 'pair', 'error']

test('every screen satisfies the firmware container contract', () => {
  for (const screen of screens) {
    const view = viewFor(state(screen))
    const errors = validateView(view)
    assert.deepEqual(errors, [], `${screen}: ${errors.join('; ')}`)
    assert.deepEqual(overflow(view), [], `${screen} overflow: ${overflow(view).join('; ')}`)
    const total = view.boxes.length + (view.list ? 1 : 0)
    assert.ok(total <= 8, `${screen} has ${total} containers`)
    const captures = view.boxes.filter(b => b.capture).length + (view.list?.capture ? 1 : 0)
    assert.equal(captures, 1, `${screen} capture count`)
  }
})

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

test('no visible containers overlap', () => {
  for (const screen of screens) {
    const view = viewFor(state(screen))
    const rects: Array<{ name: string; x: number; y: number; w: number; h: number }> = visibleBoxes(view).map(b => ({ ...b }))
    if (view.list) rects.push({ name: 'list', x: view.list.x, y: view.list.y, w: view.list.w, h: view.list.h })
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(!overlaps(rects[i], rects[j]), `${screen}: ${rects[i].name} overlaps ${rects[j].name}`)
      }
    }
  }
})

test('every screen keeps content inside the 576x288 canvas', () => {
  for (const screen of screens) {
    const view = viewFor(state(screen))
    const rects = [...view.boxes, ...(view.list ? [view.list] : [])]
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0, `${screen}/${r.name} starts outside`)
      assert.ok(r.x + r.w <= LAYOUT.W, `${screen}/${r.name} too wide`)
      assert.ok(r.y + r.h <= LAYOUT.H, `${screen}/${r.name} too tall`)
    }
  }
})

test('brief uses a native list with the top three loops', () => {
  const view = viewFor(state('brief'))
  assert.ok(view.list, 'brief has a list')
  assert.equal(view.list!.items.length, 4)
  assert.equal(view.list!.capture, true)
  assert.match(view.list!.items[0], /^Ana Ruiz — Send latest deck/)
  assert.match(view.list!.items[1], /^Launch team — Approve/)
  assert.ok(view.list!.items.every(i => i.length <= 58))
  const header = view.boxes.find(b => b.name === 'header')!
  assert.match(header.content, /^RELAY · 5 WAITING/)
  assert.match(header.content, /DEMO/)
})

test('brief header carries later and offline state', () => {
  const s = state('brief')
  s.snoozed = 1
  s.offline = true
  const header = viewFor(s).boxes.find(b => b.name === 'header')!
  assert.match(header.content, /1 LATER/)
  assert.match(header.content, /OFFLINE DEMO/)
})

function stateFor(screen: ScreenName, who: string): ViewState {
  const s = state(screen)
  const loop = loops.find(l => l.who === who)
  assert.ok(loop, `${who} loop`)
  s.detail = { loop, messages: [] }
  s.draft = loop.draft
  s.loops = [loop, ...s.loops.filter(l => l.id !== loop.id)]
  return s
}

test('sensitive asks show CHECK and require an explicit review', () => {
  const s = stateFor('detail', 'Launch team')
  const view = viewFor(s)
  const header = view.boxes.find(b => b.name === 'header')!
  const footer = view.boxes.find(b => b.name === 'footer')!
  const draft = view.boxes.find(b => b.name === 'draft')!
  assert.match(header.content, /CHECK/)
  assert.match(footer.content, /TAP review/)
  assert.match(draft.content, /DRAFT · CHECK/)
  assert.ok(view.menu.some(m => m.name === 'VIP: on'))
  assert.ok(view.menu.some(m => m.name === 'Mute sender'))
  assert.deepEqual(validateView(view), [])
  assert.deepEqual(overflow(view), [])
})

test('possible asks show MAYBE and never look like a one-tap commitment', () => {
  const s = stateFor('detail', 'Priya Shah')
  const view = viewFor(s)
  assert.match(view.boxes.find(b => b.name === 'header')!.content, /MAYBE/)
  assert.match(view.boxes.find(b => b.name === 'footer')!.content, /TAP review/)
  assert.match(view.boxes.find(b => b.name === 'draft')!.content, /Let me check and get back to you/)
})

test('draft screen keeps the safety tag for a sensitive thread', () => {
  const s = stateFor('draft', 'Launch team')
  const view = viewFor(s)
  assert.match(view.boxes.find(b => b.name === 'header')!.content, /CHECK/)
})

test('connected pair screen offers hold-to-revoke', () => {
  const s = state('pair')
  s.pair = { code: '482913', status: 'connected', expiresAt: NOW + 600_000 }
  const view = viewFor(s)
  const footer = view.boxes.find(b => b.name === 'footer')!
  assert.match(footer.content, /HOLD revoke/)
  assert.match(view.boxes.find(b => b.name === 'body')!.content, /hold to disconnect/)
  assert.equal(view.boxes.find(b => b.name === 'code'), undefined)
  assert.deepEqual(validateView(view), [])
})

test('detail carries who, the ask, message context and the draft', () => {
  const view = viewFor(state('detail'))
  const all = view.boxes.map(b => b.content).join('\n')
  assert.match(all, /ANA RUIZ · DM/)
  assert.match(all, /NEEDS\nSend latest deck/)
  assert.match(all, /DRAFT\nYes — I'll send it by 4:30\./)
  assert.match(all, /TAP send · HOLD speak · SWIPE later/)
})

test('listening is legible and names the input source', () => {
  const view = viewFor(state('listening'))
  const header = view.boxes.find(b => b.name === 'header')!
  assert.match(header.content, /● REC 0:04 · RING/)
  const wave = view.boxes.find(b => b.name === 'wave')!
  assert.equal(wave.content.length, 48)
  assert.match(wave.content, /^[▁▂▃▄▅▆▇█]+$/)
})

test('draft screen tags AI provider and keeps the footer actions', () => {
  const s = state('draft')
  s.draftProvider = 'llm'
  const view = viewFor(s)
  const header = view.boxes.find(b => b.name === 'header')!
  assert.match(header.content, /DRAFT → ANA RUIZ · AI/)
  const footer = view.boxes.find(b => b.name === 'footer')!
  assert.match(footer.content, /TAP send · HOLD redo · SWIPE later/)
})

test('sent screen reports the remainder', () => {
  const view = viewFor(state('sent'))
  const all = view.boxes.map(b => b.content).join('\n')
  assert.match(all, /● Sent to Ana Ruiz/)
  assert.match(all, /4 still waiting/)
})

test('digest renders channel names and caps at three items', () => {
  const view = viewFor(state('digest'))
  assert.ok(view.list, 'digest uses a native list')
  assert.equal(view.list!.items.length, 4)
  assert.match(view.list!.items[0], /^DeFi Digest · 20m — EigenLayer/)
  assert.match(view.list!.items[1], /^AI Daily · 55m — OpenAI/)
  assert.ok(view.list!.items.every(i => i.length <= 58))
})

test('pair screen spaces the code for glance reading', () => {
  const view = viewFor(state('pair'))
  const code = view.boxes.find(b => b.name === 'code')!
  assert.equal(code.content, '4 8 2 9 1 3')
  assert.match(view.boxes.find(b => b.name === 'header')!.content, /CONNECT TELEGRAM/)
})

test('empty brief is a calm clear state, not an error', () => {
  const s = state('brief')
  s.loops = []
  const view = viewFor(s)
  assert.equal(view.list, undefined)
  assert.match(view.boxes.map(b => b.content).join('\n'), /Nothing waiting\./)
  assert.deepEqual(validateView(view), [])
})

test('a long note is shortened to one footer line', () => {
  const s = state('brief')
  s.note = 'x'.repeat(200)
  const view = viewFor(s)
  const footer = view.boxes.find(b => b.name === 'footer')!
  assert.ok(footer.content.length <= 58)
})
