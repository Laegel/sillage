import React from 'react'
import { updateIssue, applyPlan } from '../api.ts'
import type { Plan } from '../types.ts'

export default function PlansView({ plans, onApply, disabled }: { plans: Plan[]; onApply?: () => void; disabled?: boolean }) {
  const [applying, setApplying] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  if (!plans.length) {
    return (
      <div className="plans-empty">
        <p>No plans yet.</p>
        <p className="hint">Start a refine turn and ask the agent to persist a plan — it will save it via the orchestrator.</p>
      </div>
    )
  }

  const handleApply = async (plan: Plan) => {
    setApplying(plan.planId)
    setError(null)
    try {
      await updateIssue(plan.issueId || '', { description: plan.content })
      await applyPlan(plan.planId)
      onApply?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(null)
    }
  }

  return (
    <div className="plans">
      {error && <div className="plans-error">{error}</div>}
      {plans.map((plan) => (
        <div key={plan.planId} className={`plan-card ${plan.appliedAt ? 'applied' : ''}`}>
          <div className="plan-header">
            <span className="plan-title">{plan.title || 'Untitled plan'}</span>
            <span className="plan-meta">
              {new Date(plan.createdAt).toLocaleString()}
              {plan.appliedAt && <> • applied {new Date(plan.appliedAt).toLocaleString()}</>}
            </span>
          </div>
          <pre className="plan-content">{plan.content.slice(0, 800)}{plan.content.length > 800 ? '\n… (truncated)' : ''}</pre>
          {!plan.appliedAt && (
            <button
              type="button"
              className="plan-apply-btn"
              disabled={applying === plan.planId || disabled}
              onClick={() => handleApply(plan)}
            >
              {applying === plan.planId ? 'Applying…' : 'Apply'}
            </button>
          )}
          {plan.appliedAt && <span className="plan-badge applied">Applied</span>}
        </div>
      ))}
    </div>
  )
}
