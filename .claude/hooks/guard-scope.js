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

// The agent is spawned with cwd already set to the mapped project's folder
// (see server/project-map.ts), so confinement is just "stay within cwd".
function isOutsideProject(filePath) {
  if (!filePath) return false;
  const resolved = nodePath.resolve(process.cwd(), filePath);
  const projectDir = process.cwd();
  return resolved !== projectDir && !resolved.startsWith(projectDir + nodePath.sep);
}

if (tool_name === "Edit" || tool_name === "Write") {
  const filePath = tool_input.file_path || "";
  if (isOutsideProject(filePath)) {
    deny(`Blocked: "${filePath}" is outside the project directory (${process.cwd()}).`);
  }
}

// ponytail: regex heuristic, not a real shell parser — a determined bypass via
// quoting is possible; upgrade path is containerized execution scoped to the
// project directory if stronger isolation is ever needed.
if (tool_name === "Bash") {
  const cmd = tool_input.command || "";
  const writeIntent = /\b(>|>>|mv|rm|cp|sed -i|tee)\b/.test(cmd);
  const escapesProject = /(^|\s)\.\.\//.test(cmd) || /(^|\s)~\//.test(cmd) || /(^|\s)\/(?!dev\/null\b)\S/.test(cmd);
  if (writeIntent && escapesProject) {
    deny(`Blocked: command appears to write outside the project directory ("${cmd}").`);
  }
}

process.exit(0);
