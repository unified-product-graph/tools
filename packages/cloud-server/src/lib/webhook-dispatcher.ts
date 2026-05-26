/**
 * Webhook delivery (UPG-553).
 *
 * Mutations emit `WebhookEvent`s (via `PgStore`'s event sink); this dispatcher
 * looks up the active webhooks registered for that product + event and POSTs
 * the payload to each — async, HMAC-signed, with bounded retry/backoff and
 * auto-disable on a permanent 4xx.
 *
 * Delivery is fire-and-forget from the mutation's perspective (`emit`): it runs
 * AFTER the mutation commits and never throws back into the write path. The
 * outbound `fetch` is injectable so tests exercise delivery without real HTTP.
 */
import type { Pool } from 'pg'
import { createHmac } from 'node:crypto'

export interface WebhookEvent {
  productId: string
  /** e.g. `node.created`, `edge.deleted`. */
  event: string
  payload: Record<string, unknown>
}

export interface DeliveryResponse { status: number }
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<DeliveryResponse>

export interface DispatcherOptions {
  /** Injectable outbound HTTP. Defaults to global fetch. */
  fetchFn?: FetchLike
  /** Total attempts per delivery (default 3). */
  maxAttempts?: number
  /** Base backoff; attempt n waits backoffMs * 2^(n-1) (default 250ms). */
  backoffMs?: number
}

interface WebhookRow { id: string; event: string; url: string; secret: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class WebhookDispatcher {
  private readonly fetchFn: FetchLike
  private readonly maxAttempts: number
  private readonly backoffMs: number

  constructor(private readonly pool: Pool, opts: DispatcherOptions = {}) {
    this.fetchFn =
      opts.fetchFn ??
      ((url, init) => fetch(url, init).then((r) => ({ status: r.status })))
    this.maxAttempts = opts.maxAttempts ?? 3
    this.backoffMs = opts.backoffMs ?? 250
  }

  /**
   * Fire-and-forget entry point used by the store's event sink. Never throws
   * into the caller; delivery errors are logged to stderr.
   */
  emit(event: WebhookEvent): void {
    void this.dispatch(event).catch((err) =>
      process.stderr.write(`[webhook] dispatch failed for ${event.event}: ${String(err)}\n`),
    )
  }

  /** Deliver `event` to every active webhook registered for its product+event. */
  async dispatch(event: WebhookEvent): Promise<void> {
    const { rows } = await this.pool.query<WebhookRow>(
      `SELECT id, event, url, secret FROM upg.webhooks
       WHERE product_id = $1 AND active = true AND (event = $2 OR event = '*')`,
      [event.productId, event.event],
    )
    await Promise.all(rows.map((hook) => this.deliver(hook, event)))
  }

  private async deliver(hook: WebhookRow, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify({
      webhook_id: hook.id,
      event: event.event,
      product_id: event.productId,
      data: event.payload,
      delivered_at: new Date().toISOString(),
    })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-upg-event': event.event,
    }
    if (hook.secret) {
      headers['x-upg-signature'] =
        'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex')
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let status: number
      try {
        ;({ status } = await this.fetchFn(hook.url, { method: 'POST', headers, body }))
      } catch {
        status = 0 // network/transport error → treat as transient
      }
      if (status >= 200 && status < 300) return // delivered
      // Permanent client error (except 429 rate-limit) → disable the registration.
      if (status >= 400 && status < 500 && status !== 429) {
        await this.disable(hook.id)
        return
      }
      // Transient (5xx / 429 / network): back off and retry.
      if (attempt < this.maxAttempts) await sleep(this.backoffMs * 2 ** (attempt - 1))
    }
    // Retries exhausted on a transient error — leave active for the next event.
  }

  private async disable(id: string): Promise<void> {
    await this.pool.query(`UPDATE upg.webhooks SET active = false WHERE id = $1`, [id])
  }
}
