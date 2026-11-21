// The snapshot of the upstream playbooks: a refresh takes a commit of a checkout through git and replaces the
// snapshot whole, and keeps the mapping that belongs to it.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { checkoutPathOf, playbookNames, refreshUpstream, snapshotPathOf } from "../src/upstream.ts";
import { commitFiles, git } from "./mapping-support.ts";

/** An upstream checkout with two playbooks, a reference and a Benny skill, committed. */
async function checkout(): Promise<string> {
  const dir = await tempDir("upstream");
  git(dir, "init", "-q", "-b", "main");
  commitFiles(
    dir,
    {
      LICENSE: "MIT License\n",
      "skills/poteto-mode/SKILL.md": "# Mode\n",
      "skills/poteto-mode/worker.md": "Work for the operator.\n",
      "skills/poteto-mode/playbooks/bug-fix.md": "### Bug fix\n\nReproduce it.\n",
      "skills/poteto-mode/playbooks/shipping.md": "### Shipping\n\nLand it.\n",
      "skills/poteto-mode/references/triage.md": "Judge each claim.\n",
      "skills/poteto-mode/assets/logo.txt": "not kept\n",
      "automations/benny/skills/triage-issue-reports/SKILL.md": "# Triage\n",
      "README.md": "not part of the snapshot\n",
    },
    "start",
  );
  return dir;
}

test("a refresh copies the snapshot with its commit", async () => {
  const from = await checkout();
  const into = join(await tempDir("snapshot"), "upstream");
  const source = refreshUpstream(from, { upstream: into });

  expect(source.commit).toBe(git(from, "rev-parse", "HEAD"));
  expect(JSON.parse(readFileSync(join(into, "SOURCE.json"), "utf8"))).toEqual(source);
  expect(readFileSync(join(into, "LICENSE"), "utf8")).toBe("MIT License\n");
  expect(readFileSync(join(into, "poteto-mode", "references", "triage.md"), "utf8")).toBe("Judge each claim.\n");
  expect(existsSync(join(into, "benny", "skills", "triage-issue-reports", "SKILL.md"))).toBe(true);
  expect(existsSync(join(into, "poteto-mode", "assets"))).toBe(false);
  expect(existsSync(join(into, "README.md"))).toBe(false);
});

test("a playbook removed upstream leaves the snapshot with the next refresh", async () => {
  const from = await checkout();
  const into = join(await tempDir("snapshot"), "upstream");
  refreshUpstream(from, { upstream: into });
  commitFiles(from, { "skills/poteto-mode/playbooks/shipping.md": null }, "drop shipping");
  refreshUpstream(from, { upstream: into });
  expect(playbookNames(into)).toEqual(["bug-fix"]);
});

test("a refresh reads the commit it is asked for, not the working tree, and leaves the checkout alone", async () => {
  const from = await checkout();
  const first = git(from, "rev-parse", "HEAD");
  commitFiles(from, { "skills/poteto-mode/playbooks/bug-fix.md": "### Bug fix\n\nChanged.\n" }, "later");
  writeFileSync(join(from, "skills", "poteto-mode", "worker.md"), "edited, not committed\n");
  const into = join(await tempDir("snapshot"), "upstream");
  const source = refreshUpstream(from, { upstream: into, commit: first });

  expect(source.commit).toBe(first);
  expect(readFileSync(join(into, "poteto-mode", "playbooks", "bug-fix.md"), "utf8")).toBe("### Bug fix\n\nReproduce it.\n");
  expect(readFileSync(join(into, "poteto-mode", "worker.md"), "utf8")).toBe("Work for the operator.\n");
  expect(git(from, "status", "--short")).toBe("M skills/poteto-mode/worker.md");
});

test("a refresh keeps the mapping of the snapshot", async () => {
  const from = await checkout();
  const into = join(await tempDir("snapshot"), "upstream");
  refreshUpstream(from, { upstream: into });
  writeFileSync(join(into, "mapping.json"), '{"entries":[]}\n');
  refreshUpstream(from, { upstream: into });
  expect(readFileSync(join(into, "mapping.json"), "utf8")).toBe('{"entries":[]}\n');
});

test("a folder that is not an upstream checkout is refused before anything is replaced", async () => {
  const into = await tempDir("snapshot");
  mkdirSync(join(into, "upstream"));
  writeFileSync(join(into, "upstream", "kept.txt"), "x");
  const notGit = await tempDir("plain");
  expect(() => refreshUpstream(notGit, { upstream: join(into, "upstream") })).toThrow("not a git checkout");
  const empty = await tempDir("empty");
  git(empty, "init", "-q", "-b", "main");
  commitFiles(empty, { "README.md": "x\n" });
  expect(() => refreshUpstream(empty, { upstream: join(into, "upstream") })).toThrow("is not an upstream pstack checkout");
  expect(existsSync(join(into, "upstream", "kept.txt"))).toBe(true);
  rmSync(join(into, "upstream"), { recursive: true });
});

test("a snapshot path and the path it comes from in a checkout name each other", () => {
  expect(checkoutPathOf("poteto-mode/playbooks/bug-fix.md")).toBe("skills/poteto-mode/playbooks/bug-fix.md");
  expect(checkoutPathOf("benny/README.md")).toBe("automations/benny/README.md");
  expect(checkoutPathOf("LICENSE")).toBe("LICENSE");
  expect(snapshotPathOf("skills/poteto-mode/references/x.md")).toBe("poteto-mode/references/x.md");
  expect(snapshotPathOf("skills/poteto-mode/assets/logo.png")).toBeUndefined();
  expect(snapshotPathOf("README.md")).toBeUndefined();
});

test("the package carries the 22 upstream playbooks", () => {
  expect(playbookNames()).toHaveLength(22);
});
