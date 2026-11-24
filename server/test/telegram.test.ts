import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../src/config'
import { TelegramService, type GramModule } from '../src/services/telegram'

const calls: string[] = []
let passwordNeeded = false

class FakeSession {
  constructor(_session = '') {}
  save(): string {
    return 'session-string'
  }
}

class FakeSignIn {
  constructor(public readonly args: Record<string, unknown>) {}
}

class FakeGetPassword {}

class FakeClient {
  session = new FakeSession()

  async connect(): Promise<void> {
    calls.push('connect')
  }

  async disconnect(): Promise<void> {
    calls.push('disconnect')
  }

  async sendCode(_creds: unknown, phone: string): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }> {
    calls.push(`sendCode:${phone}`)
    return { phoneCodeHash: 'phone-hash', isCodeViaApp: true }
  }

  async invoke(request: unknown): Promise<unknown> {
    if (request instanceof FakeSignIn) {
      calls.push('signIn')
      if (passwordNeeded) throw new Error('SESSION_PASSWORD_NEEDED')
      return {}
    }
    if (request instanceof FakeGetPassword) {
      calls.push('getPassword')
      return { hint: 'pet name' }
    }
    return {}
  }

  async signInWithPassword(_creds: unknown, params: { password: () => Promise<string>; onError: () => Promise<boolean> }): Promise<unknown> {
    calls.push('signInWithPassword')
    await params.password()
    return {}
  }

  async getMe(): Promise<{ id: string; firstName: string; lastName: string; username: string }> {
    return { id: '42', firstName: 'Test', lastName: 'User', username: 'tester' }
  }

  async getDialogs(): Promise<unknown[]> {
    return [
      {
        title: 'Ana',
        isUser: true,
        entity: { id: 'ana', username: 'ana_test', bot: false, self: false },
      },
    ]
  }

  async getMessages(): Promise<unknown[]> {
    return [
      { id: 1, message: 'Can you send the deck by 5?', out: false, date: 1_800_000_000, sender: { firstName: 'Ana' } },
      { id: 2, message: '   ', out: false, date: 1_800_000_001 },
      { id: 3, message: 'Sending now.', out: true, date: 1_800_000_002 },
    ]
  }

  async sendMessage(entity: { id: string }, params: { message: string }): Promise<unknown> {
    calls.push(`send:${entity.id}:${params.message}`)
    return {}
  }

  async markAsRead(): Promise<void> {
    calls.push('read')
  }

  async getInputEntity(peer: string): Promise<{ id: string }> {
    calls.push(`entity:${peer}`)
    return { id: 'ana' }
  }
}

const fakeGram = {
  TelegramClient: FakeClient as unknown as GramModule['TelegramClient'],
  Api: {
    auth: { SignIn: FakeSignIn as unknown as GramModule['Api']['auth']['SignIn'] },
    account: { GetPassword: FakeGetPassword as unknown as GramModule['Api']['account']['GetPassword'] },
  },
}

function service(): TelegramService {
  const config = loadConfig({
    ...process.env,
    TG_API_ID: '12345',
    TG_API_HASH: 'test-hash',
    SESSION_KEY: '00'.repeat(32),
  })
  return new TelegramService(config, {
    loadGram: async () => ({ gram: fakeGram, StringSession: FakeSession as unknown as new (s?: string) => { save(): string } }),
  })
}

test('MTProto adapter completes login, snapshots chats and sends a reply', async () => {
  passwordNeeded = false
  calls.length = 0
  const tg = service()
  assert.equal(tg.enabled, true)

  const started = await tg.startLogin('123456', '+1 555 123 4567')
  assert.equal(started.isCodeViaApp, true)
  assert.ok(calls.includes('sendCode:+15551234567'))

  const verified = await tg.verify('acc_test', '123456', '54321')
  assert.equal(verified.status, 'ok')
  if (verified.status !== 'ok') return
  assert.equal(verified.session, 'session-string')
  assert.equal(verified.profile.name, 'Test User')
  assert.equal(verified.snapshot.threads.length, 1)
  assert.equal(verified.snapshot.threads[0].title, 'Ana')
  assert.equal(verified.snapshot.threads[0].kind, 'dm')
  assert.equal(verified.snapshot.threads[0].tgPeer, '@ana_test')
  assert.equal(verified.snapshot.messages.length, 2, 'empty message filtered')
  assert.deepEqual(verified.snapshot.messages.map(m => m.direction), ['in', 'out'])
  assert.ok(verified.snapshot.styleSamples.includes('Sending now.'))

  await tg.send('acc_test', 'session-string', '@ana_test', 'Yes — sending it by 5.')
  assert.ok(calls.includes('entity:@ana_test'))
  assert.ok(calls.includes('send:ana:Yes — sending it by 5.'))
  assert.ok(calls.includes('read'))
})

test('MTProto adapter handles 2FA without re-sending the login code', async () => {
  passwordNeeded = true
  calls.length = 0
  const tg = service()
  await tg.startLogin('654321', '+15550001111')
  const challenge = await tg.verify('acc_2fa', '654321', '11111')
  assert.equal(challenge.status, 'password')
  if (challenge.status === 'password') assert.equal(challenge.hint, 'pet name')
  assert.equal(calls.filter(c => c === 'sendCode:+15550001111').length, 1, 'code requested once')

  const verified = await tg.verify('acc_2fa', '654321', '11111', 'correct horse')
  assert.equal(verified.status, 'ok')
  assert.ok(calls.includes('signInWithPassword'))
  assert.equal(calls.filter(c => c === 'signIn').length, 1, 'password flow does not repeat SignIn')
})
