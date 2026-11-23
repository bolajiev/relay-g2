import { createApp } from './app'
import { loadConfig } from './config'
import { Store } from './store'

const config = loadConfig()
const store = new Store(config.dataFile)
const app = createApp({ store, config })

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[relay] listening on http://localhost:${config.port}`)
  console.log(
    `[relay] demo=${config.demoEnabled} telegram=${config.telegram.enabled} llm=${config.llm.enabled} stt=${
      config.stt.enabled || Boolean(config.stt.localBin)
    }`,
  )
  console.log(`[relay] pair page: ${config.publicUrl}/pair`)
})

function shutdown(signal: string): void {
  console.log(`[relay] ${signal} — closing`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
