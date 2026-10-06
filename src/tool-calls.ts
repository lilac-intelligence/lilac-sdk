export interface Message {
  role?: string
  content?: unknown
  tool_call_id?: string
  call_id?: string
  output?: unknown
  [key: string]: unknown
}

export interface ToolAnnotation {
  effect?: 'read_only' | 'writes' | 'irreversible' | string
  action?: string
  gated_by?: string
}

export interface DerivedToolCall {
  id: string
  name: string
  args?: string
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined

export function toolCallsOf (response: unknown): DerivedToolCall[] {
  const r = response as Record<string, any> | undefined
  if (!r || typeof r !== 'object') return []
  const out: DerivedToolCall[] = []

  for (const choice of Array.isArray(r.choices) ? r.choices : []) {
    for (const c of choice?.message?.tool_calls ?? []) {
      const name = str(c?.function?.name) ?? str(c?.name)
      if (!name) continue
      out.push({ id: str(c?.id) ?? `${name}-${out.length}`, name, ...(str(c?.function?.arguments) ? { args: c.function.arguments } : {}) })
    }
  }

  for (const item of Array.isArray(r.output) ? r.output : []) {
    if (item?.type !== 'function_call') continue
    const name = str(item?.name)
    if (!name) continue
    out.push({ id: str(item?.call_id) ?? str(item?.id) ?? `${name}-${out.length}`, name, ...(str(item?.arguments) ? { args: item.arguments } : {}) })
  }

  for (const block of Array.isArray(r.content) ? r.content : []) {
    if (block?.type !== 'tool_use') continue
    const name = str(block?.name)
    if (!name) continue
    const args = block?.input === undefined ? undefined : JSON.stringify(block.input)
    out.push({ id: str(block?.id) ?? `${name}-${out.length}`, name, ...(args ? { args } : {}) })
  }

  return out
}

export function toolResultsOf (messages: readonly Message[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of messages ?? []) {
    const bag = m as Record<string, any>

    const id = str(bag.tool_call_id) ?? str(bag.call_id)
    if (id) {
      const said = typeof bag.content === 'string' ? bag.content
        : typeof bag.output === 'string' ? bag.output
        : bag.output !== undefined ? JSON.stringify(bag.output) : undefined
      if (said !== undefined) { out.set(id, said); continue }
    }

    for (const block of Array.isArray(bag.content) ? bag.content : []) {
      if (block?.type !== 'tool_result') continue
      const useId = str(block?.tool_use_id)
      if (!useId) continue
      const c = block?.content
      out.set(useId, typeof c === 'string' ? c : JSON.stringify(c ?? ''))
    }
  }
  return out
}
