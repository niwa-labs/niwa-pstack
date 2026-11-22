import { changeResult } from "./change.ts";
import { publishArtifact } from "./feature-artifacts.ts";
import type { localArtifact } from "./feature-artifacts.ts";
import { headCi, openPr, verify } from "./lane.ts";
import type { LaneOpts } from "./lane.ts";
import { prBriefing } from "./pr-briefing.ts";

export async function deliverDecision(key: string, opts: LaneOpts & {
  task: string; receipts: string[]; verification: string[];
}, artifact: Awaited<ReturnType<typeof localArtifact>>) {
  const briefing = await prBriefing(key + "-write", {
    ...opts, branch: artifact.wt.branch, cwd: artifact.path, head: artifact.sha, writer: opts.roles.lead, evidence: opts.receipts,
  });
  const built = await publishArtifact(opts, artifact);
  const pr = await openPr(key + "-pr", { ...opts, built, title: briefing.title, description: briefing.body, draft: false });
  const verdicts = await verify(key + "-verify", { ...opts, extra: opts.verification, subject: pr.subject, sha: pr.head, cwd: built.wt.path, author: built.author });
  const ci = await headCi(key + "-ci", { ...opts, number: pr.number, subject: pr.subject, sha: pr.head });
  return changeResult({ built, pr, verdicts, ci, verified: verdicts.every(({ covered }) => covered) && ci.outcome === "green" });
}
