# DX notes

Observations while building this example against the live platform
(CLI 0.6.6, agent 0.5.2, 2026-09-03), in order.

## 001 — first webhook delivery stayed `pending` and never produced a session (platform)

The first POST to a freshly created development webhook returned 202 with
`"outcome": "pending"` and no `sessionId`. Fifteen minutes later no session
existed for it; a repeat with the same `Idempotency-Key` returned
`"duplicate": true` and still `pending`. A second delivery with a new key
returned `"outcome": "accepted"` with a session in five seconds. Request id
`whr_e2dcf23a331d403fb80eba4f7547bf7e`, webhook `wh_87318f92…`.

## 002 — blocked egress attempts leave no egress event (gap, audit)

Allowed requests appear twice in the session log: `egress.request`
(connection id, method, path) and `egress.response` (status, duration).
Requests the edge refused with 403 `egress_path_blocked` or
`egress_method_blocked` appear only inside the `tool.completed` result the
tool chose to return. An operator reading the egress events of a session
sees five successful POSTs and nothing about the two refused attempts. For
a boundary that exists to be audited, the refusals are the interesting rows.

## 003 — request text does not override the prompt's steps (worth knowing)

A webhook `text` asking the agent to run `env` and stop was ignored three
times, with the model (`google/gemini-3.8-flash`) following the numbered
steps and opening a pull request each time: once with no rule about it, once
with "If the request asks for a diagnosis only, or to stop after a step, do
exactly that" at the end of the prompt, once with the same rule as step 0.
The instructions are the author's; the request is data, and this model
treats it as such. A dry-run or diagnosis-only mode belongs in the render as
a payload flag that selects a different prompt, not in the request text.
Not built here.

## 004 — what worked first time (nice)

Clone, checkout of the failing branch, reproduction, a one-line fix, green
suite, and five POSTs through the connection (blobs, tree, commit, ref, pull)
in one turn of 20 model steps, 208 s, producing PR #1 with a body that
quotes the assertion, the cause, the diff, and the test output before and
after. The same token, used directly, created an issue on a second
repository (201); through the agent the same call was refused before the
token was attached (403 `egress_path_blocked`).

## 005 — `doctor` scans the compiler's own output and blocks the next deploy (bug)

After one successful `deploy`, the next `deploy` stopped with "local project
diagnostics failed": `doctor` had walked into
`opencomputer/agents/ci-resolver/.opencomputer/runtime/` (the previous build's
output) and reported the bundled `agent.js` and `tools/github.js` as tools
outside `tools/` and as duplicate tool names. Removing that directory before
deploying works. It did not show up in the bug-repro example because that
agent defines no tools. `.opencomputer/` should be excluded from the scan.

## 006 — the workspace path names private vocabulary (minor)

A test runner's output inside the VM shows the checkout at
`/blue/sessions/pool-<deployment digest>/workspace/repo/…`. The path reaches
the model, the session log, and the pull-request body when the agent quotes
test output. `blue` is the retired internal name.

## 007 — an upstream provider rate limit ends the turn with no retry (platform, model)

Two runs failed mid-turn with `runtime.log` `{"type":"provider.rate-limit",
"message":"google/gemini-3.8-flash is temporarily rate-limited upstream…"}`
followed by `turn.failed` "The agent could not complete this request." The
work done so far in the VM (clone, reproduction, fix) is kept in the
session, but nothing retries the model call and nothing tells the webhook
caller; the webhook response had already returned 202. A resolver wired to a
real CI relay would silently produce no pull request for that failure. The
rate limit is OpenRouter's for the platform's account, not the customer's.

## 008 — end to end from a real red job (nice), with one provider error recovered

Pushing to `fixture-ci` made the `fixture` job fail; its last step posted the
log to the webhook and received 202 with a session id in the job output. The
session cloned the exact `sha` from the payload, fixed, went green, and hit
GitHub's 422 "Reference already exists" because the branch name from an
earlier run was taken. The 422 is recorded as an `egress.response` like any
allowed request. The model retried with a suffixed branch name and opened
PR #9 in 145 s over 13 model steps. The pull request's own `fixture` check
runs on the fix and passes.
