// A built-in is stored as the files its imports reach, and the host reaches them as the runtime does: an import of
// types alone is erased first, so a file only types are taken from is not stored, and the stored script does not
// pass its check. Every local file a script names, for its types too, must also be reached by a value import.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as ts from "typescript";

import { GATED, UNGATED, scriptOf } from "../src/catalog.ts";

const transpiler = new Bun.Transpiler({ loader: "tsx" });

const local = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  return [base, `${base}.ts`].find((one) => existsSync(one));
};

/** The files a script reaches: by value imports alone (what is stored), or by every import (what its check reads). */
function reached(entry: string, all: boolean): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (!next.endsWith(".ts")) continue;
    const text = readFileSync(next, "utf8");
    const specifiers = all ? ts.preProcessFile(text, true, true).importedFiles.map((one) => one.fileName) : transpiler.scanImports(text).map((one) => one.path);
    for (const specifier of specifiers) {
      const found = local(next, specifier);
      if (found !== undefined) pending.push(found);
    }
  }
  return seen;
}

test("every local file a built-in names is stored with it", () => {
  for (const { name } of [...GATED, ...UNGATED, ...["entry", "feature", "suite"].map((name) => ({ name: `${name}-with-research` }))]) {
    const stored = reached(scriptOf(name), false);
    const named = [...reached(scriptOf(name), true)].filter((file) => !stored.has(file));
    expect({ name, missing: named }).toEqual({ name, missing: [] });
  }
});
