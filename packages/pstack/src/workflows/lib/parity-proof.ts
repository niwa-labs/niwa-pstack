import { stateOf } from "@niwa-labs/flow-code";
import type { Worktree } from "@niwa-labs/flow-code";

import { zod } from "./inputs.ts";
import { api, authorOptions } from "./script.ts";

export function evidenceSchema() {
  const z = zod();
  return z.strictObject({
    exit: z.number().nullable(), tail: z.string(), complete: z.boolean(),
    artifact: z.strictObject({ digest: z.string(), size: z.number(), type: z.string() }).nullable(),
  });
}

export async function capture(key: string, cwd: string, cmd: string[], timeout = 120_000): Promise<ReturnType<typeof evidenceSchema>["_output"]> {
  const result = await api().call("proc.run", { cmd, cwd, timeout }, { label: key });
  return { exit: result.exit, tail: result.tail, complete: result.exit !== null && !result.truncated && !result.outputCut, artifact: result.output ?? null };
}

export function replay(key: string, cwd: string, command: string) {
  return capture(key, cwd, ["sh", "-c", command]);
}

export function captureFreshFile(key: string, cwd: string, command: string, path: string) {
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("Capture path must be relative to the isolated worktree");
  }
  return capture(key, cwd, ["sh", "-ec",
    '[ ! -e "$2" ] && [ ! -L "$2" ]; sh -c "$1"; [ -s "$2" ] && [ -f "$2" ] && [ ! -L "$2" ]',
    "capture", command, path,
  ]);
}

export function artifactName(result: Awaited<ReturnType<typeof capture>>) {
  return result.artifact?.digest ?? "workflow command receipt";
}

export async function exactCheckout(wt: Worktree, key: string, sha?: string) {
  const state = await stateOf(wt, key);
  if (state.dirty || (sha !== undefined && state.sha !== sha)) {
    throw new Error(`Checkout ${wt.path} is dirty or moved from ${sha ?? "the expected clean state"}`);
  }
  return state.sha;
}

export async function localAuthor(key: string, wt: Worktree, helpers = false) {
  return await api().session({ ...await authorOptions(key, wt.path, helpers), box: { only: ["project", "toolchains"] }, visible: [], label: `${key}-session` });
}

export async function publishVerified(key: string, wt: Worktree, head: string) {
  await exactCheckout(wt, `${key}-before`, head);
  const author = await api().session({ ...await authorOptions(key, wt.path), label: `${key}-session` });
  try {
    const answer = await author.ask(
      `Publish the existing commit ${head} on ${wt.branch} in ${wt.path}. Push this branch only. Make no edits, commits, PRs or other forge changes.`,
      { label: key, schema: zod().strictObject({ published: zod().boolean() }) },
    );
    if (!answer.published) throw new Error(`Publication for ${wt.branch} did not complete`);
  } finally {
    await author.end();
  }
  await exactCheckout(wt, `${key}-after`, head);
}
