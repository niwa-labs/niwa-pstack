// The mapping tool: it validates the mapping, measures how much of the upstream text it covers, and follows each
// range from the commit it was recorded at to the current one on both sides, without concluding anything.

import { expect, test } from "bun:test";

import { accept, advance, analyze, assemble, formatMapping, formatReport, parseMapping } from "@niwa-labs/upstream-map";
import { OURS_FILES, UPSTREAM_FILES, World, at, git, mapping } from "./mapping-support.ts";

const SKILL = "skills/poteto-mode/SKILL.md";
const BUG_FIX = "skills/poteto-mode/playbooks/bug-fix.md";
const SKILL_TEXT = UPSTREAM_FILES[SKILL] as string;
const BUG_TEXT = UPSTREAM_FILES[BUG_FIX] as string;
const BRIEF = OURS_FILES["src/brief.ts"] as string;

/** Entries that cover the whole of SKILL.md, the worker rules and the bug-fix playbook, split in blocks. */
function covering(w: World) {
  const brief = [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }];
  const mine = (file: string, snapshot: string, text: string, id: string, needle: string, kind: "prompt" | "code" | "dropped" = "prompt") =>
    w.entry(id, kind, { file: snapshot, text, needle }, kind === "dropped" ? [] : brief, kind === "dropped" ? "not taken" : undefined);
  return [
    mine("", "poteto-mode/SKILL.md", SKILL_TEXT, "skill.title", "# Mode\n\n", "dropped"),
    mine("", "poteto-mode/SKILL.md", SKILL_TEXT, "skill.alpha", "Alpha block.\n\n"),
    mine("", "poteto-mode/SKILL.md", SKILL_TEXT, "skill.beta", "Beta block.\n"),
    mine("", "poteto-mode/worker.md", UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string, "worker.all", "Work for the operator.\n"),
    mine("", "poteto-mode/playbooks/bug-fix.md", BUG_TEXT, "bug-fix.head", "### Bug fix\n\nReproduce it.\n\n"),
    mine("", "poteto-mode/playbooks/bug-fix.md", BUG_TEXT, "bug-fix.fix", "Fix the cause.\n", "code"),
  ];
}

test("a sound mapping has no problems, and its coverage is a share of the upstream characters", async () => {
  const w = await World.make();
  const report = analyze(mapping(...covering(w)), w.upstream(false), w.ours());
  expect(report.problems).toEqual([]);
  expect(report.coverage.percent).toBe(100);
  expect(report.coverage.files.map((one) => one.file)).toEqual(["poteto-mode/SKILL.md", "poteto-mode/playbooks/bug-fix.md", "poteto-mode/worker.md"]);
  expect(report.unresolved).toBe(0);
});

test("coverage is counted per file and in total, and the uncovered ranges are listed with their text", async () => {
  const w = await World.make();
  const entries = covering(w).filter((one) => one.id !== "skill.beta" && one.id !== "worker.all");
  const report = analyze(mapping(...entries), w.upstream(false), w.ours());
  const skill = report.coverage.files.find((one) => one.file === "poteto-mode/SKILL.md");
  const worker = report.coverage.files.find((one) => one.file === "poteto-mode/worker.md");
  expect(skill?.uncovered).toEqual([{ start: SKILL_TEXT.indexOf("Beta"), end: SKILL_TEXT.length, text: "Beta block.\n", added: false }]);
  expect(skill?.percent).toBeCloseTo(((SKILL_TEXT.length - 12) / SKILL_TEXT.length) * 100, 6);
  expect(worker?.percent).toBe(0);
  expect(worker?.uncovered).toHaveLength(1);
  const total = (UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string).length + SKILL_TEXT.length + BUG_TEXT.length;
  expect(report.coverage.size).toBe(total);
  expect(report.coverage.covered).toBe(total - 12 - (UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string).length);
});

