// The texts the scripts import are held to the map: they equal upstream except exactly where an adapted or a dropped
// entry says so.

import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempDir } from "@niwa-labs/testing";

import { analyze, assemble, jsonOf, parseMapping, verifyTextsIn, writeTexts } from "../src/mapping/index.ts";
import type { Entry } from "../src/mapping/index.ts";
import { OURS_FILES, UPSTREAM_FILES, World, mapping } from "./mapping-support.ts";

const BUG_FIX = "poteto-mode/playbooks/bug-fix.md";
const BUG_TEXT = UPSTREAM_FILES["skills/poteto-mode/playbooks/bug-fix.md"] as string;
const WORKER = "poteto-mode/worker.md";
const WORKER_TEXT = UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string;
const BRIEF = OURS_FILES["src/brief.ts"] as string;
const OWN = OURS_FILES["src/adapted.md"] as string;

/** The map of the playbook in two blocks and the worker rules in one, each as `kind` says. */
function mapOf(w: World, kinds: { head?: Entry["kind"]; fix?: Entry["kind"]; worker?: Entry["kind"] } = {}) {
  const carried = [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }];
  const own = [{ file: "src/adapted.md", text: OWN, needle: "Own words." }];
  const make = (id: string, file: string, text: string, needle: string, kind: Entry["kind"]) => w.entry(id, kind, { file, text, needle }, kind === "dropped" ? [] : kind === "adapted" ? own : carried, kind === "dropped" ? "not taken" : undefined);
  return mapping(
    make("head", BUG_FIX, BUG_TEXT, "### Bug fix\n\nReproduce it.\n\n", kinds.head ?? "prompt"),
    make("fix", BUG_FIX, BUG_TEXT, "Fix the cause.\n", kinds.fix ?? "prompt"),
    make("worker", WORKER, WORKER_TEXT, "Work for the operator.\n", kinds.worker ?? "prompt"),
  );
}

/** The texts folder the map assembles, written as the package writes it. */
async function written(w: World, map: ReturnType<typeof mapOf>): Promise<string> {
  const dir = join(await tempDir("texts"), "texts");
  writeTexts(assemble(map, w.upstream(false), w.ours()), dir);
  return dir;
}

const problemsOf = (w: World, map: ReturnType<typeof mapOf>, dir: string) => verifyTextsIn(map, w.upstream(false), w.ours(), dir).map((one) => `${one.entry ?? "-"}: ${one.message}`);

test("texts that are what the map assembles have no problem, with a dropped block out and an adapted one in", async () => {
  const w = await World.make();
  const map = mapOf(w, { head: "adapted", fix: "dropped" });
  const dir = await written(w, map);
  expect(readFileSync(join(dir, "bug-fix.json"), "utf8")).toContain("Own words.");
  expect(problemsOf(w, map, dir)).toEqual([]);
  expect(analyze(map, w.upstream(false), w.ours()).problems).toEqual([]);
});

test("a text edited by hand is a problem that says where it parts from the map", async () => {
  const w = await World.make();
  const map = mapOf(w);
  const dir = await written(w, map);
  const file = join(dir, "bug-fix.json");
  const text = JSON.parse(readFileSync(file, "utf8")) as { name: string; title: string; text: string };
  writeFileSync(file, jsonOf({ ...text, text: text.text.replace("Reproduce it.", "Reproduce it twice.") }));
  const found = problemsOf(w, map, dir);
  expect(found).toHaveLength(1);
  expect(found[0]).toContain("text bug-fix: it is not what the map says: they part at character");
  expect(found[0]).toContain("Reproduce it twice.");
});

test("a block left out as code, in a file that goes into a text, is a problem", async () => {
  const w = await World.make();
  const map = mapOf(w, { fix: "code" });
  const dir = await written(w, map);
  expect(problemsOf(w, map, dir)).toEqual([expect.stringContaining("fix: text bug-fix: poteto-mode/playbooks/bug-fix.md goes into this text, and its block is left out as code")]);
});

test("upstream text that no entry accounts for may be left out unrecorded, and is a problem", async () => {
  const w = await World.make();
  const full = mapOf(w);
  const map = mapping(...full.entries.filter((one) => one.id !== "fix"));
  const dir = await written(w, map);
  const found = problemsOf(w, map, dir);
  expect(found).toEqual([expect.stringMatching(/is in no entry, so the text may leave it out unrecorded/)]);
});

test("a text with no file, a file of no text, and a wrong name or title are problems", async () => {
  const w = await World.make();
  const map = mapOf(w);
  const dir = await written(w, map);
  const file = join(dir, "bug-fix.json");
  const text = JSON.parse(readFileSync(file, "utf8")) as { name: string; title: string; text: string };
  writeFileSync(file, jsonOf({ ...text, title: "Something else" }));
  writeFileSync(join(dir, "stray.json"), jsonOf({ name: "stray", title: "Stray", text: "x" }));
  const found = problemsOf(w, map, dir);
  expect(found).toEqual([expect.stringContaining("its title is \"Something else\""), expect.stringContaining("text stray: a text of no spec")]);
  const empty = join(await tempDir("empty"), "texts");
  mkdirSync(empty);
  expect(problemsOf(w, map, empty)).toEqual([expect.stringContaining("text bug-fix: the map puts blocks into it, and it has no file"), expect.stringContaining("text worker: the map puts blocks into it, and it has no file")]);
});

test("an entry still at an older upstream commit is said, not compared", async () => {
  const w = await World.make();
  const map = mapOf(w);
  const dir = await written(w, map);
  w.evolveUpstream({ "skills/poteto-mode/worker.md": `${WORKER_TEXT}More.\n` });
  const found = verifyTextsIn(parseMapping(JSON.stringify(map)), w.upstream(), w.ours(), dir).map((one) => one.message);
  expect(found.some((one) => one.includes("is recorded at upstream commit"))).toBe(true);
});
