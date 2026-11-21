/**
 * What the playbooks that change code share: the lead frames the work first, in a read-only session, and an owner
 * lane carries the change to a verified pull request. None of them merges: landing is shipping's, under the policy.
 */

import type { z as Z } from "zod";

import { zod } from "./inputs.ts";
import { deliver } from "./lane.ts";
import type { LaneOpts } from "./lane.ts";
import { api, seatOptions, stepTag } from "./script.ts";
import type { Repo, Roles, SessionAddress } from "./script.ts";
import { brief } from "./texts.ts";
import type { PlaybookText } from "./texts.ts";

/** Ask the lead, read-only in the local clone, to frame the work before anything is built. */
export async function frame<S extends Z.ZodType>(playbook: PlaybookText, opts: { task: string; repo: Repo; roles: Roles; schema: S; ask: string[] }): Promise<Z.output<S>> {
  return await api().ask({
    ...seatOptions(opts.roles.lead),
    mode: "ask",
    cwd: opts.repo.local,
    schema: opts.schema,
    label: "frame",
  }, brief(stepTag(playbook.name, "frame"), playbook, opts.task, ["Work read-only: do not change anything.", ...opts.ask]));
}

/** A change carried to a pull request, as the change playbooks answer it. */
export interface Changed {
  status: "verified" | "unverified";
  pr: number;
  head: string;
  worktree: string;
  author: SessionAddress;
  verdicts: Array<{ name: string; covered: boolean; why?: string }>;
  ci: "green" | "red" | "timed-out";
  summary: string;
}

/** The output schema of a change: what `Changed` is, for a script's `output`. */
export function changedSchema() {
  const z = zod();
  return z.strictObject({
    status: z.enum(["verified", "unverified"]),
    pr: z.number(),
    head: z.string(),
    worktree: z.string(),
    author: z.strictObject({ kind: z.literal("session"), harness: z.string(), id: z.string() }),
    verdicts: z.array(z.strictObject({ name: z.string(), covered: z.boolean(), why: z.string().optional() })),
    ci: z.enum(["green", "red", "timed-out"]),
    summary: z.string(),
  });
}

/** Carry one change through an owner lane to a verified pull request. */
export async function change(key: string, opts: LaneOpts & { task: string; title: string; extra?: string[]; draft?: boolean }): Promise<Changed> {
  const done = await deliver(key, opts);
  return {
    status: done.verified ? "verified" : "unverified",
    pr: done.pr.number,
    head: done.pr.head,
    worktree: done.built.wt.path,
    author: done.built.author,
    verdicts: done.verdicts.map((one) => ({ name: one.name, covered: one.covered, ...(one.why === undefined ? {} : { why: one.why }) })),
    ci: done.ci.outcome,
    summary: done.built.summary,
  };
}

/** The first line of a text, cut to a title. */
export const titleOf = (text: string): string => (text.split("\n")[0] ?? text).trim().slice(0, 120) || "Change";
