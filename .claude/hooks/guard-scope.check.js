#!/usr/bin/env node
// Runnable check for guard-scope.js's Bash rules: `node .claude/hooks/guard-scope.check.js`.
const { spawnSync } = require("child_process");
const nodePath = require("path");

const cases = [
  // LAE-181: a `>` inside quoted JSON (plan prose "Res<> panics") was read as a redirect.
  { cmd: `curl -s -X POST http://127.0.0.1:4390/api/plans -H "Content-Type: application/json" -d '{"content":"prevent Res<> panics"}'`, blocked: false },
  // Same, with the shell's '\'' idiom for an apostrophe inside single quotes.
  { cmd: `curl -X POST http://127.0.0.1:4390/api/plans -d '{"content":"the plugin'\\''s build() -> GameState, Res<> deps"}'`, blocked: false },
  { cmd: "echo x > out.txt", blocked: true },
  { cmd: 'echo x > "out.txt"', blocked: true },
  { cmd: "cargo test 2>&1", blocked: false },
  { cmd: "ls > /dev/null", blocked: false },
  { cmd: "git commit -m wip", blocked: true },
  // Scratch writes under /tmp are allowed read-only (consolidation dry-runs log/screenshot there).
  { cmd: "cargo build -p pixel-diff > /tmp/out.log 2>&1", blocked: false },
  { cmd: "rm -f /tmp/shot.png; WAYLAND_DISPLAY= xvfb-run timeout 30 cargo run -- --screenshot /tmp/shot.png", blocked: false },
  { cmd: "echo x > /tmp/../home/laegel/evil", blocked: true },
  { cmd: "rm -rf /tmp/x src", blocked: true },
  { cmd: 'bash -c "rm -rf src"', blocked: true },
  { cmd: "echo x > /tmpfoo", blocked: true },
];

let failed = 0;
for (const { cmd, blocked } of cases) {
  const run = spawnSync("node", [nodePath.join(__dirname, "guard-scope.js")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
    env: { ...process.env, SILLAGE_READ_ONLY: "true" },
  });
  const wasBlocked = run.status === 2;
  if (wasBlocked !== blocked) {
    failed++;
    console.log(`FAIL expected ${blocked ? "blocked" : "allowed"}: ${cmd}`);
  }
}
console.log(failed ? `${failed} failing` : "all passing");
process.exit(failed ? 1 : 0);
