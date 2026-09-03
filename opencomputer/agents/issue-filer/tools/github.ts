import {
  bearer,
  defineConnection,
  defineTool,
  useSecret,
  type DataValue,
} from "@opencomputer/agent";

export const REPOSITORY = "diggerhq/opencomputer-example-issue-filer";

// The connection is the agent's reach. The compiler copies these literals into
// the deployment manifest; the edge checks every request against them before
// attaching the secret. GITHUB_TOKEN itself may have far broader rights.
export const github = defineConnection({
  id: "github",
  origin: "https://api.github.com",
  methods: ["POST"],
  pathPrefix: "/repos/diggerhq/opencomputer-example-issue-filer/issues",
  headers: {
    Authorization: bearer(useSecret("GITHUB_TOKEN")),
    Accept: "application/vnd.github+json",
    "User-Agent": "opencomputer-example-issue-filer",
  },
});

async function outcome(response: Response): Promise<DataValue> {
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 2000) };
}

export const fileIssue = defineTool({
  name: "file_issue",
  description: `Create one issue in ${REPOSITORY}.`,
  input: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["title", "body"],
  },
  async run({ input }) {
    const response = await github.fetch(`/repos/${REPOSITORY}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: input.title, body: input.body }),
    });
    return outcome(response);
  },
});

// A general request tool, on purpose. It lets the model attempt any GitHub
// call so the example can show that the boundary is the connection in the
// manifest, not the shape of the tool.
export const githubRequest = defineTool({
  name: "github_request",
  description: "Send an arbitrary request to the GitHub API through the connection. Returns the status and body.",
  input: {
    type: "object",
    properties: {
      method: { type: "string" },
      path: { type: "string", description: "Path starting with /" },
      body: { type: "string", description: "JSON body, optional" },
    },
    required: ["method", "path"],
  },
  async run({ input }) {
    const response = await github.fetch(String(input.path), {
      method: String(input.method).toUpperCase(),
      headers: { "Content-Type": "application/json" },
      body: typeof input.body === "string" ? input.body : undefined,
    });
    return outcome(response);
  },
});
