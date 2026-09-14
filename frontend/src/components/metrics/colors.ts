// Project hues come from styles.css's --project-color-N, in the dataviz skill's
// validated slot order, indexed by the project's fixed position (never its rank).
// ponytail: a 9th project reuses slot 0 — fold the tail into "Other" if that day comes.
export function projectColor(index: number): string {
  return `var(--project-color-${index % 8})`
}

// Non-project series (status, spend kind) take the first three slots, the only
// ones that stay distinguishable in every pairing.
export const SERIES_COLORS = ['var(--project-color-0)', 'var(--project-color-1)', 'var(--project-color-2)'] as const
