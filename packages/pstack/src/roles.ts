/**
 * The roles of pstack's scripts: who leads, who writes the code, who reviews and verifies it, who judges.
 *
 * A role is a seat: the harness its sessions run on, with the options of their `agent()` calls. The author is the
 * one role that writes, and it writes only in a box: its sessions are started with the write rule of the worktree
 * they work in and nothing wider, so `box: true` is part of its definition and a definition without it is refused.
 * The other roles read and answer; a verifier also attests what it found, under its own name.
 */

import { z } from "zod";

/** The options a role gives the sessions of its seat. */
const SeatFields = {
  /** The harness installation the sessions run on. */
  harness: z.string().min(1),
  /** Whose model it is, so judges can be told apart from authors. Default: the harness. */
  vendor: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
};

/** A role that reads and answers. */
export const SeatRole = z.strictObject(SeatFields);
export type SeatRole = z.infer<typeof SeatRole>;

/** The author: it writes code, so its sessions are boxed to the worktree they work in. */
export const AuthorRole = z.strictObject({
  ...SeatFields,
  box: z.literal(true, { error: "the author writes code, so its sessions run in a box: give it box: true" }),
});
export type AuthorRole = z.infer<typeof AuthorRole>;

/** The roles of pstack. A verifier must not be the author's seat: a verdict counts only from one that did not write the code. */
export const Roles = z
  .strictObject({
    lead: SeatRole,
    author: AuthorRole,
    reviewer: SeatRole,
    verifier: SeatRole,
    /** The judge of an evaluation: another vendor than the candidates'. Default: the reviewer. */
    judge: SeatRole.optional(),
  })
  .superRefine((roles, ctx) => {
    if (roles.verifier.harness === roles.author.harness) {
      ctx.addIssue({ code: "custom", path: ["verifier", "harness"], message: "the verifier runs on another harness than the author: a verdict counts only from one that did not write the code" });
    }
  });
export type Roles = z.infer<typeof Roles>;
export type RolesInput = z.input<typeof Roles>;
