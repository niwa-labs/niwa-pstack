# @niwa-labs/pstack

Delivery playbooks run as niwa's built-in workflows: an entry that routes a request to the playbook it needs, one
workflow per upstream playbook, Benny for issue reports when he is enabled, and a suite that tries every new version
of them before the host runs it.

## Composition

```ts
import { addressingOf, pstack } from "@niwa-labs/pstack";

const base = defaultComposition({ home, harnesses, agents });
const beforeWorkflow = base.filter((part) => part.name !== "workflow");
const workflow = base.filter((part) => part.name === "workflow");
export default [
  ...beforeWorkflow,
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
    benny: {
      repo: { host: "gitlab.example.com", path: "acme/billing", local: "/work/billing" },
      // Your plugins that provide his three ports; see "Benny needs your plugins".
      ports: [acmeTracker(), acmeChat(), acmeControl()],
    },
  }),
  ...workflow,
];
```

`pstack()` installs forge, evidence, watch and plan, then the pstack plugin. The host provides the sessions and git
modules before it and the workflow module after it. `bind` is the binding of the host's sessions and agents modules
(`addressingOf`), so a session attests under one address for its whole life and an agent's session as the agent. Without
`benny`, none of the ports below is needed.

## Roles

- `lead` frames, routes and judges, read-only.
- `author` writes code. It carries `box: true`. The workflow checks the real worktree path before opening its author
  session through the SDK. It grants that worktree's project writes and adds only the configured forge hosts covered by
  the run's grant.
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
| upstream-sync | Not a playbook: carries the map of the upstream snapshot to a new snapshot, below; gated like the playbooks |

The playbooks are upstream's text with niwa's wording where upstream names something a session does not have: Cursor's
skills and their principles, model slugs, `/loop`, `gh` and `origin`, `agent-transcripts/`. Scripts use `ask()` for
a typed one-shot answer and `session()` for a conversation with durable turns. Where a playbook shows the session tools
to a model, the model can open a helper with `session.start`, ask it with `session.ask` and close it with `session.end`.
The helper belongs to the same run and inherits its launch limits. Pull requests go through the forge module, workflows
and timers wake work, and `session.read` reads a session's history. Every such change
is an `adapted` entry of the map, or a `dropped` one with its reason, and `check` fails on any difference between a
text and upstream that the map does not say. Every session also gets the worker rules, which carry the goal, candor and
reply rules of upstream's operator skill. Benny's draft pull request is the one stated exception to the rule that a pull
request is opened ready.

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

An authoring lane records its native author session and registered worktree for the exact repository, pull request
and head. Standalone shipping reads that receipt. A missing or ambiguous receipt, or an explicit author that
differs from it, stops shipping until the head has verified provenance.

Shipping reads the target branch tip from the forge and checks the latest pipelines of this merge request against
both commit IDs. GitLab's merge endpoint can condition on the source commit only. On GitLab even a verified pair
remains open for a separate landing decision. A capable forge must enforce both commit IDs in the merge operation.

## Candidates and the suite

Every built-in but the suite is offered gated, the upstream sync among them. A new version comes in as a candidate that the host neither installs nor
runs on events. Before any version was accepted, the candidate is shown and runs on nothing.

The suite (`pstack-suite`) is started by the owner on a fixture: a repository it may change, on a forge project it may
merge into. It runs every scenario in order on the set under trial, each built-in started by its version. The entry is
pinned to the playbook versions of the set, and one scenario hands its plan to the next. The sync's scenario seeds what it
needs itself, in worktrees of the fixture: a tiny upstream checkout, and a branch holding a tiny package folder whose map
covers its snapshot; upstream is reworded, and the scenario passes when the sync carries the map across and assembles
the texts. Only when every scenario passes
does it promote the candidates, in one `workflow.builtin.promote` with its run's id. On its own fixture's plans, the
suite gives the go itself, as a run may.

## Benny

With `benny`, the plugin offers the agent `benny` to the agents module, an action `benny.report`, and two gated
automations. Every report is triaged as data: the triage session searches the issue tracker for it and files an issue
for a clear, new bug, and the workflow posts its verdict once, in the thread the report came in on. A report triaged as
a bug is reproduced twice through the product control before any code is touched, and then fixed in a draft pull
request, which is linked to its issue; the owner is told once how it ended. Benny never merges or deploys.

`benny.report` is for the report channel's plugin: it hands a report in with `source`, the channel's own address of the
report, which comes back to `benny.channel.reply` with the verdict. A report with no `source` is triaged and
reproduced all the same, and nothing is posted.

## Benny needs your plugins

Benny's tracker, chat and product are yours, not pstack's, so pstack ships three typed contracts and no
implementation of them. Each is a port: a plugin of yours offers it and registers the actions of its contract.

| Port | Offered at | Actions it provides |
|---|---|---|
| issue tracker | `BENNY_TRACKER` | `benny.tracker.find` (search by text, state and source), `benny.tracker.create` (title, body, source, labels), `benny.tracker.comment` (a recurrence note and a source on an existing issue), `benny.tracker.link-pr` (a pull request, by subject or url, on an issue) |
| report channel | `BENNY_CHANNEL` | `benny.channel.reply` (one reply in the thread of a report, by its `source`), `benny.channel.notify` (a status for the owner) |
| product control | `BENNY_CONTROL` | `benny.control.capabilities`, `bring-up`, `drive`, `inspect`, `screenshot`, `record`, `cleanup`: what upstream's control-adapter contract asks of the app it drives |

