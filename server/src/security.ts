import crypto from 'node:crypto'

export function randomToken(prefix = 'rl'): string {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function randomPairCode(): string {
  return String(crypto.randomInt(100000, 1000000))
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64url'), enc.toString('base64url'), tag.toString('base64url')].join('.')
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [ivPart, dataPart, tagPart] = payload.split('.')
  if (!ivPart || !dataPart || !tagPart) throw new Error('bad ciphertext')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8')
}

/** Fixed-window in-memory rate limiter. Good enough for pairing endpoints. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (entry.count >= this.limit) return false
    entry.count += 1
    return true
  }
}
