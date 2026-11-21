// The binding evidence attests with: a session keeps one address across a relaunch under a new token, an agent's
// session attests as the agent, and the owner and runs attest as the evidence module binds them.

import { expect, test } from "bun:test";

import { principalOf } from "@niwa-labs/core";
import type { Caller } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { CallerBinding } from "@niwa-labs/plugin";

import { addressingOf } from "../src/binding.ts";

/** A sessions module whose tokens' marks name sessions: two marks of one session are one relaunched session. */
function sessions(marks: Record<string, string>) {
  return Object.assign(plugin("sessions", () => {}), {
    bind: (fallback?: CallerBinding): CallerBinding => (caller) => {
      const principal = caller.kind === "client" ? caller.principal : undefined;
      const session = principal?.kind === "session" ? marks[principal.id] : undefined;
      if (session === undefined) return fallback?.(caller);
      const [harness, id] = session.split(" ") as [string, string];
      return { kind: "session", harness, id };
    },
  });
}

/** An agents module whose agent `reviewer` works through the session `verifier n-9`. */
function agents() {
  return Object.assign(plugin("agents", () => {}), {
    bind: (fallback: CallerBinding): CallerBinding => (caller) => {
      const bound = fallback(caller);
      return bound?.kind === "session" && bound.harness === "verifier" && bound.id === "n-9" ? { kind: "agent", id: "reviewer" } : bound;
    },
  });
}

const client = (kind: "session" | "run" | "owner", id: string): Caller => ({ kind: "client", id: `c-${id}` as never, principal: principalOf(kind, id) });

test("a session relaunched under a new token keeps its address", () => {
  const bind = addressingOf([sessions({ "mark-1": "author n-1", "mark-2": "author n-1" })]);
  expect(bind(client("session", "mark-1"))).toEqual({ kind: "session", harness: "author", id: "n-1" });
  expect(bind(client("session", "mark-2"))).toEqual(bind(client("session", "mark-1")));
});

test("an agent's session attests as the agent; the owner and a run as evidence binds them", () => {
  const bind = addressingOf([sessions({ "mark-3": "verifier n-9" }), agents()]);
  expect(bind(client("session", "mark-3"))).toEqual({ kind: "agent", id: "reviewer" });
  expect(bind(client("owner", "owner"))).toEqual({ kind: "owner" });
  expect(bind(client("run", "run-1"))).toEqual({ kind: "client", id: "run:run-1" });
  expect(bind({ kind: "host" })).toBeUndefined();
});

test("a host with no sessions module is refused", () => {
  expect(() => addressingOf([agents()])).toThrow("no sessions module");
});
