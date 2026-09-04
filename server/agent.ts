import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AgentEvent, Comment, Issue, DriverMode } from './types.ts'
import type { SynthesisEntry } from './synthesis-store.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const SILLAGE_ROOT = join(__dirname, '..')

function renderComments(comments: Comment[]): string {
  if (comments.length === 0) return '(none)'
  return comments.map((c) => `- ${c.authorName} (${c.createdAt}): ${c.body}`).join('\n')
}

export async function buildPrompt({
  issue,
  comments,
  task,
  projectDir,
}: {
  issue: Issue
  comments: Comment[]
  task: string
  projectDir: string
}): Promise<string> {
  return `You are a software engineer working in the repository at ${projectDir}.

LINEAR ISSUE
- identifier: ${issue.id}
- title: ${issue.title}
- description: ${issue.description}
- current status: ${issue.status}

EXISTING COMMENTS
${renderComments(comments)}

USER TASK
${task}

RULES (also enforced by CLAUDE.md)
1. Before doing anything else, check for existing work on this issue: run \`git branch --list 'feat/${issue.id}-*'\` and \`git status\`, and review the existing comments above — a prior attempt may have left a blocker note or partial-progress explanation there. If a matching branch already exists, check it out (if not already on it) and CONTINUE from there instead of starting over — assess what's already done (git status, git diff, git log) and what still remains, then pick up where it left off. Only create a new branch named feat/${issue.id}-<kebab-slug> (for example feat/${issue.id}-add-toggle) if none already exists.
2. If the description above has a "## Relevant symbols" section, it was left by an earlier refinement discussion as a fast-path hint, not gospel — for each cited symbol, look it up (e.g. \`codegraph query <name>\`, or grep as a fallback) to confirm it still exists and still matches what's described, and start your exploration there instead of a broad search. The codebase may have moved on since it was written, so re-verify rather than trust; fall back to normal from-scratch exploration for anything missing, changed, or if the section isn't present at all.
3. Commit messages must be prefixed with the Linear issue id: "${issue.id}: <summary>".
4. The PR description MUST reference the Linear issue id ${issue.id}.
5. Do NOT send any manual notification about the PR. A PostToolUse hook detects "gh pr create" and notifies the orchestrator.
6. Before opening a PR, check whether one already exists for this branch (e.g. \`gh pr list --head <branch>\`). If one exists, just push your commits to update it — do not open a duplicate. Otherwise open it with: gh pr create --title "<title>" --body "Closes ${issue.id} — <summary>"
7. Use the GitHub MCP for commit, push and PR creation. Use the Linear MCP to re-read the issue and, once the PR is open, set its status to "In Review" and attach the PR link as a comment.
8. If you get blocked — missing information, an ambiguous requirement, a decision only a human should make, or something you genuinely can't resolve yourself — stop rather than guessing or shipping something you're not confident in. Commit whatever real progress you've made first (so a resumed run doesn't lose it, per rule 1), then use the Linear MCP to: (a) add a comment on the issue stating exactly what's blocking you and what you need to proceed, @mentioning the workspace owner in that comment so they're actually notified (use the Linear MCP's own current-user/viewer lookup, or the issue's creator, to find who to mention — don't guess a name), (b) add the "Blocked" label to the issue, and (c) set the issue status back to "Todo". Do not open a PR for blocked or incomplete work.
9. When you narrate progress outside of tool calls, keep it to short, single-line notes at natural checkpoints (e.g. after finishing a step) rather than long paragraphs — this is read as a live log, not a report.
10. Do NOT write your own plan, notes, or design-doc files (e.g. PLAN.md, NOTES.md, .kilo/plans/*.md). The Linear issue is the single source of truth: if you need to record a plan of approach or a decision so it survives across turns, add it as a comment on the issue via the Linear MCP instead of a local file. This is enforced, not just requested: any such write will be denied regardless of tool (write, bash heredoc, echo redirect, sed -i, etc.) — if one is denied, that is intentional and permanent, do not retry it a different way.`
}

// First-turn framing for a "Refine" chat: unlike buildPrompt(), this never writes
// code, commits, opens a PR, or touches Linear status/labels — it's a codebase
// reality-check discussion for a still-raw Backlog idea, not an implementation run.
export async function buildRefinePrompt({
  issue,
  projectDir,
}: {
  issue: Issue
  projectDir: string
}): Promise<string> {
  return `You are reviewing a Linear issue that is still an unrefined idea, in the repository at ${projectDir}.

LINEAR ISSUE
- identifier: ${issue.id}
- title: ${issue.title}
- description: ${issue.description}

This is a discussion, not an implementation task — do not follow implementation steps yet.

RULES FOR THIS DISCUSSION
1. Explore the codebase read-only to check this idea against reality: does it fit the existing structure, is anything already half-built, are there naming/pattern conflicts, is anything technically infeasible as described?
2. Do NOT write or modify any files, do NOT create a git branch or commit, do NOT open a PR, and do NOT change this issue's Linear status or labels yourself — this is exploration and discussion only. This is enforced, not just requested: any write attempt will be denied regardless of tool (write, bash heredoc, echo redirect, sed -i, etc.) — if one is denied, that is intentional and permanent, do not retry it a different way, just continue read-only and answer from what you've already found.
3. Present 2-4 concrete options or a clear feasibility assessment with trade-offs, grounded in what you actually found in the codebase (cite real file paths).
4. If something is genuinely ambiguous or needs a decision only the user can make, ask a specific question instead of guessing.
5. Keep it conversational and concise — this is a live back-and-forth discussion, not a report.
6. If you want to persist a plan or decision for this issue, do NOT write a markdown file — use \`curl -X POST http://127.0.0.1:4390/api/plans -H "Content-Type: application/json" -d '{"title":"...","content":"...","issueId":"${issue.id}"}'\` instead. The orchestrator stores it server-side and surfaces it in the UI.`
}

