import { execSync } from 'node:child_process'

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:4390'

function readInput() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    process.stdin.on('error', reject)
  })
}

function findPrUrl(input, toolResponse) {
  const candidates = []
  if (typeof toolResponse === 'string') candidates.push(toolResponse)
  if (input.tool_response && typeof input.tool_response === 'string') candidates.push(input.tool_response)
  if (typeof input.tool_response === 'object') {
    try {
      candidates.push(JSON.stringify(input.tool_response))
    } catch {
      // ignore
    }
  }
  const haystack = candidates.join('\n')
  const match = haystack.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)
  return match ? match[0] : ''
}

function extractIssueId(input, toolResponse) {
  const sources = [
    input.tool_input && input.tool_input.head_branch,
    input.tool_input && input.tool_input.branch,
    input.tool_input && input.tool_input.command,
    typeof toolResponse === 'string' ? toolResponse : '',
  ]
  const haystack = sources.filter(Boolean).join('\n')
  const match = haystack.match(/\b[A-Z]{2,8}-\d+\b/)
  if (match) return match[0]
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim()
    const branchMatch = branch.match(/\b[A-Z]{2,8}-\d+\b/)
    if (branchMatch) return branchMatch[0]
  } catch {
    // not a git repo or no branch
  }
  return ''
}

async function main() {
  const input = await readInput()
  if (input.hook_event_name !== 'PostToolUse') return

  const toolResponse = input.tool_response
  const prUrl = findPrUrl(input, toolResponse)
  if (!prUrl) return

  const issueId = extractIssueId(input, toolResponse)
  try {
    await fetch(`${ORCHESTRATOR_URL}/hook-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prUrl, issueId, tool: input.tool_name }),
    })
  } catch {
    process.exitCode = 0
  }
}

main().catch(() => {
  process.exitCode = 0
})