test("a dropped block counts as covered", async () => {
  const w = await World.make();
  const entry = w.entry("whole", "dropped", { file: "poteto-mode/worker.md", text: UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string, needle: "Work for the operator.\n" }, [], "the operator is a person");
  const report = analyze(mapping(entry), w.upstream(false), w.ours());
  expect(report.coverage.files.find((one) => one.file === "poteto-mode/worker.md")?.percent).toBe(100);
});

test("the license and the snapshot's own files are not upstream text", async () => {
  const w = await World.make();
  const report = analyze(mapping(), w.upstream(false), w.ours());
  expect(report.coverage.files.map((one) => one.file)).not.toContain("LICENSE");
  expect(report.coverage.files.map((one) => one.file)).not.toContain("SOURCE.json");
});

test("two entries that cover the same upstream characters at one commit are refused", async () => {
  const w = await World.make();
  const [a, b] = covering(w).filter((one) => one.id.startsWith("bug-fix"));
  const overlapping = { ...(b as NonNullable<typeof b>), upstream: { ...(b as NonNullable<typeof b>).upstream, range: [(a as NonNullable<typeof a>).upstream.range[1] - 3, (b as NonNullable<typeof b>).upstream.range[1]] as [number, number] } };
  const report = analyze(mapping(a as NonNullable<typeof a>, overlapping), w.upstream(false), w.ours());
  expect(report.problems.map((one) => one.message)).toEqual(["the upstream range overlaps the one of bug-fix.head"]);
  expect(report.entries.map((one) => one.id)).toEqual(["bug-fix.head"]);
});

test("a range outside its file at its commit, a missing file and a repeated id are refused", async () => {
  const w = await World.make();
  const [first] = covering(w);
  const base = first as NonNullable<typeof first>;
  const beyond = { ...base, id: "beyond", upstream: { ...base.upstream, range: [0, 9999] as [number, number] } };
  const nowhere = { ...base, id: "nowhere", upstream: { ...base.upstream, file: "poteto-mode/none.md" } };
  const ours = { ...base, id: "ours", kind: "prompt" as const, ours: [{ commit: w.oursCommit, file: "src/brief.ts", range: [0, 9999] as [number, number] }] };
  const again = { ...base };
  const report = analyze(mapping(base, again, beyond, nowhere, ours), w.upstream(false), w.ours());
  const said = report.problems.map((one) => `${one.entry}: ${one.message.split(" ").slice(0, 3).join(" ")}`);
  expect(said).toContain(`${base.id}: the id is`);
  expect(said).toContain("beyond: upstream range [0,");
  expect(said).toContain("nowhere: poteto-mode/none.md is not");
  expect(said).toContain("ours: our range [0,");
});

test("a dropped entry needs a note and no range of ours, and any other kind needs a range of ours", async () => {
  const w = await World.make();
  const base = covering(w).find((one) => one.id === "skill.alpha") as ReturnType<typeof covering>[number];
  const noNote = { ...base, id: "no-note", kind: "dropped" as const, ours: [], note: undefined };
  const linked = { ...base, id: "linked", kind: "dropped" as const, note: "why" };
  const unlinked = { ...base, id: "unlinked", kind: "code" as const, ours: [] };
  const { note: _note, ...bare } = noNote;
  const report = analyze(mapping(bare, linked, unlinked), w.upstream(false), w.ours());
  expect(report.problems.map((one) => `${one.entry}: ${one.message}`)).toEqual([
    "no-note: a dropped entry says why in its note",
    "linked: a dropped entry has no range of ours",
    "unlinked: a code entry links to the ranges of ours that carry it",
  ]);
});

