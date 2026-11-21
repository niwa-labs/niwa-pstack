// The snapshot of the upstream playbooks: a refresh copies what the scripts and Benny need from a checkout and
// writes the texts the scripts import, and the texts in the package are the ones its snapshot gives.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { TEXTS_DIR, UPSTREAM_DIR, playbookNames, refreshUpstream, textsOf, titleOf } from "../src/upstream.ts";

function git(dir: string, ...args: string[]): string {
  const ran = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" },
  });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return ran.stdout.toString().trim();
}

/** An upstream checkout with two playbooks, a reference and a Benny skill, committed. */
async function checkout(): Promise<string> {
  const dir = await tempDir("upstream");
  const mode = join(dir, "skills", "poteto-mode");
  mkdirSync(join(mode, "playbooks"), { recursive: true });
  mkdirSync(join(mode, "references"), { recursive: true });
  mkdirSync(join(dir, "automations", "benny", "skills", "triage-issue-reports"), { recursive: true });
  writeFileSync(join(dir, "LICENSE"), "MIT License\n");
  writeFileSync(join(mode, "SKILL.md"), "# Mode\n");
  writeFileSync(join(mode, "worker.md"), "Work for the operator.\n");
  writeFileSync(join(mode, "playbooks", "bug-fix.md"), "### Bug fix\n\nReproduce it.\n");
  writeFileSync(join(mode, "playbooks", "shipping.md"), "### Shipping\n\nLand it.\n");
  writeFileSync(join(mode, "references", "triage.md"), "Judge each claim.\n");
  writeFileSync(join(dir, "automations", "benny", "skills", "triage-issue-reports", "SKILL.md"), "# Triage\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "start");
  return dir;
}

test("a refresh copies the snapshot with its commit and writes a text per playbook", async () => {
  const from = await checkout();
  const into = await tempDir("snapshot");
  const upstream = join(into, "upstream");
  const texts = join(into, "texts");
  const source = refreshUpstream(from, { upstream, texts });

  expect(source.commit).toBe(git(from, "rev-parse", "HEAD"));
  expect(JSON.parse(readFileSync(join(upstream, "SOURCE.json"), "utf8"))).toEqual(source);
  expect(readFileSync(join(upstream, "LICENSE"), "utf8")).toBe("MIT License\n");
  expect(readFileSync(join(upstream, "poteto-mode", "references", "triage.md"), "utf8")).toBe("Judge each claim.\n");
  expect(existsSync(join(upstream, "benny", "skills", "triage-issue-reports", "SKILL.md"))).toBe(true);
  expect(readdirSync(texts).sort()).toEqual(["benny-triage.json", "bug-fix.json", "shipping.json", "worker.json"]);
  expect(JSON.parse(readFileSync(join(texts, "bug-fix.json"), "utf8"))).toEqual({ name: "bug-fix", title: "Bug fix", text: "### Bug fix\n\nReproduce it.\n" });
});

test("a playbook removed upstream leaves the snapshot and its text with the next refresh", async () => {
  const from = await checkout();
  const into = await tempDir("snapshot");
  const upstream = join(into, "upstream");
  const texts = join(into, "texts");
  refreshUpstream(from, { upstream, texts });
  rmSync(join(from, "skills", "poteto-mode", "playbooks", "shipping.md"));
  git(from, "commit", "-q", "-am", "drop shipping");
  refreshUpstream(from, { upstream, texts });

  expect(playbookNames(upstream)).toEqual(["bug-fix"]);
  expect(existsSync(join(texts, "shipping.json"))).toBe(false);
});

test("a folder that is not an upstream checkout is refused before anything is replaced", async () => {
  const into = await tempDir("snapshot");
  expect(() => refreshUpstream(into, { upstream: join(into, "upstream"), texts: join(into, "texts") })).toThrow("is not an upstream pstack checkout");
  expect(existsSync(join(into, "upstream"))).toBe(false);
});

test("the package carries the 22 upstream playbooks, and its texts are the ones its snapshot gives", () => {
  expect(playbookNames()).toHaveLength(22);
  const committed = readdirSync(TEXTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(TEXTS_DIR, file), "utf8")) as unknown);
  expect(committed.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
    textsOf(UPSTREAM_DIR).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
});

test("a title is the first heading of the text, or the name without one", () => {
  expect(titleOf("intro\n### Autopilot-full\n", "x")).toBe("Autopilot-full");
  expect(titleOf("no heading", "eval")).toBe("eval");
});
