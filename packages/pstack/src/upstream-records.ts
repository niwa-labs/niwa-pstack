/**
 * The action references of the upstream sync: what its script calls on the pstack plugin.
 */

import { actionRef } from "@niwa-labs/core";
import { z } from "zod";

/** The upstream sync's own steps, done by the plugin in a worktree: the tool and git run on the host, not in a box. */
const UpstreamPlace = {
  place: z.string().min(1).describe("One of niwa's worktrees: the only place the step reads our files from and writes to"),
  package: z.string().min(1).default("packages/pstack").describe("The folder of the package in the worktree, with no `..`"),
};
const UpstreamCheckout = { checkout: z.string().min(1).describe("The real path of a checkout of upstream's pstack folder: it is read through git, never written") };

/** The numbers the map tool prints for a measurement. */
export const UpstreamSummary = z.strictObject({
  problems: z.number(),
  textProblems: z.number(),
  coverage: z.number(),
  entries: z.number(),
  unchanged: z.number(),
  touched: z.number(),
  gone: z.number(),
  uncovered: z.number(),
  error: z.string().optional(),
});
export type UpstreamSummary = z.infer<typeof UpstreamSummary>;

export const pstackUpstreamRefresh = actionRef("pstack.upstream.refresh", {
  description:
    "Take a new snapshot of an upstream pstack checkout, at a commit of it (its HEAD by default), into the package folder of a worktree of niwa. " +
    "The checkout is read through git and never written; the snapshot is replaced whole and the map stays. Answers the commit taken.",
  input: z.strictObject({ ...UpstreamPlace, ...UpstreamCheckout, commit: z.string().min(1).optional() }),
  output: z.strictObject({ commit: z.string() }),
});

export const pstackUpstreamMeasure = actionRef("pstack.upstream.measure", {
  description:
    "Measure the upstream map of the package folder of a worktree: its coverage, what became of each entry, and what is wrong with the texts. " +
    "Writes the whole report as JSON to `.upstream-map-report.json` in the worktree and answers the numbers. A map that cannot be read answers one problem and the reason.",
  input: z.strictObject({ ...UpstreamPlace, ...UpstreamCheckout }),
  output: UpstreamSummary,
});

export const pstackUpstreamRecord = actionRef("pstack.upstream.record", {
  description:
    "Record the entries of the map that are unchanged at the current commits, then the named ones at the positions their ranges were carried to. " +
    "A map with problems, or an id that is not an entry, records nothing and says why. Answers how many entries changed.",
  input: z.strictObject({ ...UpstreamPlace, ...UpstreamCheckout, accept: z.array(z.string().min(1)).max(1000).default([]) }),
  output: z.strictObject({ recorded: z.number(), refused: z.string().optional() }),
});

export const pstackUpstreamAssemble = actionRef("pstack.upstream.assemble", {
  description: "Write the texts the scripts import into the package folder of a worktree, assembled from its map. Answers how many.",
  input: z.strictObject({ ...UpstreamPlace, ...UpstreamCheckout }),
  output: z.strictObject({ texts: z.number() }),
});

export const pstackUpstreamCommit = actionRef("pstack.upstream.commit", {
  description:
    "Commit what changed under the given paths of a worktree of niwa (paths relative to it, none leading out). Nothing staged means no commit. " +
    "Answers the head and whether a commit was made.",
  input: z.strictObject({ place: z.string().min(1), message: z.string().min(1).max(500), paths: z.array(z.string().min(1)).min(1).max(50) }),
  output: z.strictObject({ head: z.string(), committed: z.boolean() }),
});

export const pstackUpstreamState = actionRef("pstack.upstream.state", {
  description: "The head of a worktree of niwa, and the files under the given paths that changed from `base` to the head.",
  input: z.strictObject({ place: z.string().min(1), base: z.string().min(1).optional(), paths: z.array(z.string().min(1)).max(50).default([]) }),
  output: z.strictObject({ head: z.string(), changed: z.array(z.string()) }),
});
