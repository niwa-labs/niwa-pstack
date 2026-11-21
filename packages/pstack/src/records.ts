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
