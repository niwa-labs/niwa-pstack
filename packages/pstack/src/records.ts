/**
 * The action references of pstack: what its scripts call on its plugin.
 */

import { actionRef } from "@niwa-labs/core";
import { z } from "zod";

import { Roles } from "./roles.ts";

/** The roles the owner gave pstack, as its scripts read them. */
export const pstackRoles = actionRef("pstack.roles", {
  description: "The roles of pstack's scripts: the seat of the lead, the author (always boxed), the reviewer, the verifier and the judge.",
  input: z.strictObject({}),
  output: Roles,
});

/** A session's address, as evidence binds it when the session attests. */
export const SessionAddress = z.strictObject({ kind: z.literal("session"), harness: z.string().min(1), id: z.string().min(1) });

export const pstackAuthorStart = actionRef("pstack.author.start", {
  description:
    "Start a session of the author role in a box: it may write only in `place`, one of niwa's worktrees, and reach only the " +
    "forges pstack was given, to publish its branch. A place that is not a worktree of this host is refused before anything " +
    "starts. Answers the session's reference and the address its work is known by.",
  input: z.strictObject({ place: z.string().min(1) }),
  output: z.strictObject({ ref: z.string().min(1), address: SessionAddress }),
});
