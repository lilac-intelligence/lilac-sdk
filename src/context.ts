import { createHash } from 'node:crypto'
import type { Message } from './tool-calls.js'

export interface ContextCounts {
  messages: number
  historyMessages: number
  toolResults: number
  totalChars: number
  systemChars?: number
  systemHash?: string
  droppedMessages?: number
}

const textOf = (m: Message | undefined): string => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((b: unknown) => {
    const part = b as { text?: unknown; content?: unknown }
    if (typeof part?.text === 'string') return part.text
    if (typeof part?.content === 'string') return part.content
    return ''
  }).join('')
}

const isToolResult = (m: Message | undefined): boolean => {
  const role = String(m?.role ?? '').toLowerCase()
  if (['tool', 'function'].includes(role)) return true
  const c = m?.content
  return Array.isArray(c) && c.length > 0
    && c.every((b: unknown) => (b as { type?: unknown })?.type === 'tool_result')
}

const identityOf = (m: Message): string =>
  createHash('sha1').update(`${String(m?.role ?? '')}${textOf(m)}`).digest('hex').slice(0, 16)

export const identitiesOf = (messages: readonly Message[]): string[] => messages.map(identityOf)

export function droppedBetween (previous: readonly string[], current: readonly string[]): number | null {
  if (!previous.length || current.length < previous.length) return null
  const have = new Map<string, number>()
  for (const id of current) have.set(id, (have.get(id) ?? 0) + 1)
  let dropped = 0
  for (const id of previous) {
    const n = have.get(id) ?? 0
    if (n > 0) have.set(id, n - 1)
    else dropped++
  }
  return dropped
}

export function countsOf (
  messages: readonly Message[] | undefined, systemPrompt?: string,
): ContextCounts | undefined {
  if (!Array.isArray(messages) || !messages.length) return undefined
  let chars = 0
  let toolResults = 0
  for (const m of messages) {
    chars += textOf(m).length
    if (isToolResult(m)) toolResults++
  }
  return {
    messages: messages.length,
    historyMessages: Math.max(0, messages.length - 1),
    toolResults,
    totalChars: chars,
    ...(systemPrompt !== undefined
      ? {
          systemChars: systemPrompt.length,
          systemHash: createHash('sha1').update(systemPrompt).digest('hex').slice(0, 16),
        }
      : {}),
  }
}

export function contextAttributes (c: ContextCounts): Record<string, unknown> {
  return {
    'lilac.context.messages': c.messages,
    'lilac.context.history_messages': c.historyMessages,
    'lilac.context.tool_results': c.toolResults,
    'lilac.context.total_chars': c.totalChars,
    ...(c.systemChars !== undefined ? { 'lilac.context.system_chars': c.systemChars } : {}),
    ...(c.systemHash !== undefined ? { 'lilac.context.system_hash': c.systemHash } : {}),
    ...(c.droppedMessages !== undefined ? { 'lilac.context.dropped_messages': c.droppedMessages } : {}),
  }
}