// Sent as a same-session follow-up turn once the user clicks "Consolidate". The
// "Relevant symbols" ask is the other half of buildPrompt()'s rule 2: exploration
// already happened once during this discussion, so capturing what was found here
// (as name+path, not line numbers, which rot the moment anything nearby changes)
// lets the later cold implementation run skip re-discovering it from scratch.
export const CONSOLIDATE_PROMPT = `Based on our discussion so far, write a final, self-contained issue description that captures the agreed plan: the concrete goal, the approach, and any important constraints or decisions we made. Do not include meta-commentary about the discussion itself (no "we discussed" or "the user asked") — write it as the issue description should read on its own, ready for implementation. Do not write any code and do not touch git, GitHub, or Linear.

If, while exploring, you identified specific existing symbols (functions, types, classes) that the implementation will need to read, extend, or reuse, add a "## Relevant symbols" section listing only the ones that actually matter (not everything you looked at), one per line, as: symbolName (path/to/file.ts) — why it matters. This lets a fresh implementation run jump straight to the right code via a symbol lookup instead of re-exploring the codebase from scratch. Omit the section entirely if nothing specific applies.`

// Sent instead of buildRefinePrompt() when a chat session already exists (e.g. the
// page was reloaded) — Sillage doesn't persist the transcript itself, so this is how
// a reopened chat shows something instead of a blank panel.
export const RESUME_RECAP_PROMPT = `Give me a brief recap of our discussion so far and where we left off.`

// First-turn framing for an "Ideation" chat: like buildRefinePrompt(), read-only
// and never touches git/GitHub/Linear — but unlike buildRefinePrompt(), there's no
// existing Linear issue driving the conversation, and unlike a code-exploration
// task, the point is the discussion itself, not grounding every claim in the repo.
export async function buildIdeationPrompt({ projectDir, synthesis }: { projectDir: string; synthesis?: SynthesisEntry }): Promise<string> {
  const synthesisBlock = synthesis
    ? `PROJECT SYNTHESIS (captured ${synthesis.updatedAt} — may have drifted since, treat as background, not gospel)\n${synthesis.text}\n\n`
    : ''
  return `You are a brainstorming partner for a project in the repository at ${projectDir}.

${synthesisBlock}This is an open-ended discussion, not an implementation task and not a review of a specific existing issue — the user wants to think through ideas, bugs, or improvements with you the same way they would in a live conversation with a coding assistant.

RULES FOR THIS DISCUSSION
1. Be a genuine conversational partner first: ask clarifying questions, offer your own opinions, suggest alternatives, and push back when something doesn't sound right — don't just agree with whatever is proposed.
2. Don't explore or read the codebase — no grepping, no opening files, no verifying claims against the repo. Rely on the project synthesis above (if present) plus what the user tells you — don't verify it against the repo, it's a hint like the refine flow's "Relevant symbols" section, not gospel. This is a conversation, not an investigation: work from what the user describes, the same way you would with a collaborator who hasn't shown you the code. If something they say sounds off or you're unsure it's accurate, question it in conversation instead of going to check.
3. Your job is to help the user think, never to implement. Do NOT write or modify any files, do NOT create a git branch or commit, do NOT open a PR. Just as important: do NOT write patches, sketch out code, or walk through implementation steps in chat either, even when the fix seems obvious — that's a different kind of session. Once a bug or feature is understood well enough to act on, the right move is proposing it as an issue (rule 5), not describing how you'd build it.
4. Keep it conversational and concise — this is a live back-and-forth, not a report.
5. As soon as a sub-thread of the discussion lands on something concrete and actionable — a real bug, feature, or improvement the user would want tracked — proactively propose filing it, without waiting to be asked. Identify the distinct ideas worth filing (usually 1-6) and include, alongside your normal reply, exactly one fenced \`\`\`json code block containing an array of objects shaped as {"title": string, "description": string}. Each description should be a final, self-contained issue description (goal, approach, constraints) ready for implementation, not meta-commentary about the discussion. Don't fabricate issues from a discussion that hasn't reached a real conclusion yet, and don't re-propose the same idea turn after turn once you've already offered it.
6. That fenced JSON block is a real, sanctioned action, not a note for someone else to interpret: the app shows each candidate as an editable card right in this chat with a one-click "Create issue" button, so writing that block is how issues actually get created from this conversation. You cannot call Linear yourself — no direct reads or writes — so that block is your only lever here, but it's a working one; use it with that in mind, not as a consolation prize.`
}

// Producer side of buildIdeationPrompt's synthesis block. Rare/manual (a full
// re-explore) — kept separate from the incremental patch below so each stays
// a plain, single-purpose template like the rest of this file's build*Prompt
// functions, rather than one function branching on a mode.
export function buildFullSynthesisPrompt({ projectDir }: { projectDir: string }): string {
  return `You are producing a standing project synthesis for the repository at ${projectDir}, to orient future brainstorming sessions that won't explore the codebase themselves.

Explore the codebase read-only and write a concise synthesis covering:
- Tech stack and high-level architecture (major modules/packages and what each does) — brief, just enough to orient.
- A clear overview of the product's existing features and mechanics: what it actually does today, from a user's perspective. This is the most important part — a brainstorming partner needs to know what's already built so it can tell what's genuinely new versus already covered, and suggest ideas that fit the existing system instead of colliding with it.

Don't cover code style/conventions or recent commit history — a discussion partner that never reads the code has no use for either. A few hundred words — a fast-orientation briefing, not exhaustive documentation.

Do NOT write or modify any files, do NOT create a git branch or commit. Output ONLY the synthesis text itself — no preamble like "Here's the synthesis", no meta-commentary, no markdown code fence around it. It will be stored and shown verbatim.`
}

