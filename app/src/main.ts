import { OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { demoUtteranceFor } from '../../shared/seed'
import type { Inbox } from '../../shared/types'
import { ApiError, RelayApi } from './api'
import { MicCapture, toBase64 } from './audio'
import { GlassUI } from './ui'
import {
  listeningHeader,
  listeningWave,
  viewFor,
  type ViewState,
} from './views'

type Screen = ViewState['screen']

const state: ViewState = {
  screen: 'boot',
  loops: [],
  selected: 0,
  detail: null,
  draft: '',
  draftProvider: '',
  digest: [],
  sent: null,
  pair: null,
  note: '',
  demo: true,
  offline: false,
  snoozed: 0,
  listeningSeconds: 0,
  listeningBars: [],
  listeningSource: '',
  busy: false,
}

const api = new RelayApi()
const mic = new MicCapture()
const bridge = await waitForEvenAppBridge()
const ui = new GlassUI(bridge)

let ready = false
let listening = false
let listenStartedAt = 0
let listenTimer: number | undefined
let pairTimer: number | undefined
let noteTimer: number | undefined
let sentTimer: number | undefined
let suppressClickUntil = 0
let lastDoubleAt = 0
let renderQueue: Promise<void> = Promise.resolve()

function log(message: string): void {
  console.log(`RELAY ${message}`)
}

function paint(): Promise<void> {
  renderQueue = renderQueue
    .then(async () => { await ui.render(viewFor(state)) })
    .catch(err => console.error('RELAY render failed', err))
  return renderQueue
}

function setNote(text: string, ttl = 5000): void {
  state.note = text
  if (noteTimer) window.clearTimeout(noteTimer)
  if (ttl > 0) {
    noteTimer = window.setTimeout(() => {
      if (state.note === text && (state.screen === 'brief' || state.screen === 'detail' || state.screen === 'draft')) {
        state.note = ''
        void paint()
      }
    }, ttl)
  }
}

function applyInbox(inbox: Inbox): void {
  state.loops = inbox.loops
  state.snoozed = inbox.snoozed
  state.demo = inbox.demo
  state.offline = api.offline
  state.selected = Math.min(state.selected, Math.max(0, Math.min(2, state.loops.length - 1)))
}

function go(screen: Screen): void {
  state.screen = screen
}

async function openBrief(note = ''): Promise<void> {
  clearPairPolling()
  go('brief')
  state.selected = 0
  state.detail = null
  state.draft = ''
  state.draftProvider = ''
  state.sent = null
  state.note = note
  state.busy = false
  try {
    applyInbox(await api.inbox())
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Could not refresh', 0)
  }
  await paint()
  log('BRIEF')
}

async function openDetail(index: number): Promise<void> {
  const loop = state.loops[index]
  if (!loop) return
  state.selected = index
  state.detail = { loop, messages: [] }
  state.draft = loop.draft
  state.draftProvider = ''
  state.note = ''
  state.busy = false
  go('detail')
  await paint()
  log(`OPEN ${loop.who}`)
  try {
    const detail = await api.detail(loop.threadId)
    state.detail = detail
    state.draft = detail.loop.draft
    state.draftProvider = api.offline ? 'offline' : 'rules'
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Using cached draft', 4000)
  }
  await paint()
}

async function openDigest(): Promise<void> {
  clearPairPolling()
  go('digest')
  state.note = ''
  state.busy = false
  if (!state.digest.length) await paint()
  try {
    state.digest = await api.digest()
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Digest unavailable', 0)
  }
  await paint()
  log('DIGEST')
}

async function openPair(): Promise<void> {
  clearPairPolling()
  go('pair')
  state.pair = null
  state.note = ''
  await paint()
  try {
    const info = await api.pairNew()
    state.pair = {
      code: info.code,
      status: 'waiting',
      expiresAt: info.expiresAt,
      url: info.pairUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, ''),
    }
    await paint()
    startPairPolling(info.code)
    log(`PAIR ${info.code}`)
  } catch (err) {
    const message = err instanceof ApiError && err.status === 0 ? 'Relay server offline. Pairing needs it.' : err instanceof Error ? err.message : 'Could not create code'
    setNote(message, 0)
    await paint()
  }
}

function clearPairPolling(): void {
  if (pairTimer) {
    window.clearInterval(pairTimer)
    pairTimer = undefined
  }
}

