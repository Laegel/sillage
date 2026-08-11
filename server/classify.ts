const FRONTEND = new Set([
  'frontend', 'front-end', 'front end', 'ui', 'component', 'react', 'page', 'screen',
  'style', 'styling', 'css', 'scss', 'markup', 'view', 'form', 'button', 'input',
  'dashboard', 'widget', 'modal', 'tooltip', 'toast', 'navigation', 'responsive',
  'toggle', 'theme', 'dark mode', 'client-side', 'client side', 'filter', 'sort',
  'empty state', 'loading', 'animation', 'color',
])

const BACKEND = new Set([
  'backend', 'back-end', 'back end', 'api', 'endpoint', 'route', 'server', 'database',
  'db', 'query', 'migration', 'schema', 'model', 'middleware', 'authentication',
  'authorization', 'auth', 'error handling', 'error handler', 'validation',
  'rate limit', 'caching', 'websocket', 'webhook', 'graphql', 'rest', 'service',
  'repository', 'job', 'worker', 'queue', 'pagination', 'logging', 'request',
  'response', 'status code', 'crud',
])

export type Classification = 'frontend' | 'backend'

export function classify(task: string): Classification {
  const text = ` ${task.toLowerCase()} `
  let frontendScore = 0
  let backendScore = 0
  for (const k of FRONTEND) if (text.includes(k)) frontendScore += 1
  for (const k of BACKEND) if (text.includes(k)) backendScore += 1
  if (frontendScore === backendScore) return frontendScore >= 2 ? 'frontend' : 'backend'
  return frontendScore > backendScore ? 'frontend' : 'backend'
}