// Cheap sibling to the above, fired automatically whenever an issue reaches
// Done (see maybeUpdateSynthesis in index.ts) — patches the existing text
// against just what one issue changed instead of re-exploring the whole repo.
export function buildIncrementalSynthesisPrompt({
  projectDir,
  priorSynthesis,
  issue,
  prUrl,
}: {
  projectDir: string
  priorSynthesis: string
  issue: Issue
  prUrl?: string
}): string {
  return `You are updating a standing project synthesis for the repository at ${projectDir} after one issue just shipped. This is a cheap, targeted patch — do NOT re-explore the whole codebase.

CURRENT SYNTHESIS
${priorSynthesis}

JUST COMPLETED
- ${issue.id}: ${issue.title}
- ${issue.description}
${prUrl ? `- See exactly what changed: \`gh pr diff ${prUrl}\`` : ''}

Update the synthesis to reflect this change — touch only the parts that are now stale or incomplete because of it, leave everything else as-is. Keep the same concise, few-hundred-word scope.

Do NOT write or modify any files, do NOT create a git branch or commit. Output ONLY the full updated synthesis text — no preamble, no meta-commentary, no markdown code fence. It will be stored and shown verbatim, replacing the current one above.`
}

// First-turn framing for a "Design" chat: the only chat view allowed to write
// files, but scoped hard to designDir by both --disallowedTools and
// guard-scope.js (see spawnClaude) — this prompt is the third, cooperative
// layer, not the enforcement itself.
export function buildDesignPrompt({
  projectDir,
  designDir,
  issue,
  synthesis,
}: {
  projectDir: string
  designDir: string
  issue?: Issue
  synthesis?: SynthesisEntry
}): string {
  const issueBlock = issue ? `LINKED ISSUE\n- ${issue.id}: ${issue.title}\n- ${issue.description}\n\n` : ''
  const synthesisBlock = synthesis
    ? `PROJECT SYNTHESIS (captured ${synthesis.updatedAt} — may have drifted since, treat as background, not gospel)\n${synthesis.text}\n\n`
    : ''
  return `You are a UI designer working in the repository at ${projectDir}, producing a self-contained HTML/CSS mockup of one screen.

${issueBlock}${synthesisBlock}Write your mockup to ${designDir}/index.html — a single file, inline CSS in a <style> block and inline JS in a <script> block if you need interactivity. No external requests (fonts, CDNs, images by URL): the preview renders this file in a sandboxed iframe with no network access, so anything external will just fail to load. Use data: URIs or inline SVG for any imagery.

DESIGN TOKENS
Declare your palette, spacing scale, and type scale as CSS custom properties in a :root { } block at the top of the <style> section — e.g. --color-bg, --color-accent, --space-sm, --font-heading. Use them throughout the rest of the stylesheet rather than repeating literal values. This makes the mockup's design system inspectable at a glance.

SKILLS
If this project defines design skills under .claude/skills/, load the relevant one before designing and follow it — it carries this project's design system (colors, components, tone). Check for it before starting.

ITERATION
Rewrite index.html in place each turn rather than accumulating variants — the preview always reflects the current file's latest state, so there is only ever one live version of this screen.

BOUNDARY
Read the rest of the repository freely (existing components, styles, tokens) to match the real product's look — but you may only write inside ${designDir}. Never touch app source, git, or Linear directly; you have no access to any of them from here.`
}

function renderBacklog(backlog: Issue[]): string {
  if (backlog.length === 0) return '(no issues in this project)'
  return backlog.map((i) => `- ${i.id} [${i.status}]: ${i.title}`).join('\n')
}

