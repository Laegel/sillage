import { setTimeout as delay } from 'node:timers/promises'

const [issueId, classification, hookUrl] = process.argv.slice(2)

function emitText(text) {
  process.stdout.write(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n',
  )
}

const frontendLines = [
  'Reading issue context from Linear MCP...',
  `Task classified as ${classification}. Loading the ${classification} skill.`,
  `Creating feature branch feat/${issueId}-demo-change`,
  'Implementing the UI component with state and styling per the frontend skill...',
  'Updating component tests to match the new behavior...',
  `Committing changes: ${issueId}: implement requested change`,
  'Pushing branch to origin...',
  'Opening pull request with gh pr create...',
]

const backendLines = [
  'Reading issue context from Linear MCP...',
  `Task classified as ${classification}. Loading the ${classification} skill.`,
  `Creating feature branch feat/${issueId}-demo-change`,
  'Adding the API route with input validation and error handling...',
  'Adding database/query changes and updating tests...',
  `Committing changes: ${issueId}: implement requested change`,
  'Pushing branch to origin...',
  'Opening pull request with gh pr create...',
]

const lines = classification === 'frontend' ? frontendLines : backendLines

for (const line of lines) {
  await delay(320)
  emitText(line + '\n')
}

const prNumber = Math.floor(Math.random() * 9000) + 1000
const prUrl = `https://github.com/example/issue-tracker-demo/pull/${prNumber}`

await delay(300)
emitText(`PR created: ${prUrl}\n`)
emitText('Updating Linear issue status to In Review and attaching PR link.\n')

if (hookUrl) {
  try {
    await fetch(hookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl, issueId, source: 'mock-agent' }),
    })
  } catch {
    // hook relay is best-effort in mock mode
  }
}

await delay(200)
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: `Done: ${prUrl}` }) + '\n')
