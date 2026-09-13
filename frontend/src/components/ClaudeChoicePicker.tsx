import { CLAUDE_EFFORTS, CLAUDE_MODELS, type ClaudeChoice } from '../types.ts'

// Session-header model/effort picker for Ideation and Design. A change applies
// from the next turn — the running one keeps what it started with.
export default function ClaudeChoicePicker({ choice, onChange }: { choice: ClaudeChoice; onChange: (choice: ClaudeChoice) => void }) {
  return (
    <div className="claude-choice">
      <select
        className="ideation-project-picker"
        value={choice.model ?? ''}
        onChange={(e) => onChange({ ...choice, model: (e.target.value || undefined) as ClaudeChoice['model'] })}
        aria-label="Model"
      >
        <option value="">Default model</option>
        {CLAUDE_MODELS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select
        className="ideation-project-picker"
        value={choice.effort ?? ''}
        onChange={(e) => onChange({ ...choice, effort: (e.target.value || undefined) as ClaudeChoice['effort'] })}
        aria-label="Effort"
      >
        <option value="">Default effort</option>
        {CLAUDE_EFFORTS.map((level) => (
          <option key={level} value={level}>
            {level} effort
          </option>
        ))}
      </select>
    </div>
  )
}
