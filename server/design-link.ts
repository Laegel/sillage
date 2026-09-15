// Where a design session's mockup lives once it's linked to an issue. The
// frontend keeps each session's issue; the server only remembers links in
// memory, so a session started with an issue (or any session after a restart)
// used to write to design/_drafts/ while the preview read design/<issueId>/.

export type DesignLinkPlan = 'link' | 'move' | 'replace' | 'conflict'

// 'conflict' = the issue already has a mockup and the user hasn't confirmed replacing it.
export function planDesignLink(previousDir: string, newDir: string, exists: (p: string) => boolean, replace: boolean): DesignLinkPlan {
  if (previousDir === newDir || !exists(previousDir)) return 'link'
  if (!exists(newDir)) return 'move'
  return replace ? 'replace' : 'conflict'
}

export function designIssueFor(payloadIssueId: string | undefined, rememberedIssueId: string | undefined): string | undefined {
  return payloadIssueId || rememberedIssueId
}

// The first turn's prompt names the folder, but a link can move it later.
export function designTurnMessage(message: string, designDir: string): string {
  return `[Mockup folder: ${designDir} — the preview shows ${designDir}/index.html]\n\n${message}`
}