// First-turn framing for a "Driver" chat: unlike Ideation/Refine, the
// The Driver never writes/edits/discusses code itself — its only lever is proposing a
// fenced json action block that the orchestrator (this server) parses and
// executes for real via the existing refine/implement pipeline. Fires
// immediately with no confirm click, per explicit user instruction, so the
// boundary on what it's allowed to propose matters more here than elsewhere.
export async function buildDriverFirstTurnPrompt({
  mode,
  projectDir,
  backlog,
  discussionContext,
}: {
  mode: DriverMode
  projectDir: string
  backlog?: Issue[]
  discussionContext?: string
}): Promise<string> {
  const modeFraming =
    mode === 'manual'
      ? `The user is driving: they'll tell you what to do in plain language (e.g. "refine LAE-102 then implement it"). Turn their instruction into an ordered action list if it implies multiple steps — each step only fires once the previous one has genuinely completed. If they're just asking a question, reply normally with an empty actions array; don't propose actions nobody asked for.`
      : `You are running autonomously — nobody is driving this turn by turn. After each turn, if there's a worthwhile next step, propose exactly ONE action (not a multi-step plan; you'll be re-invoked with a status update once it completes and can decide the next step then with full information). Use the backlog and past-discussions context below to judge what's actually worth doing. Never propose an action for an issue that's already listed as active. If nothing is worth doing right now, reply with an empty actions array and a one-line reason why.`

  const contextBlock =
    mode === 'autonomous'
      ? `\n\nCURRENT BACKLOG\n${renderBacklog(backlog ?? [])}${discussionContext ? `\n\nPAST DISCUSSIONS\n${discussionContext}` : ''}`
      : ''

  return `You are the driver for a repository at ${projectDir}. Your job is to keep existing Linear issues moving — deciding when to refine or implement them, and driving the engineers (refine/implement agents) doing that work through to completion. You never *mutate* Linear or the codebase directly yourself — but you have full read access to both, and should actually use it to see what's really going on rather than guessing from a one-line status alone.

OWNERSHIP
Any card you propose refine/implement/stop/restart on — or one you just created — becomes one you're responsible for watching end-to-end: you'll automatically get a status-update turn (not a real user message) whenever something relevant happens to it — a run finishes, a pull request lands, someone edits it by hand, or it looks stuck — until it reaches Done or you explicitly release it. When you get one of these turns, propose a next action for the card, release it (with a reason) if it's done or no longer worth watching, or do nothing if it just needs more time. If the status update alone doesn't tell you enough to judge what actually happened (e.g. "the run failed" with no detail, or repeated stalls with no visible progress), go check for yourself before deciding — see DIAGNOSING below. Don't conclude a run is stuck or failed just because you weren't handed the reason; look first.

DIAGNOSING
You have real tools, use them: Read/Grep/Bash (read-only — commands that inspect, not ones that write or commit) to check the repository directly (git log, git status, git diff, file contents), and the Linear MCP tools to read the issue's comments, attached PR, and current fields. This is how you find out whether an implement/refine run actually made progress, what a PR/comment says, or why something looks stalled — don't treat "I wasn't told why" as "there's no way to know."

${modeFraming}

HOW TO PROPOSE AN ACTION
Reply with your normal conversational text, plus exactly one fenced \`\`\`json code block containing an array of objects shaped as {"action": "refine"|"implement"|"stop"|"restart"|"release"|"merge"|"flag"|"create", "issueId"?: string, "task"?: string, "reason"?: string, "title"?: string, "description"?: string}. "issueId" is required for every action except "create", which has no existing issue yet and instead needs "title" (required) and "description" (optional, but write one — see below). "task" is required for "implement" (a self-contained instruction for what to build/fix). "reason" is required for "release" (why you're done watching this card) and "flag" (what's wrong) and unused otherwise. An empty array means no action this turn.

Propose "merge" once you're confident a card's PR is ready — merging is irreversible, so if you're not sure, check it first (\`gh pr view <url>\` or the GitHub MCP, for CI/review status) rather than merging speculatively. The existing pr_created trigger already tells you the moment a PR lands, giving you a natural point to decide then or wait.

Propose "flag" when you've reviewed a card (an implementation, a PR, an In Review status) and found it wrong or incomplete — ground the reason in what you actually found (use DIAGNOSING above: git log/diff, the PR, Linear comments) rather than a vague guess. This sends the card back to In Progress and posts your reason as a Linear comment, so the next implement pass has real context instead of just a status flip with no explanation.

Propose "create" when your own investigation (diagnosing a stall, reading a PR, checking the repo) surfaces a genuine new issue worth tracking — a real bug, a missing follow-up, groundwork another card turns out to need — not just a passing thought. Write "title" and "description" the way a good Ideation-filed issue would read: a final, self-contained description (goal, approach, constraints) ready for implementation, not meta-commentary about how you found it. The new issue lands in this session's own project and you start watching it immediately, same as anything else you act on.

BOUNDARY
Read freely — the repository and Linear (comments, PR links, status, history) are both fair game to inspect whenever it helps you decide. What you must never do is edit, comment on, or change the status of anything yourself, in Linear or the codebase — and you never touch git or GitHub directly either, even to merge. Your only way to *act* is the JSON action block — refine/implement/stop/restart/release/merge/flag on an existing issue by its identifier, or create to file a brand new one; the orchestrator executes it, you never call \`gh\`/git yourself, and you never post a Linear comment, change a status, or create an issue directly through Linear's own API/MCP — the action block is the only path, even for "flag" or "create".${contextBlock}`
}

// Built server-side whenever routeDriverSignal's event-driven mechanism flags
// one or more owned cards (a run finished, a PR landed, a stall was
// detected, the card was edited externally, ...) — so the Driver's next turn
// reasons from what actually happened, never from a stale pre-committed
// plan. Replaces the old autonomous-only buildDriverStatusUpdatePrompt: this
// fires for both modes now, since ownership itself is mode-agnostic.
export function buildDriverOwnershipUpdatePrompt(
  updates: { issueId: string; status: string; reason: string }[],
  ownedIssueIds: string[],
): string {
  const body = updates.map((u) => `- ${u.issueId} (current status: ${u.status}): ${u.reason}`).join('\n')
  return `Status update on card(s) you're watching:\n${body}\n\nYou are currently watching: ${ownedIssueIds.join(', ') || '(none)'}.\n\nThe reason given above is a terse trigger, not the full picture — if it's not enough to judge what actually happened (a vague failure, a stall, no visible progress), check the repository (git log/status/diff) and the issue's Linear comments/PR yourself before deciding, rather than guessing from the one-liner alone.\n\nFor each card above, propose a next action, release it if it's done or no longer worth watching, or do nothing. Reply as usual: text plus your fenced action block (empty array if nothing is warranted).`
}

function hookCommand(file: string): string {
  return `node ${join(SILLAGE_ROOT, '.claude', 'hooks', file)}`
}

// Force-loads the safety hooks regardless of the spawned agent's cwd — Claude Code
// otherwise discovers .claude/settings.json relative to cwd, which is now an
// arbitrary project folder under perso, not this repo.
function buildSettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: hookCommand('guard-scope.js') }] }],
      PostToolUse: [
        { matcher: 'Bash|gh pr create', hooks: [{ type: 'command', command: hookCommand('notify-pr.js') }] },
        { matcher: 'mcp__github__.*', hooks: [{ type: 'command', command: hookCommand('notify-pr.js') }] },
      ],
    },
  })
}

