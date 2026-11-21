# @niwa-labs/pstack

Delivery playbooks run as niwa's built-in workflows: an entry that routes a request to the playbook it needs, one
workflow per upstream playbook, Benny for issue reports when he is enabled, and a suite that tries every new version
of them before the host runs it.

## Composition

```ts
import { addressingOf, pstack } from "@niwa-labs/pstack";

const base = defaultComposition({ home, harnesses, kinds, agents });
export default [
  ...base,
  ...pstack({
    bind: addressingOf(base),
    forge: { servers: [{ host: "gitlab.example.com", url: "https://gitlab.example.com", token: secret("GITLAB_TOKEN") }] },
    roles: {
      lead: { harness: "claude" },
      author: { harness: "codex", box: true },
      reviewer: { harness: "claude" },
      verifier: { harness: "pi", vendor: "minimax" },
      judge: { harness: "pi", vendor: "glm" },
    },
    benny: { repo: { host: "gitlab.example.com", path: "acme/billing", local: "/work/billing" } },
  }),
  workflow(),
];
```

`pstack()` installs forge, evidence, watch and plan, then the pstack plugin. The host provides the sessions and git
modules before it and the workflow module after it. `bind` is the binding of the host's sessions and agents modules
(`addressingOf`), so a session attests under one address for its whole life and an agent's session as the agent.

## Roles

- `lead` frames, routes and judges, read-only.
- `author` writes code. It carries `box: true`: pstack's plugin starts its sessions (`pstack.author.start`) with writes
  limited to one of niwa's worktrees, by real path, and network limited to the forges' hosts. A place outside niwa's
  worktrees is refused before a session exists.
- `reviewer` judges review threads.
- `verifier` re-runs the gates and shows the behaviour live. It must run on another harness than the author, and it
  attests its verdicts under its own name.
- `judge` grades an evaluation. It is of another vendor than the candidates.

## Playbooks

| Playbook | What it does |
|---|---|
| investigation | Answers a question about the code, with sources |
| trace-forensics, runtime-forensics | Hold hypotheses against a trace or runtime evidence, and name the cause one confirmed hypothesis leaves |
| bug-fix, feature, refactoring, perf-issue, visual-parity, authoring-a-skill | The lead frames the work, and an owner lane carries it to a verified pull request |
| hillclimb | One metric, one change at a time: kept when the measurement moved, reverted in full otherwise |
| autonomous-run | Iterates in a boxed worktree until a done predicate holds |
| prototype | Throwaway variants in scratch worktrees, and a recommendation |
| eval | Variants answer blind; a judge of another vendor grades them on a rubric they never see |
| multi-phase-plan | Writes the plan as a revision in niwa and asks the owner's go, attested node by node |
| autopilot-full | One owner lane per plan node, in parallel off trunk; the nodes land one at a time under the merge policy |
| autopilot-stack | The same, stacked where one node builds on another, without merging; it can carry a stack onto a new lower head |
| shipping | Lands a verified stack bottom up under the merge policy |
| opening-a-pr | Opens a ready pull request with the briefing upstream asks for |
| babysit | Conflicts, threads, then CI, in `check`, `threads-only` or `drive` mode; it never merges or rebases |
| pause-safely | A `wip:` commit and a resume note in the worktree the work is in |
| session-pickup | Where the work stands, from the plan and what was attested on it |
| worktree-cleanup | On a merge on the forge, removes the clean worktrees the merged head was built in |
| upstream-sync | Not a playbook: carries the map of the upstream snapshot to a new snapshot, below |

A lane builds in a worktree off trunk with a boxed author. It opens the pull request only for the commit the author
made; a head on the forge that the author did not answer is a push the lane did not make. Verifiers that did not write
the code attest the `gates` and `live` verdicts on that head.

## The merge policy

A pull request lands only when all of these hold at its current head:

- the owner's go covers each plan node it delivers. A go is bound by digest to the plan's revision, the node and the
  change, and only the owner or a run may give one. A revised plan needs a new go.
- the `gates` and `live` verdicts passed, from someone other than the patch's author;
- the pipeline of the head is green;
- the merge result of the pair the forge would merge now is green and attested with that pair of commits.

Trunk that conflicts with the patch stops the landing before anything is asked of the forge. Any other move of trunk
(a file both sides changed, a lockfile, a manifest, a file that names a patched one) is what the merge result tests.
The merge is made at the head the policy was checked on, and is read back from the forge.

## Candidates and the suite

Every built-in but the suite is offered gated. A new version comes in as a candidate that the host neither installs nor
runs on events. Before any version was accepted, the candidate is shown and runs on nothing.

The suite (`pstack-suite`) is started by the owner on a fixture: a repository it may change, on a forge project it may
merge into. It runs every scenario in order on the set under trial, each built-in started by its version. The entry is
pinned to the playbook versions of the set, and one scenario hands its plan to the next. Only when every scenario passes
does it promote the candidates, in one `workflow.builtin.promote` with its run's id. On its own fixture's plans, the
suite gives the go itself, as a run may.

## Benny

