import type { AgentEvent } from '../types.ts'
import { eventsToPlainText } from './agentEvents.ts'

const PLAN_BLOCK = /```plan\s*([\s\S]*?)```/i

export function parsePlan(events: AgentEvent[]): string | null {
  const match = eventsToPlainText(events).match(PLAN_BLOCK)
  if (!match) return null
  const plan = match[1].trim()
  return plan.length > 0 ? plan : null
}

export function stripPlanBlock(text: string): string {
  return text.replace(PLAN_BLOCK, '').trim()
}