export function spawnClaude(
  prompt: string,
  projectDir: string,
  session?: { id: string; resume: boolean },
  readOnly?: boolean,
  designDir?: string,
): ChildProcessByStdio<null, Readable, Readable> {
  const bin = process.env.CLAUDE_BIN || 'claude'
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--mcp-config',
    join(SILLAGE_ROOT, '.claude', '.mcp.json'),
    '--settings',
    buildSettingsJson(),
  ]
  // Refine turns must never write — a genuine CLI-level tool denylist, not just
  // a prompt instruction the model can drift off. SILLAGE_READ_ONLY backs this up
  // at the guard-scope.js hook layer too (see that file), since --disallowedTools
  // covers Edit/Write/NotebookEdit but not write-intent Bash commands.
  // Task is denied too: it's Claude's own sub-agent delegation tool, and a
  // delegated sub-agent's work never appears on this stdout stream — same
  // invisibility problem as opencode/kilocode's "task" tool (see
  // buildRunnerConfigContent), confirmed live via a synthesis run that spent
  // 3+ minutes narrating about a delegated exploration instead of just doing
  // it inline where every step would have streamed back.
  // Design sessions aren't read-only (they write mockups) but still lose Task
  // for the same stream-visibility reason — exploration should stay inline.
  if (readOnly) args.push('--disallowedTools', 'Edit,Write,NotebookEdit,Task')
  else if (designDir) args.push('--disallowedTools', 'Task')
  if (session) args.push(session.resume ? '--resume' : '--session-id', session.id)
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
      SILLAGE_READ_ONLY: readOnly ? 'true' : 'false',
      ...(designDir ? { SILLAGE_DESIGN_DIR: designDir } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isAuthError(result: string): boolean {
  return /not logged in|login required|please run \/login/i.test(result || '')
}

// Claude's tool_result content is either a plain string or an array of content
// blocks (text/image/...) — mirrors the shape opencode's formatToolEvent already
// handles as a single `output` string, so results read the same way either agent.
function stringifyClaudeToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join('\n')
  }
  return content ? JSON.stringify(content) : ''
}

// Claude splits a tool call across two separate stream messages — an assistant
// tool_use block (id, name, input — nothing about the result yet) followed later
// by a user tool_result block (id, is_error, content) — correlated by id. This
// builds the AgentEvent for either half; the caller (runClaude) uses the same id
// for both so the frontend updates one card in place instead of appending two.
function claudeToolCallEvent(
  id: string,
  toolName: string,
  input: unknown,
  status: 'running' | 'complete' | 'error',
  content?: unknown,
): AgentEvent {
  const label = summarizeToolInput(input) || toolName
  if (status === 'running') {
    return { kind: 'tool_call', id, tool: toolName, label, status, input }
  }
  const text = stringifyClaudeToolContent(content)
  const trimmed = text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
  return status === 'error'
    ? { kind: 'tool_call', id, tool: toolName, label, status, input, error: trimmed }
    : { kind: 'tool_call', id, tool: toolName, label, status, input, output: trimmed }
}

export function runClaude({
  prompt,
  projectDir,
  onOutput,
  session,
  onProcess,
  readOnly,
  designDir,
}: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  session?: { id: string; resume: boolean }
  // Lets the caller (index.ts) capture a killable handle for stop/restart —
  // fired once, right after spawn, with no effect on the run itself.
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
  readOnly?: boolean
  designDir?: string
}): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(prompt, projectDir, session, readOnly, designDir)
    onProcess?.(proc)
    let result = ''
    let sawResult = false
    let fallback = false
    let settled = false
    let stderrText = ''
    // assistant messages announce a tool_use; the matching tool_result (the actual
    // output) only arrives later in a "user" message — held here until paired up.
    const pendingTools = new Map<string, { name: string; input: unknown }>()

    proc.on('error', (err) => reject(err))

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        if (!sawResult) {
          fallback = true
          if (stderrText) onOutput({ kind: 'orchestrator', text: `claude stderr: ${stderrText}` })
        }
        resolve({ exitCode: code, needsFallback: fallback, sessionId: session?.id })
      }
    })

    proc.stderr.on('data', (chunk) => {
      stderrText += chunk.toString()
    })

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'assistant') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'text' && part.text) {
              onOutput({ kind: 'text', text: part.text })
            } else if (part && typeof part === 'object' && part.type === 'tool_use' && part.id) {
              pendingTools.set(part.id, { name: part.name, input: part.input })
              onOutput(claudeToolCallEvent(part.id, part.name, part.input, 'running'))
            } else if (typeof part === 'string') {
              onOutput({ kind: 'text', text: part })
            }
            // "thinking" blocks are intentionally skipped: usually empty in the
            // consolidated message (the readable text only lives in partial
            // stream_event deltas we don't otherwise use) and not user-facing.
          }
        } else if (msg.type === 'user') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'tool_result' && part.tool_use_id) {
              const pending = pendingTools.get(part.tool_use_id)
              pendingTools.delete(part.tool_use_id)
              onOutput(
                claudeToolCallEvent(
                  part.tool_use_id,
                  pending?.name || 'tool',
                  pending?.input,
                  part.is_error ? 'error' : 'complete',
                  part.content,
                ),
              )
            }
          }
        } else if (msg.type === 'system' && msg.subtype === 'post_turn_summary') {
          onOutput({
            kind: 'status',
            category: msg.status_category,
            detail: msg.status_detail,
            needsAction: msg.needs_action || undefined,
          })
        } else if (msg.type === 'result') {
          sawResult = true
          result = msg.result || ''
          if (msg.usage || msg.total_cost_usd !== undefined) {
            onOutput({
              kind: 'usage',
              backend: 'claude',
              cost: msg.total_cost_usd,
              tokens: msg.usage && {
                input: msg.usage.input_tokens,
                output: msg.usage.output_tokens,
                cacheRead: msg.usage.cache_read_input_tokens,
                cacheWrite: msg.usage.cache_creation_input_tokens,
              },
            })
          }
          if (msg.is_error && isAuthError(result)) {
            fallback = true
            proc.kill('SIGTERM')
          }
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}

interface ClaudeMcpServer {
  type: string
  url: string
  headers?: Record<string, string>
}

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
}

// Reuses .claude/.mcp.json as the single source of truth for which MCP servers the
// agent gets, instead of a second hardcoded list that could drift out of sync.
// Claude Code reads this file directly via --mcp-config; opencode and kilocode (a
// fork of opencode, same config schema) have no equivalent flag, so its shape
// (mcpServers, type: "http") is translated into their config shape (mcp, type:
// "remote") and merged into OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT.
async function loadMcpConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(SILLAGE_ROOT, '.claude', '.mcp.json'), 'utf8')
  const { mcpServers } = JSON.parse(raw) as { mcpServers: Record<string, ClaudeMcpServer> }
  const mcp: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(mcpServers)) {
    mcp[name] = {
      type: 'remote',
      url: server.url,
      ...(server.headers && {
        headers: Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, substituteEnvVars(v)])),
      }),
    }
  }
  return mcp
}

