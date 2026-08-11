---
name: react-frontend
description: Method and conventions for building React UI. Use for tasks involving components, UI behavior, styling, client-side state, forms, views, or user-facing polish.
---
# React Frontend Skill

Project-specific facts (stack, file layout, exact token/class names, breakpoints) live in the project's AGENTS.md — defer to it. This skill covers the durable judgment calls.

## Component structure
- One component per file, colocated by feature/domain, not by type.
- File default-exports the component.
- Split responsibilities: presentational components take props and render; container/page-level components own data fetching and state. Don't blur that line.
- Split a component when it accumulates more than one distinct concern or "heading's worth" of behavior — don't wait for it to become unreadable.

## Styling
- Use the project's existing design-token system for color/spacing; never hardcode raw values in components.
- Don't introduce a CSS framework or styling approach not already in use, unless the task explicitly calls for it.
- Follow the project's existing naming convention for classes/scoping consistently.
- Responsive behavior: components must reflow at the project's defined breakpoint(s); don't assume desktop-only.

## State management
- Local UI state stays local (`useState`/`useReducer`) inside the component that owns it.
- Shared/cross-cutting state lives at the level the project designates (root component, context, store) — don't duplicate it downward.
- Derive values with memoized selectors instead of storing redundant state.
- Don't introduce a new state-management library unless the task explicitly requires it.
- Async/event sources (sockets, subscriptions) are consumed through the project's existing hook/pattern for that, not ad hoc.

## User-facing behavior
- Loading states are visible (disabled control, spinner, hint) — never silently drop input.
- Errors are surfaced to the user (inline message or toast), never swallowed.
- Interactive controls are keyboard-accessible; icon-only controls get aria-labels.
- Enter-key behavior in multi-line inputs (textareas) should be handled deliberately, not left to default form submission.

## Testing
- Components should render in isolation from props alone — no required external side effects.
- Handlers are pure callbacks: assert what they were called with, not internal implementation details.
- Components that fetch should allow injecting a stub/mock rather than requiring the real network layer.
