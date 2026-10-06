import type { Span } from './spans.js'

const anyValue = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } }
  if (v && typeof v === 'object') {
    return { kvlistValue: { values: Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: anyValue(value) })) } }
  }
  return { stringValue: String(v) }
}

const attributes = (bag: Record<string, unknown>) =>
  Object.entries(bag).filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: anyValue(value) }))

export function otlpBody (serviceName: string, spans: readonly Span[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: attributes({ 'service.name': serviceName }) },
      scopeSpans: [{
        scope: { name: 'lilac-sdk' },
        spans: spans.map(s => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: 1,
          startTimeUnixNano: String(s.startNs),
          endTimeUnixNano: String(s.endNs),
          attributes: attributes(s.attributes),
        })),
      }],
    }],
  }
}

export interface SendResult { ok: boolean; status?: number; error?: string }

export async function send (
  endpoint: string, apiKey: string | undefined, serviceName: string,
  spans: readonly Span[], timeoutMs: number,
): Promise<SendResult> {
  if (!endpoint || !spans.length) return { ok: true }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${endpoint}/v1/ingest/otlp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(otlpBody(serviceName, spans)),
      signal: controller.signal,
    })
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status }
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}
