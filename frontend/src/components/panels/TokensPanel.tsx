import { isColorToken, type DesignToken } from '../../lib/designTokens.ts'

export default function TokensPanel({ tokens }: { tokens: DesignToken[] }) {
  return (
    <div className="design-tokens-list">
      {tokens.length === 0 && <p className="hint">No design tokens declared in this mockup yet.</p>}
      {tokens.map((t) => (
        <div key={t.name} className="design-token-row">
          {isColorToken(t.value) && <span className="design-token-swatch" style={{ background: t.value }} />}
          <code className="design-token-name">{t.name}</code>
          <code className="design-token-value">{t.value}</code>
        </div>
      ))}
    </div>
  )
}