The channel also takes reports in: when one arrives, its plugin calls `benny.report` with the text, who wrote it and
its `source`. The control has no default for any project; the others have none either.

- The types are the action references `bennyTrackerFind`, `bennyChannelReply`, `bennyControlDrive` and the rest,
  exported from `@niwa-labs/pstack` with their zod schemas. `action(ref, { ... })` builds the action from a
  reference, so a provider and pstack check against one schema. The description of each reference says what the
  action must and must not do: `inspect` is read-only, `drive` is a real user action and never an injected state,
  `reply` posts in the report's thread and nowhere else, `create` makes an issue that links back to its source.
- A provider offers its port in its setup, with `api.offer(BENNY_TRACKER, { description })`. pstack reads the offers
  when it is installed, so the providers are installed before it: list them in `benny.ports` and `pstack()` does so, or
  install them yourself ahead of `...pstack()`. A host that lacks a port does not start: the error names each missing
  port and says to install its provider before pstack.
- The triage session is shown `find`, `create` and `comment`; the reproduction session is shown the control actions.
  The channel is never shown to a session: the workflow is the only poster.
- Install the providers only on a host that enables `benny`: without it pstack registers refusing stand-ins under the
  same action names (the suite's grant has to name them), and a provider would clash with them.

A minimal tracker provider:

```ts
import { action } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import { BENNY_TRACKER, bennyTrackerComment, bennyTrackerCreate, bennyTrackerFind, bennyTrackerLinkPr } from "@niwa-labs/pstack";

// `acme` is your tracker's own client; the plugin only maps it onto the contract.
export function acmeTracker() {
  return plugin("acme-tracker", (api) => {
    api.offer(BENNY_TRACKER, { description: "Acme's issue tracker" });
    api.action(action(bennyTrackerFind, { recovery: "repeat", effect: "read", world: "external", run: async (input) => ({ items: await acme.search(input.text, input.state, input.source) }) }));
    api.action(action(bennyTrackerCreate, { recovery: "do-not-repeat", effect: "write", world: "external", run: async (input) => await acme.create(input) }));
    api.action(action(bennyTrackerComment, { recovery: "do-not-repeat", effect: "write", world: "external", run: async (input) => (await acme.comment(input), { ok: true as const }) }));
    api.action(action(bennyTrackerLinkPr, { recovery: "do-not-repeat", effect: "write", world: "external", run: async (input) => (await acme.linkPr(input), { ok: true as const }) }));
  });
}
```

The chat and the control are written the same way, with their own references. The tests of this package install
in-memory providers of the three ports (`test/ports.ts`) so the suite can run Benny; they are a stand-in, not a default.

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

Start `pstack-upstream-sync` with the path of an upstream checkout (and a commit of it, if not its HEAD, and the
`package` folder of the repository, `packages/pstack` by default). It is gated like the playbooks: a new version of it
comes in as a candidate and the suite tries it first. In a worktree of its own it takes the snapshot and commits it, then
loops: the tool measures the map, and an author boxed to the worktree works on what the report shows (maps uncovered
text, follows touched and gone entries into our code and texts, drops what is not taken with the reason). The author
edits files and answers the ids of the entries that are settled where the report carried them; the workflow commits
what it edited, records those entries and the unchanged ones, and measures again. It stops when the coverage is at least
95% (`min`) and no entry is touched or gone, or after `rounds` rounds, and says what is left. What would change what a
prompt or a workflow does is not the author's to decide: it goes to the owner as a question, and its answer is carried
out in a last round. The texts are then assembled from the map and committed, and the map is measured once more: the
texts lag the map until they are assembled, so they are held to it only then, and the run is `synced` only when the map
and the texts have no problem.

The tool and git run on the host, in the pstack plugin's actions (`pstack.upstream.refresh`, `measure`, `record`,
`assemble`, `commit` and `state`), never in `proc.run`: a real box reads only its own directory, so it can read neither
the upstream checkout nor the repository a worktree belongs to, and the boxed author cannot run git either. Each action
works only on one of niwa's worktrees, reads the checkout through git and never writes it, and writes inside the
worktree.

By hand, the same: `refresh`, then `check`, settle what it shows, `accept` or edit the entries, `advance`, `assemble`.
The tool reads and writes the package folder it is installed in.

## What niwa does not give yet

- A script's `uses` holds call rules only, so a run cannot hold the write and network rules of a box. The author's box
  is a right of the pstack plugin.
- The git module's actions carry no target, so the entry's `git.*@{repo.local}` reaches none of them. The entry names
  the worktree actions it calls untargeted.
- A real `proc.run` box reads only its own directory, and a niwa worktree's `.git` leads into the main repository, outside
  it: git does not run in a worktree there at all (`rev-parse`, `status`, `show` and `commit` all fail as "not a git
  repository"). The lanes read git through `proc.run`, so they work only where the box is not applied; the upstream sync
  does its tool and git work on the host instead.