test("a range of ours that only shifted is unchanged, at its new position", async () => {
  const w = await World.make();
  const entry = w.entry("a", "code", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Alpha block." }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const later = w.evolveOurs({ "src/brief.ts": `// header\n${BRIEF}` });
  const report = analyze(mapping(entry), w.upstream(false), w.ours());
  const moved = report.entries[0]?.ours[0];
  expect(moved?.status).toBe("unchanged");
  expect(moved?.to).toEqual({ commit: later, file: "src/brief.ts", range: [...at(`// header\n${BRIEF}`, "// the assembler")] });
  expect(report.entries[0]?.status).toBe("unchanged");
});

test("a range of ours that was edited is touched, with its old and new text", async () => {
  const w = await World.make();
  const entry = w.entry("a", "code", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Alpha block." }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  w.evolveOurs({ "src/brief.ts": BRIEF.replace("// the assembler", "// the new assembler") });
  const report = analyze(mapping(entry), w.upstream(false), w.ours());
  const moved = report.entries[0]?.ours[0];
  expect(report.entries[0]?.status).toBe("touched");
  expect(moved?.status).toBe("touched");
  expect(moved?.old).toBe("// the assembler");
  expect(moved?.new).toContain("new assembler");
});

test("a file of ours that was renamed is followed, and one that was deleted is gone", async () => {
  const w = await World.make();
  const entry = (id: string, file: string, text: string) => w.entry(id, "adapted", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: id === "r" ? "Alpha block." : "Beta block." }, [{ file, text, needle: "Own words." }]);
  const entries = [entry("r", "src/adapted.md", OURS_FILES["src/adapted.md"] as string), w.entry("d", "code", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Beta block." }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }])];
  const head = w.evolveOurs({ "src/adapted.md": null, "src/renamed.md": OURS_FILES["src/adapted.md"] as string, "src/brief.ts": null });
  const report = analyze(mapping(...entries), w.upstream(false), w.ours());
  expect(report.entries.find((one) => one.id === "r")?.ours[0]?.to).toEqual({ commit: head, file: "src/renamed.md", range: [0, 10] });
  expect(report.entries.find((one) => one.id === "d")?.status).toBe("gone");
});

test("our side is measured against the working tree on request, and against HEAD otherwise", async () => {
  const w = await World.make();
  const entry = w.entry("a", "code", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Alpha block." }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${w.oursDir}/src/brief.ts`, BRIEF.replace("// the assembler", "// edited"));
  expect(analyze(mapping(entry), w.upstream(false), w.ours()).entries[0]?.status).toBe("unchanged");
  expect(analyze(mapping(entry), w.upstream(false), w.ours("worktree")).entries[0]?.status).toBe("touched");
});

test("a new upstream commit moves the upstream side: shifted, touched with both texts, and gone", async () => {
  const w = await World.make();
  const recorded = w.upstreamCommit;
  const e = (id: string, file: string, text: string, needle: string) => w.entry(id, "prompt", { file, text, needle }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const entries = [e("alpha", "poteto-mode/SKILL.md", SKILL_TEXT, "Alpha block.\n"), e("beta", "poteto-mode/SKILL.md", SKILL_TEXT, "Beta block.\n"), e("fix", "poteto-mode/playbooks/bug-fix.md", BUG_TEXT, "Fix the cause.\n")];
  const next = w.evolveUpstream({ [SKILL]: SKILL_TEXT.replace("# Mode\n", "# Mode\n\nNew intro.\n").replace("Beta block.", "Beta block, reworded."), [BUG_FIX]: BUG_TEXT.replace("Fix the cause.\n", "") });
  const report = analyze(mapping(...entries), w.upstream(), w.ours());
  expect(report.upstream.commit).toBe(next);
  const by = (id: string) => report.entries.find((one) => one.id === id);
  expect(by("alpha")?.upstream.status).toBe("unchanged");
  expect(by("alpha")?.upstream.from.commit).toBe(recorded);
  expect(by("alpha")?.upstream.to?.commit).toBe(next);
  expect(by("beta")?.upstream.status).toBe("touched");
  expect(by("beta")?.upstream.old).toBe("Beta block.\n");
  expect(by("beta")?.upstream.new).toBe("Beta block, reworded.\n");
  expect(by("fix")?.status).toBe("gone");
  expect(report.unresolved).toBe(2);
});

test("text upstream added since the recorded commit is reported as new uncovered text", async () => {
  const w = await World.make();
  const e = (id: string, needle: string) => w.entry(id, "prompt", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const map = mapping(e("alpha", "Alpha block.\n"), e("beta", "Beta block.\n"));
  w.evolveUpstream({ [SKILL]: `${SKILL_TEXT}\nGamma block.\n` });
  const skill = analyze(map, w.upstream(), w.ours()).coverage.files.find((one) => one.file === "poteto-mode/SKILL.md");
  const added = skill?.uncovered.filter((one) => one.added).map((one) => one.text);
  expect(added).toEqual(["\nGamma block.\n"]);
  expect(skill?.uncovered.some((one) => !one.added && one.text.includes("# Mode"))).toBe(true);
});

test("a range at an upstream commit needs the checkout it is read from", async () => {
  const w = await World.make();
  const e = w.entry("alpha", "prompt", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Alpha block.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  w.evolveUpstream({ [SKILL]: `${SKILL_TEXT}\nGamma block.\n` });
  expect(() => analyze(mapping(e), w.upstream(false), w.ours())).toThrow("give the upstream checkout");
});

test("advance records the unchanged entries at the current commits and leaves the touched ones", async () => {
  const w = await World.make();
  const e = (id: string, needle: string) => w.entry(id, "prompt", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const map = mapping(e("alpha", "Alpha block.\n"), e("beta", "Beta block.\n"));
  const next = w.evolveUpstream({ [SKILL]: SKILL_TEXT.replace("Beta block.", "Beta, reworded.").replace("# Mode\n", "# Mode\n\nIntro.\n") });
  const ours = w.evolveOurs({ "src/brief.ts": `// top\n${BRIEF}` });
  const report = analyze(map, w.upstream(), w.ours());
  const advanced = advance(map, report);
  expect(advanced.entries[0]?.upstream.commit).toBe(next);
  expect(advanced.entries[0]?.ours[0]?.commit).toBe(ours);
  expect(advanced.entries[1]).toEqual(map.entries[1]);
  // After it, the entry is read at the current commits: nothing to carry, nothing moved.
  const after = analyze(advanced, w.upstream(), w.ours());
  expect(after.entries.find((one) => one.id === "alpha")?.status).toBe("unchanged");
  expect(after.entries.find((one) => one.id === "alpha")?.upstream.from.commit).toBe(next);
});

test("accept records the named touched entry at its carried positions, and refuses a gone one", async () => {
  const w = await World.make();
  const e = (id: string, needle: string, file = "poteto-mode/SKILL.md", text = SKILL_TEXT) => w.entry(id, "prompt", { file, text, needle }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const map = mapping(e("beta", "Beta block.\n"), e("fix", "Fix the cause.\n", "poteto-mode/playbooks/bug-fix.md", BUG_TEXT));
  w.evolveUpstream({ [SKILL]: SKILL_TEXT.replace("Beta block.", "Beta, reworded."), [BUG_FIX]: BUG_TEXT.replace("Fix the cause.\n", "") });
  const report = analyze(map, w.upstream(), w.ours());
  const accepted = accept(map, report, ["beta"]);
  expect(accepted.entries[0]?.upstream.commit).toBe(w.upstreamCommit);
  expect(report.entries.find((one) => one.id === "beta")?.status).toBe("touched");
  expect(analyze(accepted, w.upstream(), w.ours()).entries.find((one) => one.id === "beta")?.status).toBe("unchanged");
  expect(() => accept(map, report, ["fix"])).toThrow("is gone");
  expect(() => accept(map, report, ["nope"])).toThrow("is not an entry");
});

test("the working tree cannot be recorded: the ranges of ours need a commit", async () => {
  const w = await World.make();
  const e = w.entry("alpha", "prompt", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Alpha block.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const map = mapping(e);
  expect(() => advance(map, analyze(map, w.upstream(false), w.ours("worktree")))).toThrow("commit");
});

test("texts are assembled from the blocks: prompt verbatim, adapted from our text, code and dropped left out", async () => {
  const w = await World.make();
  const own = OURS_FILES["src/adapted.md"] as string;
  const blocks = [
    w.entry("head", "prompt", { file: "poteto-mode/playbooks/bug-fix.md", text: BUG_TEXT, needle: "### Bug fix\n\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]),
    w.entry("step", "adapted", { file: "poteto-mode/playbooks/bug-fix.md", text: BUG_TEXT, needle: "Reproduce it.\n\n" }, [{ file: "src/adapted.md", text: own, needle: "Own words.\n" }]),
    w.entry("fix", "code", { file: "poteto-mode/playbooks/bug-fix.md", text: BUG_TEXT, needle: "Fix the cause.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]),
    w.entry("worker", "prompt", { file: "poteto-mode/worker.md", text: UPSTREAM_FILES["skills/poteto-mode/worker.md"] as string, needle: "Work for the operator.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]),
  ];
  const made = assemble(mapping(...blocks), w.upstream(false), w.ours());
  expect(made).toEqual([
    { name: "bug-fix", title: "Bug fix", text: "### Bug fix\n\nOwn words.\n" },
    { name: "worker", title: "Worker rules", text: "Work for the operator.\n" },
  ]);
});

test("a text whose blocks are all prompt is its upstream file byte for byte, and an unmapped file has no text", async () => {
  const w = await World.make();
  const e = w.entry("all", "prompt", { file: "poteto-mode/playbooks/bug-fix.md", text: BUG_TEXT, needle: BUG_TEXT }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  const made = assemble(mapping(e), w.upstream(false), w.ours());
  expect(made.map((one) => one.name)).toEqual(["bug-fix"]);
  expect(made[0]?.text).toBe(BUG_TEXT);
});

test("a block recorded at an older upstream commit is not assembled", async () => {
  const w = await World.make();
  const e = w.entry("alpha", "prompt", { file: "poteto-mode/playbooks/bug-fix.md", text: BUG_TEXT, needle: "Fix the cause.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  w.evolveUpstream({ [BUG_FIX]: `${BUG_TEXT}More.\n` });
  expect(() => assemble(mapping(e), w.upstream(), w.ours())).toThrow("carry the entry to the snapshot");
});

test("the mapping is written an entry to a line, and read back as it was", async () => {
  const w = await World.make();
  const map = mapping(...covering(w));
  const text = formatMapping(map);
  expect(text.split("\n").filter((line) => line.includes('"id"'))).toHaveLength(map.entries.length);
  expect(parseMapping(text)).toEqual(map);
  expect(() => parseMapping('{"entries":[{"id":"x"}]}')).toThrow();
  expect(() => parseMapping(JSON.stringify({ entries: [{ ...map.entries[0], upstream: { ...map.entries[0]?.upstream, range: [5, 5] } }] }))).toThrow();
});

test("the report says what is touched with the old and new text, and draws no conclusion", async () => {
  const w = await World.make();
  const e = w.entry("beta", "prompt", { file: "poteto-mode/SKILL.md", text: SKILL_TEXT, needle: "Beta block.\n" }, [{ file: "src/brief.ts", text: BRIEF, needle: "// the assembler" }]);
  w.evolveUpstream({ [SKILL]: SKILL_TEXT.replace("Beta block.", "Beta, reworded.") });
  const text = formatReport(analyze(mapping(e), w.upstream(), w.ours()));
  expect(text).toContain("COVERAGE");
  expect(text).toContain("touched beta (prompt)");
  expect(text).toContain('old: "Beta block."');
  expect(text).toContain('new: "Beta, reworded."');
  expect(git(w.upstreamDir, "rev-parse", "HEAD")).toContain(w.upstreamCommit);
});