function startPairPolling(code: string): void {
  clearPairPolling()
  pairTimer = window.setInterval(async () => {
    if (state.screen !== 'pair' || !state.pair) return
    try {
      const status = await api.pairStatus(code)
      if (state.pair) state.pair.status = status.status
      if (status.status === 'connected') {
        clearPairPolling()
        state.demo = false
        state.offline = false
        log('PAIRED')
        await openBrief('Telegram connected')
        return
      }
      await paint()
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        clearPairPolling()
        setNote('Code expired. Tap to get a new one.', 0)
        await paint()
      }
    }
  }, 2500)
}

async function back(): Promise<void> {
  clearPairPolling()
  if (state.screen === 'draft' || state.screen === 'sent') {
    if (state.detail) {
      go('detail')
      await paint()
      return
    }
  }
  await openBrief()
}

async function startListening(source: 'glasses' | 'ring' | 'phone'): Promise<void> {
  if (listening || !state.detail) return
  listening = true
  state.listeningSource = source
  state.listeningSeconds = 0
  state.listeningBars = []
  state.note = ''
  go('listening')
  await mic.start(bridge)
  await paint()
  listenStartedAt = Date.now()
  log(`LISTEN ${source}`)
  if (listenTimer) window.clearInterval(listenTimer)
  listenTimer = window.setInterval(() => {
    if (!listening) return
    state.listeningSeconds = (Date.now() - listenStartedAt) / 1000
    const live = mic.bars()
    if (live.length) {
      state.listeningBars = live
    } else if (state.demo) {
      // Presentation only: a gentle demo waveform so the screen reads as live.
      const t = state.listeningSeconds
      state.listeningBars = Array.from({ length: 48 }, (_, i) => 0.06 + 0.24 * Math.abs(Math.sin(i * 0.55 + t * 4)) * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.17))))
    }
    void ui.update(2, 'header', listeningHeader(state), 4)
    void ui.update(4, 'wave', listeningWave(state), 4)
    if (state.listeningSeconds >= 18) void finishListening()
  }, 160)
}

async function finishListening(): Promise<void> {
  if (!listening) return
  listening = false
  if (listenTimer) {
    window.clearInterval(listenTimer)
    listenTimer = undefined
  }
  const loop = state.detail?.loop
  const pcm = await mic.stop(bridge)
  state.listeningBars = []
  if (!loop) {
    await openBrief()
    return
  }

  state.busy = true
  state.note = ''
  go('draft')
  await paint()

  let transcript = ''
  let provider = ''
  try {
    if (pcm.length > 6400) {
      const res = await api.transcribePcm(toBase64(pcm))
      transcript = res.text
      provider = res.provider
    } else if (state.demo) {
      const res = await api.transcribeDemo(demoUtteranceFor(loop.threadId))
      transcript = res.text
      provider = res.provider
    } else {
      setNote('No speech captured. Hold and try again.', 5000)
      state.busy = false
      go('detail')
      await paint()
      return
    }
  } catch (err) {
    if (state.demo) {
      try {
        const res = await api.transcribeDemo(demoUtteranceFor(loop.threadId))
        transcript = res.text
        provider = res.provider
      } catch {
        transcript = ''
      }
    }
    if (!transcript) {
      setNote(err instanceof Error ? err.message : 'Could not transcribe', 5000)
      state.busy = false
      go('detail')
      await paint()
      return
    }
  }

  if (!transcript.trim()) {
    setNote('Nothing heard. Hold and speak.', 5000)
    state.busy = false
    go('detail')
    await paint()
    return
  }

  log(`HEARD ${transcript.slice(0, 80)}`)
  try {
    const result = await api.draft(loop.threadId, transcript)
    state.draft = result.draft
    state.draftProvider = provider === 'demo' ? 'demo' : result.provider === 'llm' ? 'llm' : api.offline ? 'offline' : 'rules'
    log(`DRAFT ${state.draft.slice(0, 90)}`)
  } catch (err) {
    state.draft = loop.draft
    state.draftProvider = api.offline ? 'offline' : 'rules'
    setNote(err instanceof Error ? err.message : 'Draft unavailable', 5000)
  }
  state.busy = false
  go('draft')
  await paint()
}

