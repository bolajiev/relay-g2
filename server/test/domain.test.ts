import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDigest, buildOpenLoops, classifyAsk, defaultDraft, detectUrgency, draftReply, extractAsk, shorten } from '../../shared/loops'
import { createSeed, demoUtteranceFor } from '../../shared/seed'
import { pcmToWav } from '../src/services/stt'

const NOW = 1_800_000_000_000

test('seed produces exactly the five real open loops', () => {
  const { threads, messages } = createSeed('acc_test', NOW)
  const loops = buildOpenLoops(threads, messages, NOW)
  assert.equal(loops.length, 5)
  assert.deepEqual(
    loops.map(l => l.who),
    ['Ana Ruiz', 'Launch team', 'Daniel Okafor', 'Priya Shah', 'Sofia Marin'],
  )
  assert.ok(!loops.some(l => l.who === 'Design team'), 'no-action message is not a loop')
  assert.ok(!loops.some(l => l.who === 'Nadia (Acme)'), 'closed thread is not a loop')
  assert.ok(!loops.some(l => l.who === 'DeFi Digest'), 'channels go to digest, not inbox')
})

test('asks are imperative, short and scannable', () => {
  assert.equal(
    extractAsk('Hey! Can you send me the latest deck before the design review at 5? Need it to lock the narrative.'),
    'Send latest deck before design review at 5',
  )
  assert.equal(extractAsk('@you can you approve the $2k budget for the offsite? Need to book today.'), 'Approve $2k budget for offsite')
  assert.equal(extractAsk('Loved the demo today! Are you free Thursday for coffee?'), 'Confirm Thursday for coffee')
  assert.equal(extractAsk("Quick q — what's your ARR? Considering the round."), 'Share your ARR')
  assert.equal(extractAsk('Final logo files are in Figma, no action needed. Nice work everyone!'), null)
  assert.equal(extractAsk('thanks!'), null)
  for (const text of [
    'Hey! Can you send me the latest deck before the design review at 5? Need it to lock the narrative.',
    'Sent over the contract. Please sign by Friday so we can start Monday.',
  ]) {
    const ask = extractAsk(text)
    assert.ok(ask && ask.length <= 46, `ask too long: ${ask}`)
  }
})

test('asks are classified as clear, possible or conversation', () => {
  const money = classifyAsk('Can you send me the money tomorrow?')
  assert.equal(money.classification, 'clear')
  assert.equal(money.sensitivity, 'sensitive')

  const hedged = classifyAsk('Maybe we should catch up next week?')
  assert.equal(hedged.classification, 'possible')
  assert.equal(hedged.sensitivity, 'normal')

  const social = classifyAsk('How are you?')
  assert.equal(social.classification, 'none')
  assert.equal(social.ask, null)

  const chatter = classifyAsk('Loved the demo today!')
  assert.equal(chatter.classification, 'none')

  const mixed = classifyAsk('Thanks! Can you send the deck by 5?')
  assert.equal(mixed.classification, 'clear')
  assert.match(mixed.ask ?? '', /Send deck by 5/)
})

test('sensitive and possible asks never get a default commitment', () => {
  const money = classifyAsk('Can you send me the money tomorrow?')
  const input = { ask: money.ask!, lastMessage: 'Can you send me the money tomorrow?', who: 'Sam' }
  assert.equal(defaultDraft(input, money), 'Let me check and get back to you.')

  const hedged = classifyAsk('Maybe we should catch up next week?')
  assert.equal(defaultDraft({ ask: hedged.ask!, lastMessage: '', who: 'Sam' }, hedged), 'Let me check and get back to you.')

  const normal = classifyAsk('Can you send me the latest deck before 5?')
  assert.equal(normal.classification, 'clear')
  assert.equal(normal.sensitivity, 'normal')
  assert.match(defaultDraft({ ask: normal.ask!, lastMessage: 'Can you send me the latest deck before 5?', who: 'Ana' }, normal), /sending/i)
})

