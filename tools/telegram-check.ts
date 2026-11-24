/**
 * Read-only Telegram credential/connectivity check.
 * Does not log in, does not send codes, does not print secrets.
 * Run: npx tsx tools/telegram-check.ts
 */
import 'dotenv/config'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const apiId = Number(process.env.TG_API_ID ?? 0)
const apiHash = process.env.TG_API_HASH ?? ''
if (!apiId || !apiHash) {
  console.error('Set TG_API_ID and TG_API_HASH in .env first.')
  process.exit(1)
}

async function main(): Promise<void> {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 1,
    useWSS: true,
    deviceModel: 'Relay G2 check',
    systemVersion: '1.0.0',
    appVersion: '0.1.0',
  })
  await client.connect()
  try {
    const config = (await client.invoke(new Api.help.GetConfig())) as unknown as {
      thisDc?: number
      dcOptions?: unknown[]
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          apiIdAccepted: true,
          thisDc: config.thisDc ?? null,
          dcOptions: config.dcOptions?.length ?? 0,
        },
        null,
        2,
      ),
    )
  } finally {
    await client.disconnect().catch(() => undefined)
  }
}

const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('connect timeout after 30s')), 30_000))
Promise.race([main(), timeout])
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Telegram credential check failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