// Equivalent of buildSettingsJson()/guard-scope.js for opencode/kilocode: their shared
// permission system has a dedicated "external_directory" rule, injected via
// OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT (merges over, doesn't replace, the
// project's own opencode.json) so the agent can't touch anything outside its cwd
// even with permissions auto-approved.
//
// A blanket `{'*': 'deny'}` isn't enough: their read/write/edit tools don't reliably
// recognize an absolute path pointing inside their own --dir as "internal" —
// confirmed live, e.g. `[read] /home/.../songe/AGENTS.md` was denied even though
// AGENTS.md is the project's own file. That forced the agent to fight the tool's
// own permission checks instead of doing the task. Explicitly allowing the project
// dir itself (the documented pattern for scoping external_directory) fixes this.
// opencode/kilocode's own agent presets (`kilocode agent list`) allow editing
// a handful of well-known scratch-plan paths just like any other file under
// their broad default `edit: * -> allow` rule — there's no dedicated "planning
// mode" toggle to turn off. The agent writing one of these instead of just
// working the ticket (confirmed live: a run re-derived the whole design from
// scratch into .kilo/plans/*.md, ignoring the actual task) is a model habit,
// not a CLI feature — denying the exact paths its own agent list documents is
// the reliable way to stop it, same as the external_directory rule above.
const PLAN_FILE_DENY_PATTERNS = ['.kilo/plans/*.md', 'plans/*.md', '.plans/*.md', '.opencode/plans/*.md']

// opencode/kilocode's built-in "task" tool delegates work to an internal
// sub-agent (its own `explore`/`general` presets) — but the sub-agent's tool
// calls never appear on the parent's --format json stdout, only the final
// result once it's fully done. Confirmed live: a refine turn against a real
// project invoked "task" and then produced zero stdout events for 140+
// seconds straight while the sub-agent was presumably still working. Our own
// stall watchdog (STALL_TIMEOUT_MS below) has no way to tell that apart from
// a genuine hang, and kills the process — the exact "went silent mid-run"
// fallback this was meant to catch, misfiring on real (invisible) progress.
// Denying "task" forces exploration through read/grep/bash instead, which do
// stream a tool_use event each, keeping the watchdog's liveness check valid.
async function buildRunnerConfigContent(projectDir: string): Promise<string> {
  return JSON.stringify({
    permission: {
      external_directory: {
        [`${projectDir}/*`]: 'allow',
        [projectDir]: 'allow',
        '*': 'deny',
      },
      edit: Object.fromEntries(PLAN_FILE_DENY_PATTERNS.map((pattern) => [pattern, 'deny'])),
      task: { '*': 'deny' },
    },
    mcp: await loadMcpConfig(),
  })
}

