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
export async function frame<S extends Z.ZodType>(playbook: PlaybookText, opts: { task: string; repo: Repo; roles: Roles; schema: S; ask: string[]; label?: string }): Promise<Z.output<S>> {
  const label = opts.label ?? "frame";
  return await api().ask({
    ...seatOptions(opts.roles.lead),
    mode: "ask",
    cwd: opts.repo.local,
    schema: opts.schema,
    label,
  }, brief(stepTag(playbook.name, label), playbook, opts.task, ["Work read-only: do not change anything.", ...opts.ask]));
}

/** Get separate architectural advice and a lead decision before crossing a boundary. */
export async function boundaryArchitecture(playbook: PlaybookText, opts: { task: string; repo: Repo; roles: Roles; evidence: string[] }) {
  const z = zod();
  const detail = z.string().trim().min(1).max(4000);
  const proposal = await api().ask({
    ...seatOptions(opts.roles.reviewer), mode: "ask", cwd: opts.repo.local, schema: z.strictObject({ shape: detail }), label: "architect",
  }, brief(stepTag(playbook.name, "architect"), playbook, opts.task, [
    "Act as the delegated architect. Read the affected subsystem and callers. Compare viable shapes, and propose exact types, ownership, file scope and verification. Preserve the framed objective.",
    ...opts.evidence,
  ]));
  return frame(playbook, { ...opts, label: "approve-shape", schema: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("proceed"), shape: detail }),
    z.strictObject({ kind: z.literal("blocked"), why: detail }),
  ]), ask: [
    "Own the design choice. Select a boundary shape consistent with the confirmed evidence and describe its exact scope and checks. Block when you cannot justify a change.",
    ...opts.evidence, JSON.stringify(proposal),
  ] });
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
export async function change(key: string, opts: LaneOpts & { task: string; title: string; extra?: string[]; verification?: string[]; liveActions?: readonly string[]; draft?: boolean }): Promise<Changed> {
  return changeResult(await deliver(key, opts));
}

export function changeResult(done: Awaited<ReturnType<typeof deliver>>): Changed {
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
