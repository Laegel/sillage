import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { LinearStoreLike } from './types.ts'

// Deliberately a separate HTTP server from the main API/WS one (see the
// comment above server.listen() in index.ts) — this is the only endpoint on
// this orchestrator meant to be reachable from outside localhost (tunneled
// via ngrok), so it gets its own port and its own, narrower trust boundary:
// every request must carry a valid Linear-Signature or it's rejected before
// the body is even parsed.
const SIGNATURE_HEADER = 'linear-signature'
const MAX_CLOCK_SKEW_MS = 60_000

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(signatureHeader, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function startWebhookListener({
  linear,
  broadcast,
  port,
}: {
  linear: LinearStoreLike
  broadcast: (payload: Record<string, unknown>) => void
  port: number
}): void {
  const secret = process.env.LINEAR_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[webhook-listener] LINEAR_WEBHOOK_SECRET not set — not starting the webhook listener.')
    return
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    try {
      const rawBody = await readRawBody(req)
      if (!verifySignature(rawBody, req.headers[SIGNATURE_HEADER] as string | undefined, secret)) {
        res.writeHead(401).end()
        return
      }
      const payload = JSON.parse(rawBody.toString('utf8'))
      const webhookTimestamp = Number(payload.webhookTimestamp)
      if (Number.isFinite(webhookTimestamp) && Math.abs(Date.now() - webhookTimestamp) > MAX_CLOCK_SKEW_MS) {
        res.writeHead(401).end()
        return
      }
      res.writeHead(200).end()

      if (payload.type !== 'Issue') return
      const identifier = payload.data?.identifier
      if (typeof identifier !== 'string') return

      if (payload.action === 'create') {
        linear.invalidateIssue(identifier)
        const issue = await linear.getIssue(identifier).catch(() => undefined)
        broadcast({ type: 'issue_created', issueId: identifier, issue })
      } else if (payload.action === 'update') {
        linear.invalidateIssue(identifier)
        broadcast({ type: 'issue_updated', issueId: identifier })
      } else if (payload.action === 'remove') {
        linear.invalidateIssue(identifier)
        broadcast({ type: 'issue_removed', issueId: identifier })
      }
    } catch (err: any) {
      console.error('[webhook-listener] error handling webhook:', err.message)
      if (!res.headersSent) res.writeHead(500).end()
    }
  })

  // A bind failure (e.g. the port's already taken by a leftover process)
  // must not take the main API/WS server down with it — this listener is
  // strictly additive.
  server.on('error', (err: any) => {
    console.error(`[webhook-listener] failed to start on port ${port}:`, err.message)
  })

  server.listen(port, () => {
    console.log(`[webhook-listener] listening on http://0.0.0.0:${port}`)
  })
}
