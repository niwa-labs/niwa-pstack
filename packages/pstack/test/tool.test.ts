// The map tool on a package folder: the same code measures the folder of this package and the copy of it in a
// worktree, and every path it reads or writes comes from the folder it is given.

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { differingTexts, openMap, recordMap, summaryOf, writeAssembled } from "../src/mapping/index.ts";
import { pathsIn, refreshUpstream } from "../src/upstream.ts";
import { commitFiles, git } from "./mapping-support.ts";
import { UPSTREAM_FILES_V1, packageRepo, upstreamCheckout } from "./package-layout.ts";

test("a package folder is measured, its texts assembled, and a changed upstream carried, with nothing read from this package", async () => {
  const up = await upstreamCheckout();
  const { root, packageDir } = await packageRepo(up.dir, up.commit);
  const ctx = { paths: pathsIn(packageDir), root, checkout: up.dir };

  // The map is sound; the two texts it puts into prompts are not written yet, and that is counted apart.
  const first = summaryOf(openMap(ctx).report);
  expect(first).toMatchObject({ problems: 0, textProblems: 2, coverage: 100, touched: 0, gone: 0 });
  expect(differingTexts(ctx).sort()).toEqual(["bug-fix", "worker"]);
  expect(writeAssembled(ctx)).toBe(2);
  expect(JSON.parse(readFileSync(join(packageDir, "src", "workflows", "texts", "worker.json"), "utf8"))).toMatchObject({ name: "worker", text: "Work for the operator.\n" });
  expect(summaryOf(openMap(ctx).report).textProblems).toBe(0);
  expect(differingTexts(ctx)).toEqual([]);

  // Upstream moves on: the snapshot is taken again, one block is touched, the text of it lags until it is assembled.
  commitFiles(up.dir, { "skills/poteto-mode/worker.md": "Work for the operator, always.\n" }, "reword");
  refreshUpstream(up.dir, { upstream: pathsIn(packageDir).upstream });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "take the snapshot");
  const touched = summaryOf(openMap(ctx).report);
  expect(touched).toMatchObject({ problems: 0, touched: 1, coverage: 100 });
  expect(recordMap(ctx, "unchanged")).toBe(2);
  expect(recordMap(ctx, ["worker:01"])).toBe(1);
  expect(summaryOf(openMap(ctx).report)).toMatchObject({ touched: 0, textProblems: 1 });
  expect(writeAssembled(ctx)).toBe(2);
  expect(existsSync(join(packageDir, "src", "workflows", "texts", "bug-fix.json"))).toBe(true);
  expect(UPSTREAM_FILES_V1["skills/poteto-mode/worker.md"]).toBe("Work for the operator.\n");
});

test("recording refuses a map that has problems", async () => {
  const up = await upstreamCheckout();
  const { root, packageDir } = await packageRepo(up.dir, up.commit);
  const paths = pathsIn(packageDir);
  commitFiles(root, { "packages/pstack/upstream/mapping.json": '{"entries":[{"id":"x","upstream":{"commit":"' + up.commit + '","file":"poteto-mode/none.md","range":[0,5]},"ours":[],"kind":"dropped","note":"n"}]}' }, "break the map");
  expect(() => recordMap({ paths, root, checkout: up.dir }, "unchanged")).toThrow("problems");
});