async function cancelListening(): Promise<void> {
  listening = false
  if (listenTimer) {
    window.clearInterval(listenTimer)
    listenTimer = undefined
  }
  mic.cancel()
  try {
    await bridge.audioControl(false)
  } catch {
    /* best effort */
  }
  state.listeningBars = []
  state.listeningSeconds = 0
  go('detail')
  await paint()
}

async function sendDraft(): Promise<void> {
  const loop = state.detail?.loop
  if (!loop || state.busy) return
  const text = (state.draft || loop.draft).trim()
  if (!text) return
  state.busy = true
  setNote('Sending...', 0)
  await paint()
  try {
    const result = await api.send(loop.threadId, text)
    state.sent = { who: loop.who, remaining: result.remaining }
    state.busy = false
    state.note = ''
    go('sent')
    await paint()
    log(`SENT ${loop.who} remaining=${result.remaining}`)
    if (sentTimer) window.clearTimeout(sentTimer)
    sentTimer = window.setTimeout(() => {
      if (state.screen === 'sent') void openBrief()
    }, 1700)
  } catch (err) {
    state.busy = false
    setNote(err instanceof Error ? err.message : 'Send failed', 0)
    await paint()
  }
}

async function snoozeCurrent(): Promise<void> {
  const loop = state.detail?.loop
  if (!loop) return
  try {
    const inbox = await api.snooze(loop.threadId, 180)
    applyInbox(inbox)
    await openBrief(`Later · ${loop.who}`)
    log('SNOOZE')
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Could not snooze', 0)
    await paint()
  }
}

async function toggleVip(): Promise<void> {
  const loop = state.detail?.loop
  if (!loop) return
  try {
    const inbox = await api.setVip(loop.threadId, !loop.vip)
    loop.vip = !loop.vip
    applyInbox(inbox)
    setNote(`VIP ${loop.vip ? 'on' : 'off'}`, 3000)
    await paint()
    log(`VIP ${loop.vip ? 'on' : 'off'}`)
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Could not update VIP', 0)
    await paint()
  }
}

async function muteCurrent(): Promise<void> {
  const loop = state.detail?.loop
  if (!loop) return
  try {
    const inbox = await api.mute(loop.threadId)
    applyInbox(inbox)
    await openBrief('Muted')
    log('MUTED')
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Could not mute', 0)
    await paint()
  }
}

async function revokeTelegram(): Promise<void> {
  try {
    const inbox = await api.revokeTelegram()
    applyInbox(inbox)
    state.demo = true
    state.offline = api.offline
    await openBrief('Telegram disconnected · demo restored')
    log('REVOKED')
  } catch (err) {
    setNote(err instanceof Error ? err.message : 'Could not revoke', 0)
    await paint()
  }
}

async function refresh(): Promise<void> {
  if (state.screen === 'digest') {
    await openDigest()
    return
  }
  if (state.screen === 'pair') {
    await openPair()
    return
  }
  await openBrief('Refreshed')
}

async function retry(): Promise<void> {
  go('boot')
  state.note = ''
  await paint()
  try {
    applyInbox(await api.boot())
    go('brief')
    await paint()
    ready = true
    log(`READY loops=${state.loops.length} offline=${api.offline}`)
  } catch (err) {
    state.offline = true
    state.note = err instanceof Error ? err.message : 'Still offline'
    go('error')
    await paint()
  }
}

function listeningSourceOf(eventSource: number | undefined): 'glasses' | 'ring' | 'phone' {
  if (eventSource === 2) return 'ring'
  if (eventSource === 1 || eventSource === 3) return 'glasses'
  return 'glasses'
}

async function handleTap(): Promise<void> {
  if (!ready) return
  if (Date.now() < suppressClickUntil) return
  switch (state.screen) {
    case 'brief':
      await openDetail(state.selected)
      break
    case 'detail': {
      const loop = state.detail?.loop
      if (loop && (loop.sensitivity === 'sensitive' || loop.askClass === 'possible')) {
        go('draft')
        await paint()
        break
      }
      await sendDraft()
      break
    }
    case 'draft':
      await sendDraft()
      break
    case 'sent':
      await openBrief()
      break
    case 'digest':
      await openDigest()
      break
    case 'pair':
      if (state.pair?.status === 'connected') await openBrief('Telegram connected')
      else if (state.pair) {
        try {
          const s = await api.pairStatus(state.pair.code)
          state.pair.status = s.status
          await paint()
        } catch {
          await openPair()
        }
      } else await openPair()
      break
    case 'error':
      await retry()
      break
    default:
      break
  }
}

