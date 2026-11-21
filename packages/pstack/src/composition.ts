/**
 * pstack's composition: the plugins a host installs to run its playbooks, in the order it installs them.
 *
 * The playbooks are built on forge (pull requests, pipelines, merges), evidence (verdicts and the merge result of a
 * pair of commits), watch (agents that went silent or loop) and plan (the plan a go is given on); pstack itself comes
 * last. What pstack needs of the host besides is not its to install: the sessions and git modules before it, the
 * workflow module after it, and the binding by which a session attests under one address for its whole life.
 *
 * ```ts
 * const base = defaultComposition({ home, harnesses, kinds, agents });
 * export default [...base, ...pstack({ bind: addressingOf(base), forge: { servers }, roles }), workflow()];
 * ```
 */

import { evidence } from "@niwa-labs/evidence";
import { forge } from "@niwa-labs/forge";
import type { ForgeOptions } from "@niwa-labs/forge";
import { plan } from "@niwa-labs/plan";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";
import { watch } from "@niwa-labs/watch";
import type { WatchOptions } from "@niwa-labs/watch";

import { pstackPlugin } from "./plugin.ts";
import type { PstackOptions } from "./plugin.ts";

/** What pstack's composition is made with: pstack's own options, the forge's, and the host's binding. */
export interface PstackCompositionOptions extends Omit<PstackOptions, "forges"> {
  /** The binding evidence attests with: `addressingOf(plugins)` of the host's sessions and agents modules. */
  readonly bind: CallerBinding;
  /** The forges: their hosts are the only network an author's box reaches. */
  readonly forge: ForgeOptions;
  readonly watch?: WatchOptions;
}

/** What pstack needs of the host besides the plugins of its composition. */
export const PSTACK_NEEDS = {
  /** The binding by which a session attests under one address: the one evidence is given. */
  addressing: "the caller binding of the sessions and agents modules",
  /** The sessions module, before pstack: the author's boxed sessions are started through it. */
  sessions: "@niwa-labs/sessions",
  /** The git module, before pstack: the worktrees the lanes work in. */
  git: "@niwa-labs/git",
  /** The workflow module, after pstack: the entry, the playbooks and the suite are its built-ins. */
  workflow: "@niwa-labs/workflow",
  /** With `benny`: plugins of the owner's that offer his three ports, before pstack (`benny.ports`, or installed by the host). */
  bennyPorts: "plugins that offer the issue tracker, report channel and product control ports of Benny",
} as const;

/** pstack's plugins, to install after the sessions and git modules and before the workflow module. */
export function pstack(options: PstackCompositionOptions): Plugin[] {
  if (typeof options.bind !== "function") {
    throw new TypeError("pstack: it needs the caller binding of the host (addressingOf), so a verdict's author keeps one address");
  }
  const { bind, forge: forgeOptions, watch: watchOptions, ...own } = options;
  return [
    forge(forgeOptions),
    evidence({ bind }),
    watch(watchOptions ?? {}),
    plan(),
    // The plugins that provide Benny's ports come before pstack, which reads what they offer when it is installed.
    ...(own.benny?.ports ?? []),
    pstackPlugin({ ...own, forges: forgeOptions.servers.map((server) => server.host) }),
  ];
}
