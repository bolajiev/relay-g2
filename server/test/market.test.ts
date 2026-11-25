import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import test from 'node:test'
import { loadConfig } from '../src/config'
import { MarketService } from '../src/services/market'
import { Store } from '../src/store'

async function fakeHyperliquid() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify([
          { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
          [
            {
              funding: '0.0000087022',
              openInterest: '33814.12688',
              prevDayPx: '60438.0',
              markPx: '57436.0',
            },
            { funding: '-0.0000056576', openInterest: '640315.3', prevDayPx: '1694.5', markPx: '1614.1' },
          ],
        ]),
      )
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
    MARKET_API_BASE: base,
    TG_API_ID: '',
    TG_API_HASH: '',
  })
}

test('market view uses live Hyperliquid context and a paper position', async t => {
  const { server, base } = await fakeHyperliquid()
  t.after(() => server.close())
  const store = new Store('/tmp/relay-market-test.json', { memory: true })
  const { account } = store.createDemoAccount(1_800_000_000_000)
  const market = new MarketService(configFor(base), store)

  const view = await market.view(account.id)
  assert.equal(view.paper, true)
  assert.equal(view.source, 'hyperliquid')
  assert.equal(view.asset, 'BTC')
  assert.equal(view.markPrice, 57_436)
  assert.equal(view.funding, 0.0000087022)
  assert.equal(view.signal.channel, 'DeFi Digest')
  assert.match(view.signal.text, /BTC perp open interest/)
  assert.equal(view.position.side, 'long')
  assert.equal(view.position.size, 0.15)
  assert.ok(view.position.liquidationPrice < view.markPrice)
  assert.ok(view.position.pnlUsd > 0)
  assert.ok(view.position.liqDistancePct > 0)
})

test('paper de-risk reduces size, pushes liquidation away and closes at 100%', async t => {
  const { server, base } = await fakeHyperliquid()
  t.after(() => server.close())
  const store = new Store('/tmp/relay-market-test.json', { memory: true })
  const { account } = store.createDemoAccount(1_800_000_000_000)
  const market = new MarketService(configFor(base), store)
  const first = await market.view(account.id)

  const cut = await market.deRisk(account.id, 'BTC', 25)
  assert.equal(cut.position.size, 0.1125)
  assert.ok(cut.position.liquidationPrice < first.position.liquidationPrice)
  assert.ok(cut.position.liqDistancePct > first.position.liqDistancePct)
  assert.equal(store.account(account.id)?.stats?.paperDeRisks, 1)

  const closed = await market.deRisk(account.id, 'BTC', 100)
  assert.equal(closed.position.size, 0)
  assert.ok(closed.position.closedAt)
  await assert.rejects(() => market.deRisk(account.id, 'BTC', 25), /already closed/)
})

test('market context falls back to a fixture instead of failing the app', async () => {
  const store = new Store('/tmp/relay-market-test.json', { memory: true })
  const { account } = store.createDemoAccount(1_800_000_000_000)
  const market = new MarketService(configFor('http://127.0.0.1:1'), store)
  const view = await market.view(account.id)
  assert.equal(view.source, 'fixture')
  assert.equal(view.paper, true)
  assert.ok(view.markPrice > 0)
})
