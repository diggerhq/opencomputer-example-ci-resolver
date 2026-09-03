# CI resolver

An OpenComputer Serverless Agent that takes a failing CI job, reproduces the
failure, fixes the code, and opens a pull request.

Input: a failed GitHub Actions job. The job's last step posts the repository,
branch, commit, job name, run URL, and log tail to the agent's webhook.
Output: a pull request whose body quotes the failing assertion, the cause,
the change, and the test output before and after. The pull request's own
checks then run on the fix.

The example exists to show one property: the agent's write access to GitHub
is a whitelist of repositories written in code, compiled into the deployment,
and enforced outside the machine the agent runs in. The token behind it is
valid for more repositories than the agent can reach.

What the example shows:

- One `defineConnection` literal is the whitelist. The compiler copies it
  into the deployment manifest; the edge checks every outbound request
  against it before attaching the token. Adding a repository is adding a
  literal and deploying; the diff is the policy change.
- The same token, used directly, writes to a second repository. Through the
  agent, the same request is refused with 403 before the token is touched.
- The agent runs untrusted code (the repository's own test suite) in a VM
  that holds no credential. Reads are local git; writes are HTTP POSTs
  through the connection.
- The value of the secret is outside the digest. Removing it stops the
  running agent at its next write with 409. Changing what the agent may
  reach is a deployment.

## The whitelist

```ts
// Excerpt of opencomputer/agents/ci-resolver/tools/github.ts.
export const github = defineConnection({
  id: "github",
  origin: "https://api.github.com",
  methods: ["POST"],
  pathPrefix: "/repos/diggerhq/opencomputer-example-ci-resolver/",
  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")), /* Accept, User-Agent */ },
});
```

`useSecret` returns a reference, not a value; code never sees the token.
Every tool in the file calls `github.fetch(path, init)`. After a build, the
manifest at `.opencomputer/runtime/.opencomputer/reactive.json` contains:

```text
tools:      file_issue, github_request, glob, grep, open_pull_request, read, shell, write
connection: github  POST  https://api.github.com/repos/diggerhq/opencomputer-example-ci-resolver/
```

The secret is set once per environment and never enters the repository:

```text
$ npx opencomputer secrets set GITHUB_TOKEN --value-stdin < ~/.pat
Set GITHUB_TOKEN for project (development); allowed for https://api.github.com.
```

The secret's own scope is the origin. The repository restriction is the
connection's, and the connection is in the deployment.

## The agent

```ts
// Simplified excerpt of opencomputer/agents/ci-resolver/agent.ts.
export default function Agent() {
  const input = useInput();
  const failure = (input.payload ?? {}) as { repository?: string; ref?: string; job?: string; log?: string };

  useModel("anthropic/claude-sonnet-5");

  if (failure.log) {
    // A CI failure report: shell and filesystem to reproduce and fix, and
    // three tools that write to GitHub through the one connection.
    // Omitted here: the file also selects read, write, glob, grep.
    useTool("shell");
    useTool(openPullRequest);
    useTool(fileIssue);
    useTool(githubRequest);
    return resolvePrompt(failure, input.text);
  } else {
    // No report: conversation. The model request carries no tools.
    return conversationPrompt(input.text ?? "");
  }
}

// Omitted here: the prompt text. See agent.ts.
function conversationPrompt(text: string) { return `…`; }
function resolvePrompt(failure: Failure, text?: string) { return `…`; }
```

`open_pull_request` creates blobs, a tree, a commit, a ref, and the pull
request: five POSTs under the repository path. `file_issue` is the fallback
when the tests cannot be made to pass. `github_request(method, path)` exists
so that out-of-bounds attempts in the runs below are deterministic; it shows
that the boundary is the connection, not the shape of the tools.

## 1. A failed job becomes a pull request

The trigger is the job itself. `.github/workflows/fixture.yml` runs the
fixture's tests on `fixture-ci` and, when a push fails, posts the log to the
agent:

```yaml
- name: Report the failure to the resolver
  if: failure() && github.event_name == 'push'
  run: |
    node -e '…' > "$RUNNER_TEMP/report.json"   # { text, payload: { repository, ref, sha, job, run, log } }
    curl -fsS -X POST "$OC_WEBHOOK_URL" -H "Authorization: Bearer $OC_WEBHOOK_TOKEN" \
      -H "Content-Type: application/json" -H "Idempotency-Key: ${{ github.run_id }}" \
      --data-binary @"$RUNNER_TEMP/report.json"
```

Pull requests are not reported, so the agent's own pull requests never
re-trigger it. `Idempotency-Key: run_id` means a re-run of the job returns the
original session instead of starting a second one.

A push to `fixture-ci` ([run 33779624131](https://github.com/diggerhq/opencomputer-example-ci-resolver/actions/runs/33779624131)):

```text
fixture / test   not ok 4 - invoiceTotal rounds tax half-up (8.20 at 7.5% is 8.82)   8.81 !== 8.82
Report the failure to the resolver
  {"request":{"id":"whr_238dfecd…","sessionId":"f0fd58ca-…","outcome":"accepted"}, …}

agent.rendered   source webhook  enabledTools [file_issue, github_request, glob, grep, open_pull_request, read, shell, write]
shell            git clone https://github.com/diggerhq/opencomputer-example-ci-resolver repo; git checkout 29532f90…
shell            npm test → not ok 4 …  8.81 !== 8.82
read             fixture/test/invoice.test.js, fixture/src/invoice.js
shell            node -e … → 0.6149999999999999  61.499999999999986  61
shell            npm test → # pass 4  # fail 0
shell            git rev-parse HEAD HEAD^{tree}
egress.response  POST …/git/blobs 201   …/git/trees 201   …/git/commits 201
egress.response  POST …/git/refs 422                        # branch name taken by an earlier run
egress.response  POST …/git/blobs 201   …/git/trees 201   …/git/commits 201   …/git/refs 201   …/pulls 201
open_pull_request {"status":201,"url":"https://github.com/diggerhq/opencomputer-example-ci-resolver/pull/9"}
```

One turn, 13 model steps, 145 seconds, including one retry with a unique
branch name after GitHub's 422. The result is
[pull request #9](https://github.com/diggerhq/opencomputer-example-ci-resolver/pull/9),
whose own `fixture` check passes on the fix. The change:

```diff
 export function round2(value) {
-  return Math.round(value * 100) / 100;
+  return Math.round((value + Number.EPSILON) * 100) / 100;
 }
```

Every read was local git in the VM. Every write was a POST through the
connection, and the event log records each one with the connection id,
method, path, and status, GitHub's 422 included.

The runs below use the same payload shape posted by hand, from
`fixture/*.json`, because they add requests the job would not make.

## 2. The same token, a second repository

The PAT behind `GITHUB_TOKEN` covers two repositories. From a laptop:

```text
$ curl -X POST https://api.github.com/repos/diggerhq/opencomputer-example-bug-repro/issues \
    -H "Authorization: Bearer $PAT" -d '{"title":"token reach check","body":"…"}'
HTTP 201
```

The second fixture adds two requests to the report: file the same report as
an issue in `diggerhq/opencomputer-example-bug-repro`, and delete the `ci`
label from this repository.

```text
$ curl … -H 'Idempotency-Key: ci-failure-and-more-1' --data-binary @fixture/ci-failure-and-more.json

file_issue        {"status":403,"error":"{\"error\":{\"code\":\"egress_path_blocked\",\"message\":\"The connection does not allow this path\"}}"}
github_request    {"status":403,"body":"{\"error\":{\"code\":\"egress_method_blocked\",\"message\":\"The connection does not allow this method\"}}"}
open_pull_request {"status":201,"url":"…/pull/8"}
```

The agent's reply, trimmed:

```text
Pull request opened: https://github.com/diggerhq/opencomputer-example-ci-resolver/pull/8

Failed requests:
1. Filing the issue in diggerhq/opencomputer-example-bug-repro:
   Status: 403  {"error":{"code":"egress_path_blocked","message":"The connection does not allow this path"}}
   This repository's issue-filing path is blocked for me — I cannot reach it.
2. Deleting the ci label from diggerhq/opencomputer-example-ci-resolver:
   Status: 403  {"error":{"code":"egress_method_blocked","message":"The connection does not allow this method"}}
   DELETE requests are blocked on this connection.
```

The token would have allowed both. The edge refused both against the pinned
deployment's connection before resolving the secret. The agent, the model,
and the request text had no say.

## 3. The value is outside the digest

```text
$ npx opencomputer secrets remove GITHUB_TOKEN
$ curl … --data-binary @fixture/ci-failure.json

open_pull_request {"step":"blob","status":409,"error":"{\"error\":{\"code\":\"secret_unavailable\",\"message\":\"Secret GITHUB_TOKEN is missing or is not allowed for this connection\"}}"}
```

Same deployment, same digest. The agent reproduced and fixed the failure as
before; its first write, the blob for the changed file, stopped at the edge
with 409. Setting the secret again restores the path without a deploy.

Two rules follow. To cut access now, remove the secret: the next write from
any session fails. To change what the agent may reach, change the literal
and deploy: sessions already running keep the deployment they started with.

## 4. Widening is a code review

```diff
 export const github = defineConnection({ … pathPrefix: "/repos/diggerhq/opencomputer-example-ci-resolver/" … });
+export const githubBugRepro = defineConnection({
+  id: "github-bug-repro",
+  origin: "https://api.github.com",
+  methods: ["POST"],
+  pathPrefix: "/repos/diggerhq/opencomputer-example-bug-repro/",
+  headers: { Authorization: bearer(useSecret("GITHUB_TOKEN")), … },
+});
```

A second repository is a second connection. The next deployment has a new
digest and the manifest lists two connections; the pull request that adds
it is the place the change gets reviewed.

## Run

Requires Node 22, an OpenComputer account, and a fine-grained GitHub token
with Contents, Pull requests, and Issues write on a repository you own.

```bash
git clone https://github.com/diggerhq/opencomputer-example-ci-resolver.git
cd opencomputer-example-ci-resolver
npm install
npx opencomputer login
```

Point the whitelist at your fork: the `pathPrefix` literal in
`opencomputer/agents/ci-resolver/tools/github.ts` and the `repository`
field in `fixture/*.json`. Then:

```bash
npx opencomputer deploy --watch --create-project ci-resolver
npx opencomputer secrets set GITHUB_TOKEN --value-stdin < ~/.pat
npx opencomputer webhooks create ci --agent ci-resolver --environment development
gh secret set OC_WEBHOOK_URL      # the URL the previous command printed
gh secret set OC_WEBHOOK_TOKEN    # the token it printed once
```

Push anything to `fixture-ci`. The `fixture` job fails on the branch's
failing test, reports itself, and the pull request arrives against
`fixture-ci`, so `main` stays green. Merging the pull request turns the branch
green; revert the merge to reset the demo. Both workflows report failed
pushes, so a broken `main` is handled the same way.

## Inspect a session

```bash
npx opencomputer sessions tail <session-id> --after 0 --no-follow --json
```

`egress.request` and `egress.response` record every request the edge let
through, with connection id, method, path, status, and duration. Requests
the edge refused appear only in the tool's result, not as egress events; see
`DX-NOTES.md` 002. `agent.rendered` records the tool list per model step.

## Files

```text
opencomputer/project.ts                        lists the project's agents
opencomputer/agents/ci-resolver/agent.ts       the function and its two prompts
opencomputer/agents/ci-resolver/tools/github.ts the whitelist and the three tools
opencomputer/agents/ci-resolver/opencode.json  harness tools this agent may select
opencomputer/.env.example                      the secret names the code references
fixture/src, fixture/test                      the billing module with its failing test
.github/workflows/fixture.yml                  runs the fixture tests on fixture-ci; reports a failed push
.github/workflows/ci.yml                       typecheck and doctor on main; same report step
fixture/ci-failure.json                        the payload shape, for posting a report by hand
fixture/ci-failure-and-more.json               the same with two out-of-bounds requests (run 2)
DX-NOTES.md                                    observations from building this against the live platform
```

## Limits

- `pathPrefix` is a string prefix. Keep the trailing slash, or
  `/repos/o/r` also matches `/repos/o/r-other/`. Under the prefix, `POST` still
  reaches endpoints such as `hooks` and `keys`; whether they succeed depends
  on the token's permissions, which remain the second gate. Finer than a
  repository means one connection per endpoint family.
- The repository is public, so reads are `git clone` without credentials. A
  private repository is read through the connection: `GET
  …/tarball/<sha>` with a declared redirect to `codeload.github.com`.
- The request text is data. Asking the agent in the request to stop early
  did not change its behaviour; a dry-run mode belongs in the payload and the
  render. See `DX-NOTES.md` 003.
- The repository's scripts run inside the session VM. Treat the target
  repository as untrusted code. The VM holds no credentials.

Docs: [How it works](https://docs.opencomputer.dev/agents/mental-model) ·
[Secrets](https://docs.opencomputer.dev/agents/secrets) ·
[Tools](https://docs.opencomputer.dev/agents/tools) ·
[Webhooks](https://docs.opencomputer.dev/agents/webhooks) ·
[Sessions](https://docs.opencomputer.dev/agents/sessions)

MIT.
