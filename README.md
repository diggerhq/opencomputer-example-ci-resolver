# CI resolver

An OpenComputer Serverless Agent. When a CI run fails on a push, it checks
out the failing commit, reproduces the failure, fixes the code, and opens a
pull request against the branch.

Its write access to GitHub is limited to the repositories listed in its
code, whatever the token behind it is allowed to do. The token itself never
enters the machine the agent runs in; requests leave through a proxy that
adds it.

## How access is restricted

```ts
// opencomputer/agents/ci-resolver/tools/github.ts
export const github = defineConnection({
  id: "github",
  origin: "https://api.github.com",
  methods: ["POST"],
  pathPrefix: "/repos/diggerhq/opencomputer-example-ci-resolver/",
  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")) },
});
```

`npx opencomputer deploy` compiles the agent directory: it bundles `agent.ts`
and `tools/*.ts`, and reads every `defineConnection` out of the source, as
text, into a manifest that is registered with the deployment. The entry it produced for the
connection above, from `.opencomputer/runtime/.opencomputer/reactive.json`
after a build:

```json
{
  "id": "github",
  "origin": "https://api.github.com",
  "methods": ["POST"],
  "pathPrefix": "/repos/diggerhq/opencomputer-example-ci-resolver/",
  "headers": {
    "Authorization": { "kind": "secret", "name": "GITHUB_TOKEN", "prefix": "Bearer " },
    "Accept": "application/vnd.github+json",
    "User-Agent": "opencomputer-example-ci-resolver"
  }
}
```

Origin, methods, prefix, and header values must be literals; a computed
origin fails the build. So the manifest is a function of the source text, a
reviewer reads the policy in the diff, and nothing that runs later can
change it:

- A deployment is immutable. Every session is pinned to one deployment.
- `github.fetch` sends each request to OpenComputer's outbound proxy as
  connection id, method, path, headers, and body. The proxy checks the
  method and path prefix against the deployment's manifest, adds the
  `Authorization` header from the secret's value, forwards the request to
  `api.github.com`, and returns the response. Requests outside the prefix
  are refused before the secret is read.
- The manifest holds the secret's name, not its value. The value is set with
  `secrets set GITHUB_TOKEN --value-stdin` and stored on the platform; only
  the proxy reads it. The agent's machine sends requests without the header
  and never holds the token.
- Reads are local: `git clone`, `git checkout <sha>`, `npm test`. Writes are
  POSTs through the connection: blobs, tree, commit, ref, pull request.

The agent function attaches the harness's shell and filesystem plus three
GitHub tools when a report arrives, and nothing when it does not:

```ts
// opencomputer/agents/ci-resolver/agent.ts, simplified
if (failure.log) {
  useTool("shell");            // also read, write, glob, grep
  useTool(openPullRequest);    // five POSTs under the repository path
  useTool(fileIssue);          // fallback when the tests stay red
  useTool(githubRequest);      // any method and path; checked the same way
  return resolvePrompt(failure, input.text);
}
return conversationPrompt(input.text ?? "");
```

## What happens on a failed run

`ci.yml` is an ordinary workflow: install, typecheck, `doctor`, `npm test`.
`resolve.yml` runs when `ci` completes with `failure` on a push, fetches the
failed job's log with `gh run view --log-failed`, and posts it to the agent's
webhook with the run id as the idempotency key. Pull requests are not
reported, so the agent's own pull requests do not re-trigger it.

GitHub delivers its own webhooks HMAC-signed with GitHub's payload; the
agent's webhook takes a bearer token and `{ text, payload }`. The
`workflow_run` workflow translates one into the other.

