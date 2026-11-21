// The map of the upstream snapshot as the package carries it: it is sound, it covers the snapshot, and the texts the
// scripts import are assembled from it, whole and with nothing a session cannot reach.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OursTexts, UpstreamTexts, analyze, assemble, jsonOf, parseMapping, verifyTextsIn } from "../src/mapping/index.ts";
import { Git } from "../src/mapping/git.ts";
import { MAPPING_FILE, PACKAGE_DIR, TEXTS_DIR, UPSTREAM_DIR } from "../src/upstream.ts";

const WORKFLOWS = join(PACKAGE_DIR, "src", "workflows");
const mapping = parseMapping(readFileSync(MAPPING_FILE, "utf8"));
const root = new Git(PACKAGE_DIR).out(["rev-parse", "--show-toplevel"]).trim();
const upstream = new UpstreamTexts(UPSTREAM_DIR);
const ours = new OursTexts(root);
const texts = readdirSync(TEXTS_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({ file, raw: readFileSync(join(TEXTS_DIR, file), "utf8"), value: JSON.parse(readFileSync(join(TEXTS_DIR, file), "utf8")) as { name: string; text: string } }));

/** The text of every script of the package, by file name. */
function scripts(): Array<{ file: string; source: string }> {
  const read = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".ts")).map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }));
  return [...read(WORKFLOWS), ...read(join(WORKFLOWS, "lib"))];
}

test("the map is sound and covers the snapshot, with every range recorded at the snapshot's commit", () => {
  const report = analyze(mapping, upstream, ours);
  expect(report.problems).toEqual([]);
  expect(report.coverage.percent).toBeGreaterThanOrEqual(95);
  expect(report.coverage.files.length).toBeGreaterThan(30);
  expect(mapping.entries.every((one) => one.upstream.commit === upstream.current)).toBe(true);
  // Later changes to code the map links to are for the next sync to measure; unlinked code needs no entry.
  expect(report.entries.filter((one) => one.status === "gone")).toEqual([]);
});

test("the texts the scripts import are the ones the map assembles, and no other", () => {
  const made = assemble(mapping, upstream, ours);
  expect(texts.map((one) => one.file).sort()).toEqual(made.map((one) => `${one.name}.json`).sort());
  for (const one of made) expect(texts.find((found) => found.file === `${one.name}.json`)?.raw).toBe(jsonOf(one));
});

test("every text equals upstream except exactly where an adapted or a dropped entry says so", () => {
  expect(verifyTextsIn(mapping, upstream, ours, TEXTS_DIR)).toEqual([]);
});

test("no script edits a text it imports: it is given to a session as the map assembled it", () => {
  const names = texts.map((one) => one.file.replace(/\.json$/, ""));
  for (const { file, source } of scripts()) {
    const bound = [...source.matchAll(/import (\w+) from "(?:\.\.?\/)+(?:workflows\/)?texts\/([\w-]+)\.json"/g)].filter((found) => names.includes(found[2] as string)).map((found) => found[1] as string);
    for (const local of bound) {
      const edited = new RegExp(`\\b${local}\\.text\\.(?!trim\\(\\))\\w+`).exec(source)?.[0];
      expect({ file, local, edited }).toEqual({ file, local, edited: undefined });
    }
  }
});

test("every text is imported by a script", () => {
  const all = scripts();
  for (const { file } of texts) {
    const used = all.some((one) => one.source.includes(`texts/${file}"`));
    expect({ file, used }).toEqual({ file, used: true });
  }
});

test("no text names a file of upstream's that its session is not given", () => {
  const dead = /(?:\.\.\/)?(?:references|playbooks|scripts)\/[\w./<>-]+|`[\w./-]+\.(?:md|sh)`|\]\([^)]*\.md\)/;
  for (const { file, value } of texts) {
    const found = dead.exec(value.text)?.[0];
    expect({ file, found: found?.startsWith("/tmp") ? undefined : found }).toEqual({ file, found: undefined });
  }
});

