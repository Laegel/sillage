# Pilot — Agent Workspace

You are working in this repository. The pilot orchestrator spawned you with a
task tied to a Linear issue, and your working directory (`cwd`) is already
set to the real local project this task belongs to. Follow the conventions
below, and this project's own conventions (its own CLAUDE.md, linters,
scripts) if it has any.

## Live pairing sessions

This section is for an interactive Claude Code session working directly with
the developer on Pilot's own codebase — not one of the orchestrator's
spawned Task/Refine/Driver runs tied to a Linear issue (those follow the
Branching/Commits/Pull requests sections below instead).

When the developer tasks you with a code change, commit and push it once
you've made and verified the change — don't wait for a separate "commit/push"
ask each time. Commit straight to whatever branch is checked out (typically
`main`); no feature branch or PR needed for this workflow. Skip committing if
the change is still being iterated on / unverified, or the developer says not
to.

## Scope
A `PreToolUse` hook confines Edit/Write/Bash to files inside this working
directory — you cannot reach outside it. If a task genuinely requires
touching something outside this repo, stop and explain why instead of trying.

## Routing
Classify every task as **frontend** or **backend** before writing code:
- **Frontend**: React/UI components, UI behavior, styling/CSS, client-side
  state, forms, views, user-facing polish.
- **Backend**: API routes/endpoints, server logic, database/queries,
  validation, error handling, middleware, background work.

Load the matching skill with the **skill tool** (`frontend` or `backend`) and
follow its content exactly. Skills differ in substance — do not treat them as
interchangeable.

## Branching
Create a feature branch per task:

```
feat/{LINEAR-ISSUE-ID}-{kebab-slug}
```

Example: `feat/LIN-123-add-tag-filter`

## Commits
- Commit message subject must be prefixed with the Linear issue id:
  `LIN-123: Add tag filter to the dashboard`
- Keep the subject under 72 characters. Add a body after a blank line when the
  change needs explanation.
- One logical change per commit.

## Pull requests
- The PR **description MUST reference the Linear issue id**, e.g.
  `Closes LIN-123 — <summary>`.
- Open the PR with `gh pr create` once work is done and pushed. If a PR already
  exists for the branch, update it instead of creating a duplicate.

## Notifications
- Do **NOT** notify anyone manually about the PR. A `PostToolUse` hook detects
  `gh pr create`, extracts the PR URL, and posts it to the orchestrator, which
  surfaces it in the UI and flips the Linear issue to "In Review".

## Linear issue lifecycle
- Re-read the Linear issue with the Linear MCP when you start, so you have the
  latest title/description.
- On completion, set the issue status to **"In Review"** and add a comment with
  the PR link.

## Tools
- Use the **GitHub MCP** for commit, push, and `gh pr create`.
- Use the **Linear MCP** to read issue context and update status/comments.
- Prefer small, reviewed changes over large ones.
