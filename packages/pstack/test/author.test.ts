// The author's box: a session of the author writes only in one of niwa's worktrees and reaches only pstack's forges.

import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { AuthorRefusal, authorLaunch } from "../src/author.ts";

const author = { harness: "author", box: true as const };

async function place(): Promise<{ worktrees: string; wt: string; outside: string }> {
  const root = realpathSync(await tempDir("author"));
  const worktrees = join(root, "worktrees");
  const wt = join(worktrees, "wt-1");
  mkdirSync(wt, { recursive: true });
  const outside = join(root, "repo");
  mkdirSync(outside);
  return { worktrees, wt, outside };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AuthorRefusal ? error.code : String(error);
  }
};

test("the author writes in its worktree and reaches only the forges", async () => {
  const { worktrees, wt } = await place();
  expect(authorLaunch(author, wt, worktrees, ["gitlab.example.com"])).toEqual({ place: wt, visible: [`write:${wt}/*`, "net:gitlab.example.com"] });
});

test("a place that is not one of niwa's worktrees is refused", async () => {
  const { worktrees, wt, outside } = await place();
  expect(code(() => authorLaunch(author, outside, worktrees, []))).toBe("not-a-worktree");
  expect(code(() => authorLaunch(author, worktrees, worktrees, []))).toBe("not-a-worktree");
  expect(code(() => authorLaunch(author, join(wt, "src"), worktrees, []))).toBe("no-place");
  mkdirSync(join(wt, "src"));
  expect(code(() => authorLaunch(author, join(wt, "src"), worktrees, []))).toBe("not-a-worktree");
  expect(code(() => authorLaunch(author, "", worktrees, []))).toBe("no-place");
});

test("a link into a worktree from outside is followed to where it leads", async () => {
  const { worktrees, outside } = await place();
  const link = join(worktrees, "wt-2");
  symlinkSync(outside, link, "dir");
  expect(code(() => authorLaunch(author, link, worktrees, []))).toBe("not-a-worktree");
});

test("an author role with no box is refused", async () => {
  const { worktrees, wt } = await place();
  expect(code(() => authorLaunch({ harness: "author" } as never, wt, worktrees, []))).toBe("no-box");
});
