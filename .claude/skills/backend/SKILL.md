---
name: node-backend
description: Method and conventions for building Node.js backend services. Use for tasks involving API routes, server logic, databases/queries, validation, error handling, middleware, or background work.
---
# Node.js Backend Skill

Project-specific facts (framework/runtime, folder layout, exact helper names, concrete store implementations, response shapes) live in the project's AGENTS.md — defer to it. This skill covers the durable judgment calls.

## Route conventions
- Route handlers should be uniform: parse input, dispatch on method + path, respond through a single shared response helper — not ad hoc `res.end()` calls scattered around.
- Every response uses a consistent format. Success is 2xx; malformed input is 400; missing resources are 404; unexpected failures are 500 with a generic error body — never leak internals in the message.
- Body parsing goes through one shared helper. Never trust raw input: coerce types, validate shape, and reject oversized or malformed payloads before they reach business logic.
- Never let a handler throw synchronously and crash the process — wrap handler logic so errors funnel into the standard error response path.

## Data access
- All persistence goes through a store/repository abstraction. Handlers depend on the interface, never on a concrete client — this is what makes swapping a mock for a real backend possible later.
- Don't open a second client/connection inside a handler; reuse the injected one.
- Never expose secrets, API keys, or internal/database ids in responses; map internal records to an explicit public shape before serializing.
- Async iteration and `Promise.all` must preserve intended ordering — don't let concurrency reorder results the caller expects in sequence.

## Error handling
- Distinguish expected errors (not found, validation, conflict) from unexpected ones. Expected errors produce clean 4xx responses with a clear message; unexpected errors log detail server-side and return a generic 500 to the client.
- Fatal setup failures (missing config/env vars, failed connections) should fail fast at startup with a clear message, not fail mid-request later.
- Idempotency: operations that mutate external state (status updates, attaching links, creating resources) must be safe to re-run without duplicating side effects.

## Background / long-running work
- Long-running or spawned work (child processes, jobs, streams) must not block the event loop; stream incremental output where possible.
- Always release held resources (process handles, task slots, locks) in a `finally` block, and clean up on client disconnect or failure — not only on success.

## Testing
- Store/data-access implementations should be interchangeable: test against the public interface, not implementation details, so a real backend can replace a mock later.
- Route handlers should be testable in isolation: invoke the handler with a fake request/response pair and assert status code + body.
- Error paths are first-class: each handler needs coverage for its 4xx/5xx cases, not just the happy path.