Commit [`ebefd92`](https://github.com/diggerhq/opencomputer-example-ci-resolver/commit/ebefd9286e71297ab5a4adf3e855b935b3c28cfe)
on `refactor/simplify-round2` replaced compensated rounding with
`Math.round(value * 100) / 100`. The existing half-up test caught it
([run 33780847455](https://github.com/diggerhq/opencomputer-example-ci-resolver/actions/runs/33780847455)):

```text
resolve / report   {"request":{"sessionId":"56ea5b15-…","outcome":"accepted"}}

agent.rendered   enabledTools [file_issue, github_request, glob, grep, open_pull_request, read, shell, write]
shell            git clone …; git checkout ebefd928…
shell            npm test → not ok 4 - invoiceTotal rounds tax half-up (8.20 at 7.5% is 8.82)   8.81 !== 8.82
shell            node -e … → 0.6149999999999999  61.499999999999986  61
shell            npm test → # pass 4  # fail 0
egress.response  POST …/git/blobs 201   …/git/trees 201   …/git/commits 201   …/git/refs 201   …/pulls 201
open_pull_request {"status":201,"url":"https://github.com/diggerhq/opencomputer-example-ci-resolver/pull/10"}
```

11 model steps, 99 seconds.
[Pull request #10](https://github.com/diggerhq/opencomputer-example-ci-resolver/pull/10)
restores the compensation; its own `ci` check passes.

## Verify the restriction

The runs below post the report by hand from `reports/*.json`, with requests a
CI job would not make.

### A repository the token can access but the agent cannot

The token covers `opencomputer-example-bug-repro` as well. Directly:

```text
$ curl -X POST https://api.github.com/repos/diggerhq/opencomputer-example-bug-repro/issues \
    -H "Authorization: Bearer $PAT" -d '{"title":"…","body":"…"}'
HTTP 201
```

Through the agent, with `reports/ci-failure-and-more.json` asking it to file
the same report there and to delete a label here:

```text
file_issue      {"status":403,"error":"{\"error\":{\"code\":\"egress_path_blocked\",\"message\":\"The connection does not allow this path\"}}"}
github_request  {"status":403,"body":"{\"error\":{\"code\":\"egress_method_blocked\",\"message\":\"The connection does not allow this method\"}}"}
```

Both were refused against the deployment's manifest before the secret was
read. The pull request for the fix was still opened.

### Secret removed

```text
$ npx opencomputer secrets remove GITHUB_TOKEN
$ curl … --data-binary @reports/ci-failure.json

open_pull_request {"step":"blob","status":409,"error":"{\"error\":{\"code\":\"secret_unavailable\",\"message\":\"Secret GITHUB_TOKEN is missing or is not allowed for this connection\"}}"}
```

Same deployment. The agent reproduced and fixed the failure; the first
write stopped. Removing the secret cuts access for every session at its next
write, with no deploy.

### Adding a repository

```diff
+export const githubBugRepro = defineConnection({
+  id: "github-bug-repro",
+  origin: "https://api.github.com",
+  methods: ["POST"],
+  pathPrefix: "/repos/diggerhq/opencomputer-example-bug-repro/",
+  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")) },
+});
```

A second repository is a second connection and a new deployment. Sessions
already running keep the deployment they started with.

## Run it

Requires Node 22, an OpenComputer account, and a fine-grained GitHub token
with Contents, Pull requests, and Issues write on a repository you own.

```bash
git clone https://github.com/diggerhq/opencomputer-example-ci-resolver.git
cd opencomputer-example-ci-resolver && npm install
npx opencomputer login
```

Change `pathPrefix` in `opencomputer/agents/ci-resolver/tools/github.ts` and
`repository` in `reports/*.json` to your fork. Then:

```bash
npx opencomputer deploy --watch --create-project ci-resolver
npx opencomputer secrets set GITHUB_TOKEN --value-stdin < ~/.pat
npx opencomputer webhooks create ci --agent ci-resolver --environment development
gh secret set OC_WEBHOOK_URL      # printed by the previous command
gh secret set OC_WEBHOOK_TOKEN    # printed once
```

Push a branch with a change that fails `npm test`. The pull request arrives
against that branch.

## Inspect a session

```bash
npx opencomputer sessions tail <session-id> --after 0 --no-follow --json
```

`egress.request` and `egress.response` record every request the proxy
forwarded: connection, method, path, status, duration. Refused requests appear
only in the tool result, not as egress events (`DX-NOTES.md` 002).
`agent.rendered` records the tool list per model step.

## Files

```text
opencomputer/agents/ci-resolver/tools/github.ts   the connection and the three tools
opencomputer/agents/ci-resolver/agent.ts          the function and its two prompts
opencomputer/agents/ci-resolver/opencode.json     harness tools this agent may select
.github/workflows/ci.yml                          ordinary CI
.github/workflows/resolve.yml                     reports a failed push to the agent
billing/                                          the module under test and its suite
reports/                                          payloads for posting a report by hand
DX-NOTES.md                                       observations against the live platform
```

## Limits

- `pathPrefix` is a string prefix. Keep the trailing slash: `/repos/o/r`
  also matches `/repos/o/r-other/`. Under the prefix, `POST` still reaches
  `hooks`, `keys`, and similar; the token's permissions are the second gate.
- Reads are unauthenticated `git clone`, so the repository must be public. A
  private repository is read through the connection with `GET …/tarball/<sha>`
  and a declared redirect to `codeload.github.com`.
- The repository's scripts run inside the agent's session. Treat the target
  repository as untrusted code; the session holds no credentials.

Docs: [Secrets](https://docs.opencomputer.dev/agents/secrets) ·
[Tools](https://docs.opencomputer.dev/agents/tools) ·
[Webhooks](https://docs.opencomputer.dev/agents/webhooks) ·
[Sessions](https://docs.opencomputer.dev/agents/sessions)

MIT.