export async function spawnOpencode(prompt: string, projectDir: string, sessionId?: string, readOnly?: boolean): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const bin = process.env.OPENCODE_BIN || 'opencode'
  const model = process.env.OPENCODE_MODEL || 'opencode/big-pickle'
  // --dir is required, not just spawn()'s cwd option: opencode resolves its working
  // directory from the (possibly stale, inherited-from-this-server-process) PWD env
  // var in some code paths, which silently misdirects file writes to wherever this
  // orchestrator itself happens to be running from instead of the target project.
  // Confirmed via a live reproduction — --dir plus a corrected PWD closes it.
  const args = ['-m', model, 'run', prompt, '--format', 'json', '--auto', '--dir', projectDir]
  if (sessionId) args.push('-s', sessionId)
  // Refine turns use opencode's own built-in read-only agent preset (`opencode agent
  // list` shows its ruleset denies "edit" outright) instead of a hand-rolled
  // permission scheme — an explicit deny rule, which survives --auto.
  if (readOnly) args.push('--agent', 'plan')
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PWD: projectDir,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
      OPENCODE_CONFIG_CONTENT: await buildRunnerConfigContent(projectDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export async function spawnKilocode(prompt: string, projectDir: string, sessionId?: string, readOnly?: boolean): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const bin = process.env.KILOCODE_BIN || 'kilocode'
  const model = process.env.KILOCODE_MODEL || 'kilo/kilo-auto/free'
  // --dangerously-skip-permissions, not --auto: kilocode has both, worded differently
  // ("auto-approve permissions not explicitly denied" vs "auto-approve ALL permissions").
  // The former is the one that matches opencode's --auto and is documented to still
  // respect explicit deny rules — verified live against external_directory before relying on it.
  const args = ['-m', model, 'run', prompt, '--format', 'json', '--dangerously-skip-permissions', '--dir', projectDir]
  if (sessionId) args.push('-s', sessionId)
  // Same built-in read-only agent preset as opencode (kilocode is a fork, same
  // schema) — its "plan" agent is stricter still, also denying git commit/push/
  // checkout -b via bash pattern rules. See spawnOpencode for why this beats a
  // hand-rolled permission scheme.
  if (readOnly) args.push('--agent', 'plan')
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PWD: projectDir,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
      KILO_CONFIG_CONTENT: await buildRunnerConfigContent(projectDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (typeof obj.filePath === 'string') return obj.filePath
  const json = JSON.stringify(obj)
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

// opencode's --format json emits a "tool_use" event per tool call (bash, write, edit, ...)
// separately from "text" events, and doesn't narrate every call in prose the way Claude
// tends to — without this, real tasks that run several tool calls back-to-back look like
// long silent gaps in the stream even though work is happening.
//
// Unlike Claude, there's no separate "running" phase to surface here: confirmed live
// (captured raw stdout for both an instant `ls` and a 5s `sleep` tool call) that
// opencode/kilocode only ever emit a tool_use event once already resolved to
// completed/error — the state.status field technically allows pending/running per
// their SDK types, but --format json's batch output never actually streams it.
function toolCallEventFromOpencode(part: any): AgentEvent | null {
  const state = part?.state
  if (!state || (state.status !== 'completed' && state.status !== 'error')) return null
  const label = state.title || summarizeToolInput(state.input) || part.tool
  if (state.status === 'error') {
    return { kind: 'tool_call', id: part.id, tool: part.tool, label, status: 'error', input: state.input, error: state.error }
  }
  const output = typeof state.output === 'string' ? state.output : ''
  const trimmed = output.length > 4000 ? `${output.slice(0, 4000)}\n… (truncated)` : output
  return { kind: 'tool_call', id: part.id, tool: part.tool, label, status: 'complete', input: state.input, output: trimmed }
}

// Shared by runOpencode/runKilocode/runFree — kilocode is a fork of opencode and
// emits the exact same --format json event shape (verified live: same "text"/
// "tool_use" types, same part.state shape), so all three share one stream parser.
// onProperOutput fires once, the first time real text/tool output is seen — runFree
// uses it to decide whether OpenCode is actually alive or needs to be abandoned.
function attachOpencodeFamilyStream(
  proc: ChildProcessByStdio<null, Readable, Readable>,
  backend: 'opencode' | 'kilocode',
  onOutput: (event: AgentEvent) => void,
  onProperOutput: () => void,
  onSessionId?: (id: string) => void,
): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean }> {
  return new Promise((resolve, reject) => {
    let sawText = false
    let sawSessionId = false
    let settled = false
    let stderrText = ''
    // Set by either of two independent signals: a stdout `type:"error"` bus
    // event (confirmed to exist in opencode's own event loop, unconfirmed
    // whether the specific rate-limit failure routes through it) or a plain
    // string match against accumulated stderr (guaranteed available, both
    // are cheap and non-conflicting so both stay on). Lets index.ts surface
    // a specific "rate limited" reason instead of the generic needsFallback
    // "auth problem, or a crash" message that tells the user nothing.
    let rateLimited = false

    proc.on('error', (err) => reject(err))

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        // A clean exit (code 0) with zero real output is still a failure, not a
        // silent success — confirmed live that opencode can exit 0 without ever
        // emitting a single parseable line (a transient upstream hiccup on its
        // free-tier model), which previously slipped through as "done" with a
        // permanently empty message and no error surfaced anywhere.
        const needsFallback = !sawText
        if (/Rate limit exceeded/i.test(stderrText)) rateLimited = true
        if (needsFallback && stderrText) onOutput({ kind: 'orchestrator', text: `stderr: ${stderrText}` })
        if (rateLimited) {
          onOutput({
            kind: 'status',
            category: 'rate_limited',
            detail: `${backend === 'kilocode' ? 'Kilo Code' : 'OpenCode'} hit "Rate limit exceeded" — wait for the quota to reset or switch backend.`,
          })
        }
        resolve({ exitCode: code, needsFallback, rateLimited })
      }
    })

    proc.stderr.on('data', (chunk) => {
      stderrText += chunk.toString()
    })

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (!sawSessionId && msg.sessionID && onSessionId) {
          sawSessionId = true
          onSessionId(msg.sessionID)
        }
        if (msg.type === 'text' && msg.part?.text) {
          onOutput({ kind: 'text', text: msg.part.text })
          if (!sawText) onProperOutput()
          sawText = true
        } else if (msg.type === 'tool_use' && msg.part?.type === 'tool') {
          const event = toolCallEventFromOpencode(msg.part)
          if (event) {
            onOutput(event)
            if (!sawText) onProperOutput()
            sawText = true
          }
        } else if (msg.type === 'step_finish' && msg.part?.reason === 'tool-calls') {
          // Visual break between bursts of tool calls, mirroring Claude's turn
          // boundaries — makes a multi-step run scannable instead of one long stream.
          onOutput({ kind: 'separator' })
        } else if (msg.type === 'step_finish' && msg.part?.reason === 'stop' && (msg.part.cost !== undefined || msg.part.tokens)) {
          // The terminal step of a run — carries the same cost/token accounting
          // Claude's own final "result" message does, just never read before.
          onOutput({
            kind: 'usage',
            backend,
            cost: msg.part.cost,
            tokens: msg.part.tokens && {
              input: msg.part.tokens.input,
              output: msg.part.tokens.output,
              cacheRead: msg.part.tokens.cache?.read,
              cacheWrite: msg.part.tokens.cache?.write,
              reasoning: msg.part.tokens.reasoning,
            },
          })
        } else if (msg.type === 'error') {
          const message = msg.error?.data?.message || msg.error?.message || ''
          if (/Rate limit exceeded/i.test(message)) rateLimited = true
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}

async function runOpencodeFamily(
  spawnFn: (prompt: string, projectDir: string, sessionId?: string, readOnly?: boolean) => Promise<ChildProcessByStdio<null, Readable, Readable>>,
  backend: 'opencode' | 'kilocode',
  {
    prompt,
    projectDir,
    onOutput,
    sessionId,
    onProcess,
    readOnly,
  }: {
    prompt: string
    projectDir: string
    onOutput: (event: AgentEvent) => void
    sessionId?: string
    onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
    readOnly?: boolean
  },
): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean; sessionId?: string }> {
  const proc = await spawnFn(prompt, projectDir, sessionId, readOnly)
  onProcess?.(proc)
  let capturedId = sessionId
  const result = await attachOpencodeFamilyStream(proc, backend, onOutput, () => {}, (id) => {
    capturedId = id
  })
  return { ...result, sessionId: capturedId }
}

export function runOpencode(args: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  sessionId?: string
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
  readOnly?: boolean
}): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean; sessionId?: string }> {
  return runOpencodeFamily(spawnOpencode, 'opencode', args)
}

