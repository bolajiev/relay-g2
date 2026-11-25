import crypto from 'node:crypto'
import type { Config } from '../config'
import { ServiceError } from '../errors'
import { minutesBetween } from '../../../shared/loops'
import type { MarketSignal, MarketView, PaperPosition } from '../../../shared/types'
import type { Store } from '../store'

interface HyperContext {
  markPrice: number
  funding: number
  openInterest: number
  prevDayPrice: number
  source: 'hyperliquid' | 'fixture'
}

const FIXTURE: HyperContext = {
  markPrice: 57_436,
  funding: 0.0000087022,
  openInterest: 33_814,
  prevDayPrice: 60_438,
  source: 'fixture',
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/**
 * Relay Risk: a Telegram channel signal plus a live Hyperliquid market context
 * and a PAPER position. De-risking is a local paper action — no exchange keys,
 * no real funds, no orders.
 */
export class MarketService {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
  ) {}

  private async context(asset = 'BTC'): Promise<HyperContext> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4_000)
    try {
      const res = await fetch(this.config.marketApiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as unknown
      if (!Array.isArray(data) || data.length < 2) throw new Error('bad market payload')
      const meta = data[0] as { universe?: Array<{ name?: string }> }
      const ctxs = data[1] as Array<Record<string, unknown>>
      const names = meta.universe?.map(u => u.name) ?? []
      const idx = names.indexOf(asset)
      if (idx < 0 || !ctxs[idx]) throw new Error('asset missing')
      const c = ctxs[idx]
      return {
        markPrice: Number(c.markPx),
        funding: Number(c.funding),
        openInterest: Number(c.openInterest),
        prevDayPrice: Number(c.prevDayPx),
        source: 'hyperliquid',
      }
    } catch {
      return FIXTURE
    } finally {
      clearTimeout(timer)
    }
  }

  private signal(accountId: string): MarketSignal {
    const channels = new Map(
      this.store
        .threads(accountId)
        .filter(t => t.kind === 'channel')
        .map(t => [t.id, t.title]),
    )
    const messages = this.store
      .messages(accountId)
      .filter(m => m.direction === 'in' && channels.has(m.threadId) && /\b(BTC|ETH)\b/i.test(m.text))
      .sort((a, b) => b.at - a.at)
    const latest = messages[0]
    if (latest) {
      return {
        channel: channels.get(latest.threadId) ?? 'Channel',
        text: latest.text,
        ageMinutes: minutesBetween(latest.at, Date.now()),
        asset: /\bETH\b/i.test(latest.text) ? 'ETH' : 'BTC',
      }
    }
    return {
      channel: 'DeFi Digest',
      text: 'BTC perp open interest is at a 30-day high; funding is flipping.',
      ageMinutes: 15,
      asset: 'BTC',
    }
  }

  private ensurePosition(accountId: string, mark: number): PaperPosition {
    const existing = this.store.paperPosition(accountId, 'BTC')
    if (existing?.closedAt) return existing
    const valid =
      existing &&
      ((existing.side === 'long' && existing.liquidationPrice < mark) ||
        (existing.side === 'short' && existing.liquidationPrice > mark))
    if (existing && valid) return existing

    const entry = round(mark * 0.97, 1)
    const position: PaperPosition = {
      id: `pp_${crypto.randomBytes(6).toString('hex')}`,
      asset: 'BTC',
      side: 'long',
      size: 0.15,
      entry,
      leverage: 5,
      liquidationPrice: round(entry * 0.84, 1),
      openedAt: Date.now(),
    }
    this.store.setPaperPosition(accountId, position)
    return position
  }

  private metrics(position: PaperPosition, mark: number): MarketView['position'] {
    const pnlUsd = position.side === 'long' ? (mark - position.entry) * position.size : (position.entry - mark) * position.size
    const margin = (position.entry * position.size) / position.leverage
    const liqDistancePct =
      position.side === 'long' ? ((mark - position.liquidationPrice) / mark) * 100 : ((position.liquidationPrice - mark) / mark) * 100
    return {
      ...position,
      pnlUsd: round(pnlUsd, 2),
      pnlPct: margin > 0 ? round((pnlUsd / margin) * 100, 1) : 0,
      liqDistancePct: round(Math.max(0, liqDistancePct), 1),
    }
  }

  async view(accountId: string): Promise<MarketView> {
    const [context, signal] = await Promise.all([this.context('BTC'), Promise.resolve(this.signal(accountId))])
    const position = this.ensurePosition(accountId, context.markPrice)
    return {
      signal,
      asset: 'BTC',
      markPrice: context.markPrice,
      funding: context.funding,
      openInterest: context.openInterest,
      prevDayPrice: context.prevDayPrice,
      source: context.source,
      paper: true,
      position: this.metrics(position, context.markPrice),
    }
  }

  async deRisk(accountId: string, asset: string, percent: number): Promise<MarketView> {
    const view = await this.view(accountId)
    if (view.asset !== asset) throw new ServiceError(400, 'market_asset_unsupported', 'Only the paper BTC position is available.')
    if (!view.position.size || view.position.closedAt) throw new ServiceError(409, 'market_position_closed', 'The paper position is already closed.')
    const pct = Math.max(10, Math.min(100, Math.round(percent)))
    const remaining = 1 - pct / 100
    const mark = view.markPrice
    let next: PaperPosition
    if (remaining <= 0) {
      next = { ...view.position, size: 0, closedAt: Date.now() }
    } else {
      const distance =
        view.position.side === 'long' ? mark - view.position.liquidationPrice : view.position.liquidationPrice - mark
      const liq =
        view.position.side === 'long'
          ? mark - distance / remaining
          : mark + distance / remaining
      next = {
        ...view.position,
        size: round(view.position.size * remaining, 4),
        liquidationPrice: round(liq, 1),
      }
    }
    this.store.setPaperPosition(accountId, next)
    this.store.recordPaperDeRisk(accountId)
    return { ...view, position: this.metrics(next, mark) }
  }
}
