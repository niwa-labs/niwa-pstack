// The roles: the author writes only in a box, and a verdict counts only from a seat that did not write the code.

import { expect, test } from "bun:test";

import { Roles } from "../src/roles.ts";
import { ROLES } from "./support.ts";

test("an author without a box is refused", () => {
  const parsed = Roles.safeParse({ ...ROLES, author: { harness: "author" } });
  expect(parsed.success).toBe(false);
  expect(Roles.safeParse({ ...ROLES, author: { harness: "author", box: false } }).error?.issues[0]?.message).toContain("box: true");
});

test("a verifier on the author's harness is refused", () => {
  const parsed = Roles.safeParse({ ...ROLES, verifier: { harness: "author" } });
  expect(parsed.error?.issues[0]?.message).toContain("did not write the code");
});

test("the roles of the tests are a definition", () => {
  expect(Roles.parse(ROLES).author.box).toBe(true);
});
