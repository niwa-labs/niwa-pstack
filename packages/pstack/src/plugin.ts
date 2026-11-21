/**
 * The pstack plugin: it offers the entry, the playbooks and the suite to the workflow module, and tells its scripts
 * the roles the owner gave it.
 */

import { action } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import { GATED, SUITE_BUILTIN, scriptOf } from "./catalog.ts";
import { pstackRoles } from "./records.ts";
import { Roles } from "./roles.ts";
import type { RolesInput } from "./roles.ts";

/** What the pstack plugin is given. */
export interface PstackOptions {
  /** The seats of the lead, the author, the reviewer, the verifier and the judge. */
  readonly roles: RolesInput;
}

/** The pstack plugin. It needs the workflow module, installed after it. */
export function pstackPlugin(options: PstackOptions): Plugin {
  const roles = Roles.parse(options.roles);
  return plugin("pstack", (api) => {
    for (const one of GATED) {
      api.offer(BUILTIN_WORKFLOW, { name: one.name, file: scriptOf(one.name), description: one.description, gated: true, ...(one.triggers === undefined ? {} : { triggers: one.triggers }) });
    }
    api.offer(BUILTIN_WORKFLOW, { name: SUITE_BUILTIN.name, file: scriptOf(SUITE_BUILTIN.name), description: SUITE_BUILTIN.description });
    api.action(action(pstackRoles, { recovery: "repeat", effect: "read", world: "niwa", run: () => roles }));
  });
}