With `benny`, the plugin offers the agent `benny` to the agents module, an action `benny.report`, and two gated
automations. Every report is triaged as data. A report triaged as a bug is reproduced twice before any code is touched,
and then fixed in a draft pull request. Benny never merges or deploys.

## The upstream snapshot and its map

`upstream/` keeps the pstack plugin of [cursor/plugins](https://github.com/cursor/plugins) (MIT) at the commit in
`upstream/SOURCE.json`: the operator's skill, the worker rules, the playbooks, the references they name, and the Benny
pack. `upstream/mapping.json` records what became of it in pstack, an entry to a line:

```json
{"id":"bug-fix:03","upstream":{"commit":"<upstream commit>","file":"poteto-mode/playbooks/bug-fix.md","range":[476,892]},"ours":[{"commit":"<pstack commit>","file":"packages/pstack/src/workflows/lib/texts.ts","range":[120,610]}],"kind":"prompt"}
```

- A range is `[start, end)` in characters (UTF-16 code units, as `String.slice` counts), and no text is stored. The
  upstream side names a file of the snapshot at a commit of upstream. Our side names a file of this repository, from
  its root, at the pstack commit the range was recorded at.
- `kind` says what became of the block. `prompt`: it goes into a prompt as upstream wrote it. `adapted`: our own text
  replaces it in a prompt (the text is in `src/workflows/adapted.md`, and the entry links to its range). `code`: code
  of ours implements it. `dropped`: we do not take it, and `note` says why.
- The upstream side is covered almost entirely: the files of the snapshot are cut into blocks, and what is not taken is
  `dropped`, which counts as covered. The target is 95% of upstream's characters. The two upstream ranges of one file at
  one commit never overlap. Our side is not covered: `ours` only links a block to the code or text that implements or
  carries it, so several entries may link to the same range, and code of ours with no entry is fine.
- The texts the scripts import, `src/workflows/texts/*.json`, are assembled from the map: the `prompt` blocks of a file
  verbatim from the snapshot, the `adapted` ones from our text, in upstream's order. `dropped` blocks are in no prompt.
  A text is the files it is made of, each cut at its last non-blank character and followed by one blank line, and that
  glue is the only thing in it that is not a block. They are not edited by hand: `assemble` writes them.
- Nothing is edited in a prompt outside the map. A text equals upstream except exactly where an `adapted` entry puts our
  wording in and a `dropped` entry takes a range out, so a file that goes into a text has no `code` block: a block that
  code of ours implements and a prompt leaves out is `dropped`, and its note says where the code is. `check` reads the
  texts as they are on disk and holds each to the map (see below).

The tool is `bun packages/pstack/scripts/upstream-map.ts`:

| Command | What it does |
|---|---|
| `check` | Validates the map and reports the coverage of upstream's characters, per file and in total, with the uncovered ranges. For each entry, on each side, it follows the range from the commit it was recorded at to the current one (upstream: to the snapshot's commit; ours: to `HEAD`, or the working tree with `--worktree`) and says unchanged (it only shifted), touched (with the old and the new text of the range) or gone. It also lists upstream text that is new and uncovered, and the texts' own problems (an edit by hand, a block left out as `code`, upstream text no entry accounts for, a text with no file or a file with no text), which it counts apart from the map's because they follow the map and lag it until `assemble`. It draws no conclusion. `--out <file>` writes the report as JSON, `--summary` prints the numbers. |
| `advance` | Records the entries that are unchanged at the current commits and positions. |
| `accept <id>...` | Records the named entries at the positions their ranges were carried to. |
| `assemble` | Writes the texts from the map; `--check` only compares. |
| `refresh <checkout> [<commit>]` | Takes a new snapshot of an upstream checkout at a commit of it, read through git: the checkout's working tree is not read and it is not written. The mapping stays. |

Ranges are carried by comparing the two texts by lines and then by the characters the changed lines share at their
start and end. `--upstream <checkout>` is needed only while the map has ranges at an upstream commit other than the
snapshot's.

### Updating upstream

Start `pstack-upstream-sync` with the path of an upstream checkout (and a commit of it, if not its HEAD). It is not
gated: it changes no host. In a worktree of its own it takes the snapshot and commits it, then loops: the tool measures
the map, and an author boxed to the worktree works on what the report shows (maps uncovered text, follows touched and
gone entries into our code and texts, drops what is not taken with the reason), commits, and the unchanged entries are
recorded again. It stops when the coverage is at least 95% (`min`) and no entry is touched or gone, or after `rounds`
rounds, and says what is left. What would change what a prompt or a workflow does is not the author's to decide: it
goes to the owner as a question, and its answer is carried out in a last round. The texts are then assembled from the
map and committed. The run ends on a branch of commits; the workflows they change come in as candidates and go through
`pstack-suite` as before.

By hand, the same: `refresh`, then `check`, settle what it shows, `accept` or edit the entries, `advance`, `assemble`.
The tool runs in a box that must be able to read the checkout.

## What niwa does not give yet

- A script's `uses` holds call rules only, so a run cannot hold the write and network rules of a box. The author's box
  is a right of the pstack plugin.
- The git module's actions carry no target, so the entry's `git.*@{repo.local}` reaches none of them. The entry names
  the worktree actions it calls untargeted.
