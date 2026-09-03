import { assistantOutputText, type WorkbenchRunProjection } from './aidenClient'

export interface RecoveredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isStreaming?: boolean
}

export function completedRunMessages(
  projection: WorkbenchRunProjection,
  timestamp: number,
): RecoveredMessage[] {
  if (!projection.receipt.terminal) return []
  const prompt = projection.job?.goal?.trim() ?? ''
  const reply = assistantOutputText(projection).trim()
    || projection.receipt.summary?.trim()
    || ''
  const messages: RecoveredMessage[] = []
  if (prompt) messages.push({
    id: `recovered-user-${projection.identity.jobId}`,
    role: 'user',
    content: prompt,
    timestamp,
  })
  if (reply) messages.push({
    id: `recovered-assistant-${projection.identity.attemptId}`,
    role: 'assistant',
    content: reply,
    timestamp,
    isStreaming: false,
  })
  return messages
}

export function resolveWorkbenchOnboarding(
  storedState: string | null,
  durableSessionCount: number,
): { done: boolean; persist: boolean } {
  if (storedState === 'complete') return { done: true, persist: false }
  if (durableSessionCount > 0) return { done: true, persist: true }
  return { done: false, persist: false }
}