export function runKilocode(args: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  sessionId?: string
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
  readOnly?: boolean
}): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean; sessionId?: string }> {
  return runOpencodeFamily(spawnKilocode, 'kilocode', args)
}

const FREE_FALLBACK_TIMEOUT_MS = 60_000
// Once a backend has produced real output it's given a much longer leash than the
// pre-first-output check above — a legitimate tool call (cargo build/test, a big
// grep) can run for minutes with zero events, since opencode/kilocode only emit a
// tool_use event once it's already resolved (see toolCallEventFromOpencode). This
// mirrors index.ts's own STALL_THRESHOLD_MS, chosen there for the same "too long
// really means broken" judgment call on agent activity.
const STALL_TIMEOUT_MS = 5 * 60_000

// One spawn+stream attempt with a watchdog: kills the process and reports
// needsFallback if it never produces output within FREE_FALLBACK_TIMEOUT_MS, OR if
// it goes silent for STALL_TIMEOUT_MS at any later point. The latter is what
// catches an agent that responds for a couple of minutes and then just dies with
// no error — previously "trusted to run to completion" the moment it said
// anything, which left runFree's caller waiting forever with no recovery.
async function runFreeAttempt(
  spawnFn: (prompt: string, projectDir: string, sessionId?: string, readOnly?: boolean) => Promise<ChildProcessByStdio<null, Readable, Readable>>,
  backend: 'opencode' | 'kilocode',
  prompt: string,
  projectDir: string,
  sessionId: string | undefined,
  readOnly: boolean | undefined,
  onOutput: (event: AgentEvent) => void,
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void,
): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean; stalled: boolean; sessionId?: string }> {
  const proc = await spawnFn(prompt, projectDir, sessionId, readOnly)
  onProcess?.(proc)
  let lastEventAt = Date.now()
  let gotOutput = false
  let capturedId = sessionId
  let stalled = false

  const resultPromise = attachOpencodeFamilyStream(
    proc,
    backend,
    (event) => {
      lastEventAt = Date.now()
      onOutput(event)
    },
    () => {
      gotOutput = true
    },
    (id) => {
      capturedId = id
    },
  )

  const watchdog = setInterval(() => {
    const idleMs = Date.now() - lastEventAt
    if (idleMs > (gotOutput ? STALL_TIMEOUT_MS : FREE_FALLBACK_TIMEOUT_MS)) {
      stalled = true
      proc.kill('SIGTERM')
    }
  }, 5_000)

  const result = await resultPromise.finally(() => clearInterval(watchdog))
  return { ...result, needsFallback: result.needsFallback || stalled, stalled, sessionId: capturedId }
}

// "Free" tries Kilo Code's hosted free tier first; if it never produces output or
// goes silent partway through (see runFreeAttempt above), it's abandoned and
// OpenCode's free tier (a different provider, a different quota pool) is tried
// instead. Kilo was promoted ahead of OpenCode because OpenCode agents were
// observed dying silently mid-run with no error, well past first output.
export async function runFree({
  prompt,
  projectDir,
  onOutput,
  sessionId,
  backend,
  onProcess,
  readOnly,
}: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  // A refine chat that already knows which of opencode/kilocode answered its
  // first turn passes both back here to talk to that exact session directly —
  // skipping the race below entirely, since it's already proven alive.
  sessionId?: string
  backend?: 'opencode' | 'kilocode'
  // Fires once per spawn — including a second time if the kilocode->opencode
  // fallback below kicks in, so the caller's stored process reference always
  // tracks whichever process is actually alive.
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
  readOnly?: boolean
}): Promise<{ exitCode: number | null; needsFallback: boolean; rateLimited: boolean; backend: 'opencode' | 'kilocode'; sessionId?: string }> {
  if (backend === 'kilocode') {
    const result = await runKilocode({ prompt, projectDir, onOutput, sessionId, onProcess, readOnly })
    return { ...result, backend: 'kilocode' }
  }
  if (backend === 'opencode') {
    const result = await runOpencode({ prompt, projectDir, onOutput, sessionId, onProcess, readOnly })
    return { ...result, backend: 'opencode' }
  }

  const primary = await runFreeAttempt(spawnKilocode, 'kilocode', prompt, projectDir, sessionId, readOnly, onOutput, onProcess)
  if (!primary.needsFallback) {
    return { ...primary, backend: 'kilocode' }
  }

  // Structured (kind: 'status'), not an orchestrator note — a whole spawn was
  // just wasted, and this shape is what index.ts's classifyFriction matches
  // on (category: 'backend_fallback') to log it, the same way rate_limited
  // below already does.
  onOutput({
    kind: 'status',
    category: 'backend_fallback',
    detail: primary.stalled
      ? `Kilo Code went silent mid-run (no output for ${STALL_TIMEOUT_MS / 60_000} min) — falling back to OpenCode.`
      : `Kilo Code produced no output within ${FREE_FALLBACK_TIMEOUT_MS / 1000}s (likely the daily free-tier quota is exhausted) — falling back to OpenCode.`,
  })
  const fallback = await runFreeAttempt(spawnOpencode, 'opencode', prompt, projectDir, undefined, readOnly, onOutput, onProcess)
  return { ...fallback, backend: 'opencode' }
}

export async function runMockAgent({
  issueId,
  onOutput,
  onProcess,
}: {
  issueId: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
}): Promise<{ exitCode: number | null; needsFallback: boolean }> {
  const hookUrl = `http://127.0.0.1:${process.env.PORT || 4390}/hook-event`
  const script = join(__dirname, 'mock-agent.js')
  const proc = spawn(process.execPath, [script, issueId, hookUrl], {
    cwd: SILLAGE_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  onProcess?.(proc)
  return new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ exitCode: code, needsFallback: false }))
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'assistant') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'text' && part.text) {
              onOutput({ kind: 'text', text: part.text })
            }
          }
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}
