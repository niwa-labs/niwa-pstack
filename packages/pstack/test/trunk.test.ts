// What trunk's changes mean for a patch: the first kind that applies, in the order of what being wrong costs.

import { expect, test } from "bun:test";

import { stemsOf, trunkKind } from "../src/trunk.ts";

const facts = (over: Partial<Parameters<typeof trunkKind>[0]>) => ({ patch: [], trunk: [], conflicts: [], dependents: [], ...over });

test("each kind is found, the costliest first", () => {
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["a.ts"], conflicts: ["a.ts"] }))).toEqual({ kind: "conflict", files: ["a.ts"] });
  expect(trunkKind(facts({ patch: ["bun.lock", "a.ts"], trunk: ["bun.lock", "a.ts"] }))).toEqual({ kind: "lockfile", files: ["bun.lock"] });
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["a.ts", "b.ts"] }))).toEqual({ kind: "both-touched", files: ["a.ts"] });
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["pkg/package.json"] }))).toEqual({ kind: "dependency", files: ["pkg/package.json"] });
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["b.ts"], dependents: ["b.ts"] }))).toEqual({ kind: "dependency", files: ["b.ts"] });
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["b.ts"] }))).toEqual({ kind: "none", files: [] });
});

test("a lockfile only trunk changed is no lockfile case", () => {
  expect(trunkKind(facts({ patch: ["a.ts"], trunk: ["bun.lock"] })).kind).toBe("none");
});

test("the stems of a patch's files leave out names every module has", () => {
  expect(stemsOf(["src/billing/invoice.ts", "src/index.ts", "lib/io.ts", "src/invoice.test.ts"])).toEqual(["invoice", "invoice.test"]);
});
