#!/usr/bin/env node
const nodePath = require("path");
const input = JSON.parse(require("fs").readFileSync(0, "utf-8"));
const { tool_name, tool_input } = input;

function deny(reason) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  }));
  process.exit(2);
}

// Set by spawnClaude (server/agent.ts) for every read-only session (Refine,
// the visual critic, the step verifier) — --disallowedTools already strips
// Edit/Write/NotebookEdit at the CLI layer, but that leaves write-intent Bash
// (git commit, rm, a shell redirect) completely unguarded, which is what the
// checks below close.
const readOnly = process.env.SILLAGE_READ_ONLY === "true";

// The agent is spawned with cwd already set to the mapped project's folder
// (see server/project-map.ts), so confinement is just "stay within cwd".
function isOutsideProject(filePath) {
  if (!filePath) return false;
  const resolved = nodePath.resolve(process.cwd(), filePath);
  const projectDir = process.cwd();
  return resolved !== projectDir && !resolved.startsWith(projectDir + nodePath.sep);
}

// `>`/`>>` aren't word characters, so a `\b>` check (the old version of this
// function) never matches anything — this looks for the redirect operator
// directly instead, and only flags it when the target is a real file: `2>&1`
// and `> /dev/null` are two of the most common shell idioms in existence and
// must not trip this. Quoted strings are blanked first: a `>` inside them is
// data, not an operator — LAE-181's refine turn was blocked POSTing a plan
// whose JSON said "Res<> panics". The placeholder keeps `> "file"` flagged.
// A bare `\x` is consumed first so the shell's '\'' apostrophe idiom doesn't
// throw quote pairing off. Runnable cases: guard-scope.check.js.
function hasFileRedirect(cmd) {
  const unquoted = cmd.replace(/\\.|'[^']*'|"(?:\\.|[^"\\])*"/g, "Q");
  return />{1,2}\s*(?!&|\/dev\/null\b)\S/.test(unquoted);
}

// Scratch writes under /tmp are fine even read-only: refine consolidation
// dry-runs each step's command, and those log or screenshot to /tmp (LAE-182).
// Removes `> /tmp/...` redirects and rm/cp/mv/tee calls whose every path is
// under /tmp, so the checks below only see what's left. A path climbing back
// out with `..` doesn't count.
const TMP_PATH = String.raw`\/tmp\/(?![^\s;&|]*\.\.)[^\s;&|]*`;
function withoutTmpWrites(cmd) {
  return cmd
    .replace(new RegExp(String.raw`>{1,2}\s*${TMP_PATH}`, "g"), "")
    .replace(new RegExp(String.raw`\b(rm|cp|mv|tee)(\s+-\S+)*(\s+${TMP_PATH})+(?=\s*($|[;&|]))`, "g"), "");
}

if (tool_name === "Edit" || tool_name === "Write") {
  if (readOnly) {
    deny(`Blocked: this session is read-only, no file writes allowed.`);
  }
  const filePath = tool_input.file_path || "";
  if (isOutsideProject(filePath)) {
    deny(`Blocked: "${filePath}" is outside the project directory (${process.cwd()}).`);
  }
}

// A heredoc body is data fed to a command, not shell — LAE-185's refine turn
// was blocked building an issue description whose JS snippet contained `=>`.
// The opening line (with any `> file` after it) is kept, so a heredoc written
// to a file is still caught.
function withoutHeredocBodies(cmd) {
  return cmd.replace(/(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3(?=\n|$)/g, "$1");
}

// Absolute paths count as "outside" only when they actually are — a design
// session was blocked removing its own draft file by absolute path.
function hasAbsolutePathOutsideProject(cmd) {
  const paths = cmd.match(/(?:^|\s)(\/[^\s;&|'"()]*)/g) || [];
  return paths.map((p) => p.trim()).some((p) => !/^\/dev\/null\b/.test(p) && isOutsideProject(p));
}

// ponytail: regex heuristics, not a real shell parser — a determined bypass via
// quoting is possible; upgrade path is containerized execution scoped to the
// project directory if stronger isolation is ever needed.
if (tool_name === "Bash") {
  const cmd = tool_input.command || "";
  const rest = withoutTmpWrites(withoutHeredocBodies(cmd));

  if (readOnly) {
    const mutates = /\b(git\s+(commit|push|checkout|reset|add)|gh\s+pr\s+(create|merge)|rm|mv|cp|tee|sudo|sed\s+-i|(npm|cargo)\s+publish)\b/.test(rest);
    if (mutates || hasFileRedirect(rest)) {
      deny(`Blocked: this session is read-only, no mutating commands allowed ("${cmd}").`);
    }
  }

  const writeIntent = /\b(mv|rm|cp|sed -i|tee)\b/.test(rest) || hasFileRedirect(rest);
  const escapesProject = /(^|\s)\.\.\//.test(rest) || /(^|\s)~\//.test(rest) || hasAbsolutePathOutsideProject(rest);
  if (writeIntent && escapesProject) {
    deny(`Blocked: command appears to write outside the project directory ("${cmd}").`);
  }
}

process.exit(0);
