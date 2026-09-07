export interface DesignToken {
  name: string
  value: string
}

// Regular enough for one regex pass, no CSS parser needed — buildDesignPrompt
// (server/agent.ts) asks the agent to declare its palette/spacing/type scale
// as CSS custom properties in a single :root { } block.
export function parseDesignTokens(html: string): DesignToken[] {
  const rootMatch = html.match(/:root\s*\{([^}]*)\}/)
  if (!rootMatch) return []
  const tokens: DesignToken[] = []
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rootMatch[1]))) tokens.push({ name: m[1], value: m[2].trim() })
  return tokens
}

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i

export function isColorToken(value: string): boolean {
  return COLOR_RE.test(value.trim())
}
