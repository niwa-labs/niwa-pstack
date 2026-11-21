/**
 * The pstack plugin: it offers the entry, the playbooks and the suite to the workflow module, tells its scripts the
 * roles the owner gave it, and starts the author's sessions in their box.
 */

import { action } from "@niwa-labs/core";
import { BUILTIN_WORKFLOW, plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";
import { sessionStart } from "@niwa-labs/sessions/records";

import { authorLaunch, worktreesOf } from "./author.ts";
import { GATED, SUITE_BUILTIN, scriptOf } from "./catalog.ts";
import { pstackAuthorStart, pstackRoles } from "./records.ts";
import { Roles } from "./roles.ts";
import type { RolesInput } from "./roles.ts";

/** What the pstack plugin is given. */
export interface PstackOptions {
  /** The seats of the lead, the author, the reviewer, the verifier and the judge. */
  readonly roles: RolesInput;
  /** The hosts of the forges an author publishes its branch to: the only network its box reaches. */
  readonly forges?: readonly string[];
}

/** The pstack plugin. It needs the sessions and git modules before it and the workflow module after it. */
export function pstackPlugin(options: PstackOptions): Plugin {
  const roles = Roles.parse(options.roles);
  const forges = [...(options.forges ?? [])];
  return plugin("pstack", (api) => {
    for (const one of GATED) {
      api.offer(BUILTIN_WORKFLOW, { name: one.name, file: scriptOf(one.name), description: one.description, gated: true, ...(one.triggers === undefined ? {} : { triggers: one.triggers }) });
    }
    api.offer(BUILTIN_WORKFLOW, { name: SUITE_BUILTIN.name, file: scriptOf(SUITE_BUILTIN.name), description: SUITE_BUILTIN.description });
    api.action(action(pstackRoles, { recovery: "repeat", effect: "read", world: "niwa", run: () => roles }));
    api.action(
      action(pstackAuthorStart, {
        // A session was started, or may have been: it is not started again.
        recovery: "do-not-repeat",
        effect: "write",
        world: "local",
        async run(input, ctx) {
          const launch = authorLaunch(roles.author, input.place, worktreesOf(api.home()), forges);
          const started = await ctx.step(sessionStart, {
            harness: roles.author.harness,
            prompt: "",
            cwd: launch.place,
            visible: { actions: launch.visible },
            ...(roles.author.model === undefined ? {} : { model: roles.author.model }),
            ...(roles.author.effort === undefined ? {} : { effort: roles.author.effort }),
          });
          const at = started.ref.indexOf(" ");
          return { ref: started.ref, address: { kind: "session" as const, harness: started.ref.slice(0, at), id: started.ref.slice(at + 1) } };
        },
      }),
    );
  });
}
