// pstack's composition: the plugins it installs, in order, with the author's network held to the forges' hosts.

import { expect, test } from "bun:test";

import { secret } from "@niwa-labs/forge";

import { pstack } from "../src/composition.ts";
import { ROLES } from "./support.ts";

const forge = { servers: [{ host: "gitlab.example.com", url: "https://gitlab.example.com", token: secret("GITLAB_TOKEN") }], poll: false as const };

test("the composition installs forge, evidence, watch and plan before pstack", () => {
  const plugins = pstack({ bind: () => undefined, forge, roles: ROLES });
  expect(plugins.map((one) => String(one.name))).toEqual(["forge", "evidence", "watch", "plan", "pstack"]);
});

test("the composition refuses to be made without the host's binding", () => {
  expect(() => pstack({ forge, roles: ROLES } as never)).toThrow("caller binding");
});

test("an author role without a box refuses the composition", () => {
  expect(() => pstack({ bind: () => undefined, forge, roles: { ...ROLES, author: { harness: "author" } } as never })).toThrow("box");
});
