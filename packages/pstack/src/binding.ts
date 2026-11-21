/**
 * Who an attestation is from. The merge policy refuses a verdict by the author of the patch, so the author must have
 * one address for the life of its session: the principal of a session's token changes when the session is launched
 * again under a new one, and an exclusion by principal would let the author's relaunched session count as someone
 * else. The sessions module knows which session a token's mark names, and the agents module which agent a session
 * works for; their bindings give that address, and evidence is given the result.
 */

import { principalBinding } from "@niwa-labs/evidence";
import type { CallerBinding, Plugin } from "@niwa-labs/plugin";

/** A plugin that hands out a binding of its callers, as the sessions and agents modules do. */
export type Binding = Plugin & { bind(fallback?: CallerBinding): CallerBinding };

function bindingPlugin(plugins: readonly Plugin[], name: string): Binding | undefined {
  const found = plugins.find((one) => String(one.name) === name);
  return found !== undefined && typeof (found as Partial<Binding>).bind === "function" ? (found as Binding) : undefined;
}

/**
 * The binding evidence attests with on a host of these plugins: a session the agents module started for an agent
 * attests as the agent, another session as itself (`session` with its harness and its own id), and every other caller
 * as the evidence module would bind it, the owner as the owner and a run as `run:<id>`. A host with no sessions module
 * is refused: its sessions could not be told apart across a relaunch.
 */
export function addressingOf(plugins: readonly Plugin[]): CallerBinding {
  const sessions = bindingPlugin(plugins, "sessions");
  if (sessions === undefined) throw new TypeError("pstack: the host has no sessions module to address the authors of verdicts by; install it before pstack");
  const agents = bindingPlugin(plugins, "agents");
  const bySession = sessions.bind(principalBinding);
  return agents === undefined ? bySession : agents.bind(bySession);
}
