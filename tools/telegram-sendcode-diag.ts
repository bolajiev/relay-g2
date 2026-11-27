/** Diagnostic: inspect auth.sendCode delivery type/next type/timeout. Does not print the code hash. */
import 'dotenv/config'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const apiId = Number(process.env.TG_API_ID ?? 0)
const apiHash = process.env.TG_API_HASH ?? ''
const phone = process.env.TG_DIAG_PHONE
if (!apiId || !apiHash || !phone) {
  console.error('Set TG_API_ID, TG_API_HASH and TG_DIAG_PHONE in .env first.')
  process.exit(1)
}

async function main(): Promise<void> {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 1,
    useWSS: true,
    deviceModel: 'Relay G2 diag',
    systemVersion: '1.0.0',
    appVersion: '0.1.0',
  })
  await client.connect()
  try {
    const res = (await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    )) as unknown as {
      className?: string
      type?: { className?: string; length?: number }
      nextType?: { className?: string } | null
      timeout?: number | null
    }
    console.log(
      JSON.stringify(
        {
          result: res.className ?? null,
          type: res.type?.className ?? null,
          codeLength: res.type?.length ?? null,
          nextType: res.nextType?.className ?? null,
          timeoutSeconds: res.timeout ?? null,
        },
        null,
        2,
      ),
    )
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

Promise.race([
  main(),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout 30s')), 30_000)),
])
  .then(() => process.exit(0))
  .catch(err => {
    console.error('sendCode diagnostic failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