test("babysit's sessions are given the Bugbot reference its playbook sends them to", () => {
  const babysit = scripts().find((one) => one.file === "babysit.ts")?.source ?? "";
  expect(babysit).toContain('texts/bugbot-triage.json"');
  expect(babysit.match(/\.\.\.BUGBOT_REFERENCE/g)).toHaveLength(2);
  const text = texts.find((one) => one.file === "babysit.json")?.value.text ?? "";
  expect(text).toContain("the Bugbot triage reference given below");
  const reference = texts.find((one) => one.file === "bugbot-triage.json")?.value.text ?? "";
  expect(reference).toContain("## Decision rubric");
});

test("Benny's reproduction is given the references its skill names, after the skill", () => {
  const text = texts.find((one) => one.file === "benny-reproduce.json")?.value.text ?? "";
  const skill = text.indexOf("# Reproduce and fix issues");
  const verify = text.indexOf("# Verify an existing fix");
  const adapter = text.indexOf("# Control-adapter contract");
  expect(skill).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(skill);
  expect(adapter).toBeGreaterThan(verify);
  expect(text).toContain("the verify-existing-fix reference given after this text");
  expect(text).toContain("the control-adapter reference given after this text");
});

test("the playbooks that no session is given as text are code of ours, or dropped", () => {
  for (const name of ["shipping", "worktree-cleanup"]) {
    const entries = mapping.entries.filter((one) => one.upstream.file === `poteto-mode/playbooks/${name}.md`);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((one) => one.kind === "code" || one.kind === "dropped")).toBe(true);
    expect(texts.some((one) => one.file === `${name}.json`)).toBe(false);
  }
});

test("each block of SKILL.md is linked to the code that implements it or dropped with its reason", () => {
  const blocks = mapping.entries.filter((one) => one.upstream.file === "poteto-mode/SKILL.md");
  expect(blocks.length).toBeGreaterThan(20);
  for (const one of blocks) {
    expect(one.kind === "code" || one.kind === "dropped").toBe(true);
    if (one.kind === "dropped") expect(one.note?.length).toBeGreaterThan(10);
  }
});

test("the map tool prints the numbers of the snapshot it is run on", () => {
  const ran = Bun.spawnSync(["bun", join(PACKAGE_DIR, "scripts", "upstream-map.ts"), "check", "--summary"], { stdout: "pipe", stderr: "pipe" });
  expect(ran.exitCode).toBe(0);
  const summary = JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) as string) as { problems: number; coverage: number; entries: number };
  expect(summary.problems).toBe(0);
  expect(summary.coverage).toBeGreaterThanOrEqual(95);
  expect(summary.entries).toBe(mapping.entries.length);
});

test("the map tool says a map it cannot read is a problem, in the form it says the others, and does not crash", () => {
  const file = join(tmpdir(), `broken-map-${String(process.pid)}.json`);
  writeFileSync(file, '{"entries": [{"id": "x"}');
  const ran = Bun.spawnSync(["bun", join(PACKAGE_DIR, "scripts", "upstream-map.ts"), "check", "--summary", "--map", file], { stdout: "pipe", stderr: "pipe" });
  rmSync(file);
  expect(ran.exitCode).toBe(1);
  const summary = JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) as string) as { problems: number; error: string };
  expect(summary.problems).toBe(1);
  expect(summary.error.length).toBeGreaterThan(0);
});

test("the summary the sync reads is one short line of numbers", () => {
  const ran = Bun.spawnSync(["bun", join(PACKAGE_DIR, "scripts", "upstream-map.ts"), "check", "--summary"], { stdout: "pipe", stderr: "pipe" });
  const line = ran.stdout.toString().trim();
  expect(line.split("\n")).toHaveLength(1);
  expect(line.length).toBeLessThan(300);
});

test("every commit of ours the map records is in the history of HEAD", () => {
  const git = new Git(root);
  for (const commit of new Set(mapping.entries.flatMap((one) => one.ours.map((link) => link.commit)))) {
    expect({ commit, ancestor: git.run(["merge-base", "--is-ancestor", commit, "HEAD"]).exit }).toEqual({ commit, ancestor: 0 });
  }
});
