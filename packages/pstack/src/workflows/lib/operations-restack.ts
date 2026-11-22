import { gitOut, gitRun } from "./git.ts";

/** Pin a prepared commit without replacing an earlier recovery ref, including on replay. */
export async function pinPreparedHead(key: string, wt: { id: string; path: string }, pr: number, head: string): Promise<string> {
  const ref = `refs/pstack/restack/${wt.id}/${pr}`;
  const created = await gitRun(key, wt.path, ["update-ref", ref, head, ""]);
  if (created.exit !== 0) {
    const pinned = await gitOut(`${key}-existing`, wt.path, ["rev-parse", "--verify", ref]);
    if (pinned !== head) throw new Error(`The saved restack ${ref} already points to ${pinned}.`);
  }
  return ref;
}
