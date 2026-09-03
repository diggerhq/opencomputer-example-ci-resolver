import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
  type DataValue,
} from "@opencomputer/agent";

// The whitelist. One connection per repository the agent may write to. The
// compiler copies these literals into the deployment manifest; the edge checks
// every request against them before attaching GITHUB_TOKEN, which itself may
// be valid for many repositories. Keep the trailing slash: the prefix is a
// string match.
export const github = defineConnection({
  id: "github",
  origin: "https://api.github.com",
  methods: ["POST"],
  pathPrefix: "/repos/diggerhq/opencomputer-example-ci-resolver/",
  headers: {
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
    Accept: "application/vnd.github+json",
    "User-Agent": "opencomputer-example-ci-resolver",
  },
});

type Json = Record<string, unknown>;

async function post(repository: string, path: string, body: Json): Promise<{ status: number; json: Json; text: string }> {
  const response = await github.fetch(`/repos/${repository}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {}
  return { status: response.status, json, text: text.slice(0, 1000) };
}

// Creates a branch with the given files on top of a base commit and opens a
// pull request, using the Git Data API. Every call is a POST under the
// repository's path; nothing here holds a credential.
export const openPullRequest = defineTool({
  name: "open_pull_request",
  description:
    "Create branch `branch` from `baseSha` with `files` replaced by the given contents, then open a pull request into `base`. `baseTreeSha` is the tree of `baseSha` (git rev-parse HEAD^{tree}).",
  input: {
    type: "object",
    properties: {
      repository: { type: "string", description: "owner/name" },
      base: { type: "string", description: "base branch name" },
      baseSha: { type: "string" },
      baseTreeSha: { type: "string" },
      branch: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
    required: ["repository", "base", "baseSha", "baseTreeSha", "branch", "title", "body", "files"],
  },
  async run({ input }): Promise<DataValue> {
    const repository = String(input.repository);
    const files = input.files as Array<{ path: string; content: string }>;

    const tree: Json[] = [];
    for (const file of files) {
      const blob = await post(repository, "git/blobs", { content: file.content, encoding: "utf-8" });
      if (blob.status !== 201) return { step: "blob", status: blob.status, error: blob.text };
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.json.sha });
    }
    const newTree = await post(repository, "git/trees", { base_tree: input.baseTreeSha, tree });
    if (newTree.status !== 201) return { step: "tree", status: newTree.status, error: newTree.text };

    const commit = await post(repository, "git/commits", {
      message: String(input.title),
      tree: newTree.json.sha,
      parents: [input.baseSha],
    });
    if (commit.status !== 201) return { step: "commit", status: commit.status, error: commit.text };

    const ref = await post(repository, "git/refs", { ref: `refs/heads/${input.branch}`, sha: commit.json.sha });
    if (ref.status !== 201) return { step: "ref", status: ref.status, error: ref.text };

    const pull = await post(repository, "pulls", {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.base,
    });
    if (pull.status !== 201) return { step: "pull", status: pull.status, error: pull.text };
    return { status: 201, url: String(pull.json.html_url), number: Number(pull.json.number) };
  },
});

export const fileIssue = defineTool({
  name: "file_issue",
  description: "Create one issue in `repository` (owner/name).",
  input: {
    type: "object",
    properties: {
      repository: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["repository", "title", "body"],
  },
  async run({ input }): Promise<DataValue> {
    const issue = await post(String(input.repository), "issues", { title: input.title, body: input.body });
    return issue.status === 201
      ? { status: 201, url: String(issue.json.html_url) }
      : { status: issue.status, error: issue.text };
  },
});

// A general request tool, on purpose. It lets the model attempt any GitHub
// call, so the example can show that the boundary is the connection in the
// manifest, not the shape of the tools.
export const githubRequest = defineTool({
  name: "github_request",
  description: "Send an arbitrary request to the GitHub API through the connection. Returns the status and body.",
  input: {
    type: "object",
    properties: {
      method: { type: "string" },
      path: { type: "string", description: "Path starting with /repos/" },
      body: { type: "string", description: "JSON body, optional" },
    },
    required: ["method", "path"],
  },
  async run({ input }): Promise<DataValue> {
    const response = await github.fetch(String(input.path), {
      method: String(input.method).toUpperCase(),
      headers: { "Content-Type": "application/json" },
      body: typeof input.body === "string" ? input.body : undefined,
    });
    return { status: response.status, body: (await response.text()).slice(0, 1000) };
  },
});