test('seed carries clear/possible/sensitive and VIP metadata', () => {
  const { threads, messages } = createSeed('acc_meta', NOW)
  const loops = buildOpenLoops(threads, messages, NOW)
  const ana = loops.find(l => l.who === 'Ana Ruiz')!
  const marcus = loops.find(l => l.who === 'Launch team')!
  const priya = loops.find(l => l.who === 'Priya Shah')!
  const sofia = loops.find(l => l.who === 'Sofia Marin')!
  assert.deepEqual([ana.askClass, ana.sensitivity, ana.vip], ['clear', 'normal', true])
  assert.deepEqual([marcus.askClass, marcus.sensitivity], ['clear', 'sensitive'])
  assert.equal(priya.askClass, 'possible')
  assert.equal(sofia.sensitivity, 'sensitive')
  assert.equal(marcus.draft, 'Let me check and get back to you.')
})

test('spoken uncertainty survives the rewrite', () => {
  const ana = { ask: 'Send latest deck before design review at 5', lastMessage: '', who: 'Ana' }
  assert.equal(draftReply(ana, 'maybe friday'), "Maybe Friday — I'll confirm.")
  assert.equal(draftReply(ana, 'tell him maybe friday'), "Maybe Friday — I'll confirm.")
  assert.equal(draftReply(ana, "I might be able to do it tomorrow"), 'I might be able to do it tomorrow.')
  assert.equal(draftReply(ana, "I'll send it by 4:30"), "Yes — I'll send it by 4:30.")
})

test('urgency recognises deadlines and falls back to priority', () => {
  assert.equal(detectUrgency('Need it before the design review at 5', 3), 3)
  assert.equal(detectUrgency('Please sign by Friday', 2), 2)
  assert.equal(detectUrgency('Can you take a look when you get a chance?', 3), 2)
  assert.equal(detectUrgency('Can you take a look when you get a chance?', 1), 1)
})

test('spoken intent becomes a clean reply with the fact preserved', () => {
  const { threads, messages } = createSeed('acc_test', NOW)
  const loop = buildOpenLoops(threads, messages, NOW)[0]
  const draft = draftReply(loop, "yeah tell her I'll send it by 4:30")
  assert.equal(draft, "Yes — I'll send it by 4:30.")
  assert.ok(draft.length < 70)
})

test('intent fragments and first-person sentences both work', () => {
  const ana = { ask: 'Send latest deck before design review at 5', lastMessage: '', who: 'Ana' }
  assert.equal(draftReply(ana, 'by 4:30'), "Yes — I'll send it by 4:30.")
  assert.equal(draftReply(ana, "I'll send it tonight"), "Yes — I'll send it tonight.")
  const approve = { ask: 'Approve $2k budget for offsite', lastMessage: '', who: 'Marcus' }
  assert.equal(draftReply(approve), 'Approved — go ahead.')
})

test('shorten never cuts mid-word and stays within budget', () => {
  const out = shorten('Send the latest deck before the design review at 5', 30)
  assert.ok(out.length <= 30)
  assert.ok(!out.endsWith(' '))
  assert.ok(!/\s[a-z]$/.test(out), out)
})

test('digest is chronological, capped and channel-only', () => {
  const { threads, messages } = createSeed('acc_test', NOW)
  const items = buildDigest(threads, messages, NOW)
  assert.equal(items.length, 5)
  assert.deepEqual(items.map(i => i.channel), ['DeFi Digest', 'AI Daily', 'DeFi Digest', 'AI Daily', 'DeFi Digest'])
  assert.ok(items.every(i => i.text.length <= 72))
})

test('channels are counted for the brief footer', () => {
  const { threads } = createSeed('acc_test', NOW)
  assert.equal(threads.filter(t => t.kind === 'channel').length, 2)
})

test('WAV wrapper is a valid 16kHz mono PCM container', () => {
  const pcm = Buffer.alloc(3200, 1)
  const wav = pcmToWav(pcm, 16_000)
  assert.equal(wav.length, 44 + pcm.length)
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt32LE(24), 16_000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), pcm.length)
})

test('every demo loop has a scripted voice fallback', () => {
  const { threads } = createSeed('acc_test', NOW)
  for (const t of threads.filter(t => t.kind !== 'channel')) {
    assert.ok(demoUtteranceFor(t.id).length > 5)
  }
})