async function handleDouble(): Promise<void> {
  if (!ready) return
  if (Date.now() - lastDoubleAt < 400) return
  lastDoubleAt = Date.now()
  if (listening) {
    await cancelListening()
    return
  }
  if (state.screen === 'brief' || state.screen === 'error') {
    log('EXIT')
    await ui.shutdown()
    return
  }
  await back()
}

async function handleSwipe(direction: 'up' | 'down'): Promise<void> {
  if (!ready) return
  switch (state.screen) {
    case 'brief':
      // The native list owns focus movement; it reports the index on click.
      return
    case 'detail':
      if (direction === 'up') await openBrief()
      else await snoozeCurrent()
      break
    case 'draft':
      if (direction === 'up') {
        go('detail')
        await paint()
      } else await snoozeCurrent()
      break
    case 'digest':
      await openBrief()
      break
    case 'pair':
      await openBrief()
      break
    case 'sent':
      await openBrief()
      break
    default:
      break
  }
}

async function handleMenu(id: number): Promise<void> {
  if (!ready) return
  log(`MENU ${id}`)
  if (id === 1) await openDigest()
  else if (id === 2) await openPair()
  else if (id === 3) await refresh()
  else if (id === 4) await toggleVip()
  else if (id === 5) await muteCurrent()
  else if (id === 6) await revokeTelegram()
}

let lastLongPressAt = 0

bridge.onEvenHubEvent(event => {
  const audio = event.audioEvent
  if (audio?.audioPcm) {
    mic.push(audio.audioPcm)
    return
  }
  const list = event.listEvent
  if (list) {
    const idx = typeof list.currentSelectItemIndex === 'number' ? list.currentSelectItemIndex : state.selected
    const type = list.eventType
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void handleDouble()
      return
    }
    if (type === OsEventTypeList.CLICK_EVENT || type === undefined) {
      state.selected = idx
      if (state.screen === 'brief') void openDetail(idx)
      else void handleTap()
      return
    }
    if (type === OsEventTypeList.SCROLL_TOP_EVENT || type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      state.selected = idx
      return
    }
    return
  }
  const menu = event.menuItemClickEvent
  if (menu && typeof menu.itemID === 'number') {
    void handleMenu(menu.itemID)
    return
  }
  const sys = event.sysEvent
  if (sys) {
    const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void handleDouble()
      return
    }
    if (type === OsEventTypeList.LONG_PRESS_EVENT) {
      lastLongPressAt = Date.now()
      if (!ready) return
      if (state.screen === 'detail' || state.screen === 'draft') {
        void startListening(listeningSourceOf(sys.eventSource))
      } else if (state.screen === 'brief') {
        void refresh()
      } else if (state.screen === 'digest') {
        void openDigest()
      } else if (state.screen === 'pair') {
        if (state.pair?.status === 'connected') void revokeTelegram()
        else void openPair()
      }
      return
    }
    if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) {
      suppressClickUntil = Date.now() + 500
      if (listening) void finishListening()
      return
    }
    if (type === OsEventTypeList.CLICK_EVENT) {
      if (Date.now() - lastLongPressAt < 700) return
      void handleTap()
      return
    }
    if (type === OsEventTypeList.SYSTEM_EXIT_EVENT || type === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      listening = false
      mic.cancel()
      if (listenTimer) window.clearInterval(listenTimer)
      if (pairTimer) window.clearInterval(pairTimer)
      log('CLOSED')
    }
    return
  }
  const text = event.textEvent
  if (text) {
    const type = text.eventType
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void handleDouble()
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) void handleSwipe('up')
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void handleSwipe('down')
    else if (type === OsEventTypeList.CLICK_EVENT) void handleTap()
  }
})

log('BOOT')
go('boot')
await paint()

try {
  applyInbox(await api.boot())
  go('brief')
  await paint()
  ready = true
  log(`READY loops=${state.loops.length} demo=${state.demo} offline=${state.offline} telegram=${api.features.telegram} llm=${api.features.llm} stt=${api.features.stt}`)
} catch (err) {
  state.offline = true
  state.note = err instanceof Error ? err.message : 'Boot failed'
  go('error')
  await paint()
  ready = true
  log('READY_ERROR')
}
