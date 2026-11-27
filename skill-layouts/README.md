# Evaluating package skill layouts

How should a package split its agent skills: one skill per package, one per concept, or something in between? This
harness answers that from what coding agents do with the skills, rather than from how the framework is organised.

It gives [Kiro CLI](https://kiro.dev/docs/cli/) and [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli)
the same requests, in copies of [serenity-js-mocha-template](https://github.com/serenity-js/serenity-js-mocha-template)
with each layout of `@serenity-js/core`'s skills installed. Then it scores each run on three things: whether the agent
loaded the skill files its request needs, whether its code compiles and passes its tests, and whether the code follows
the conventions the skills teach.

## What it decided

**Layout B was chosen**: `@serenity-js/core` ships one skill, `serenity-js-screenplay`, with an overview in `SKILL.md`
and a file each for tasks, interactions and abilities, and questions, in `references/`. It ships in
[serenity-js/serenity-js#3628](https://github.com/serenity-js/serenity-js/pull/3628).

The focused round ran Kiro on layouts None, A, B and C, with requests 5, 6, 9 and 11, three times each: 12 runs per
layout. A reviewer scored the runs of requests 6, 9 and 11 blind, and the conventions score combines their verdicts
with the AST patterns'.

| Layout | Correct | Conventions | Loaded the right skills | Credits | Mean time |
|---|---|---|---|---|---|
| None | 12/12 | 77/112 (69%) | n/a | 8.59 | 32 s |
| A | 12/12 | 117/127 (92%) | 4/12 (33%) | 15.84 | 47 s |
| B | 12/12 | 112/123 (91%) | 4/12 (33%) | 15.71 | 45 s |
| C | 12/12 | 114/126 (90%) | 9/12 (75%) | 18.30 | 51 s |

Every run was correct, and every layout with skills followed the conventions more than 20 points more often than
None, so the skills help. Between A, B and C, the conventions scores are within 2 points of each other, well under
the 10 points the [decision rule](#the-decision-rule) needs for one layout to beat another. C loaded the right skills
most often, but its code was no better for it, and it cost the most credits. So the layouts tie, and the rule gives a
tie to the layout with the fewest skills: B has one, A three and C five.

The focused round ran Kiro only, so the choice waited on a Copilot run of B and C, on requests 5 and 9, three times
each. If Copilot's code with B had fallen clearly behind its code with C, the choice would have been reconsidered. It
didn't:

| Layout | Correct | Conventions | Loaded the right skills |
|---|---|---|---|
| B | 5/6 | 74/88 (84%) | 2/6 |
| C | 6/6 | 68/92 (74%) | 1/6 |

B's one incorrect run typed its questions as `Question<string>` instead of `QuestionAdapter<string>`, which `tsc`
rejected. C's lower conventions score comes from tasks that didn't wait for their own outcome, abilities that read
the environment themselves, and tasks that worked out the expected result by copying the system's logic. Copilot's
pin was `auto`, and it gave each session one model: `mai-code-2-flash` for 11 runs, and `gpt-6-luna` for one, a run
of B. Six runs per layout confirm that B doesn't fall behind with another agent and model; they don't measure the
difference.

After the decision, the skill's three detail files moved into `references/`, following the Agent Skills convention,
with their content unchanged. The regression check then ran None against B on requests 5, 6, 9 and 11, once each,
with Kiro:

| Layout | Correct | Conventions | Loaded the right skills | Credits | Mean time |
|---|---|---|---|---|---|
| None | 4/4 | 43/57 (75%) | n/a | 2.80 | 31 s |
| B | 4/4 | 56/60 (93%) | 1/4 | 5.19 | 44 s |

B's code followed the conventions 18 points more often than None's, against 22 in the focused round, and was ahead on
every request. The rounds' results aren't in this repository; [`review-guide.md`](review-guide.md) cites their runs
by ID, and `spec/fixtures/runs/` keeps the diffs of the runs the specs replay.

## How it's used now

The harness is now a **regression check of `@serenity-js/core`'s skills** against a serenity-js clone. After each
change to the skills, `--pilot` runs None against B, on requests 5, 6, 9 and 11, and shows whether the skills still
make B's code better than None's. The full comparison of the layouts isn't run. It can be reopened when the skills
grow, for example when `@serenity-js/web` or `@serenity-js/assertions` ship skills of their own, and a layout's size
makes more difference.

## What you need

- **macOS.** The harness runs `tsc` and `npm test` on the agents' code under `sandbox-exec`, so they can't write
  outside the run's directory, read your home directory, or reach any host but `localhost`. Run it from your own
  terminal: `sandbox-exec` can't start inside another sandbox, such as the one a coding agent runs its shell commands
  in, so the harness refuses to run the checks there. Elsewhere, and inside another sandbox, it only runs them given
  `--unsandboxed`, and each run's `result.json` then records `checksSandboxed: false`
- **Node.js 24** and **pnpm**, with `pnpm install` run in the repository's root
- **[Kiro CLI](https://kiro.dev/docs/cli/)**, as `kiro-cli`, with `KIRO_API_KEY` set, for Kiro's runs
- **[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli)**, as `copilot`, with
  `COPILOT_GITHUB_TOKEN` set to a token that can use Copilot, for Copilot's runs. `GH_TOKEN` doesn't do instead: the
  runs don't get it. `--agent kiro` runs without it
- **A compiled clone of [serenity-js](https://github.com/serenity-js/serenity-js)**, on the branch with the skills
  you're checking. `eval:build-layouts` builds the layouts' core skills from it, the harness packs its packages,
  and its `bin/test-skills.ts` type-checks the skills' examples
- **A clone of [serenity-js-mocha-template](https://github.com/serenity-js/serenity-js-mocha-template)** with the
  commit `config.json` pins. By default, the harness looks for it next to the serenity-js clone
- **No `~/.agents/skills`.** Copilot reads personal skills from there, whatever its home directory, so the harness
  refuses to start while it exists. Move it aside for the evaluation

## Running it

From the repository's root:

```bash
pnpm run eval:build-layouts -- --serenity-js ~/Projects/serenity-js
pnpm run eval:skill-layouts -- --check-references --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --smoke --agent kiro --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --pilot --agent kiro --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --pilot --agent copilot --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --compare --pilot --out ~/skill-layouts
```

That's the regression check: rebuild the layouts from the clone's skills, check the requests' reference solutions,
check the harness with a smoke run, run the pilot with each agent, and read the layouts side by side in `~/skill-layouts/pilot/compare.md`. The summary, with
the counts the decision rule reads, is in `~/skill-layouts/pilot/summary.md`.

*Rebuild the layouts after every change to the skills.* The runs get the core skills of `layouts/`, which replace the
skills in the clone's packed `@serenity-js/core`, so without `eval:build-layouts` the pilot checks the skills as they
were last built, not the clone's.

Other rounds:

```bash
pnpm run eval:skill-layouts -- --pilot --layouts a,c --requests 9,11 --serenity-js ~/Projects/serenity-js --out ~/skill-layouts-ac
pnpm run eval:skill-layouts -- --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --held-back b --serenity-js ~/Projects/serenity-js --out ~/skill-layouts
pnpm run eval:skill-layouts -- --rescore-checks --pilot --out ~/skill-layouts-ac
```

`--out` is required: it's where the results go, one directory per mode, such as `pilot/`, `full/` or
`held-back-<layout>/`.

## How the evaluation is designed

The requests, the checklist and the decision rule were decided before any results, and only changed afterwards to
fix the harness.

### The layouts

| Layout | `@serenity-js/core` | `@serenity-js/mocha` |
|---|---|---|
| `none` | no skills | no skills |
| `a` | three skills, one per building block: `serenity-js-writing-tasks`, `serenity-js-writing-interactions-and-abilities` and `serenity-js-writing-questions`, as [serenity-js/serenity-js#3616](https://github.com/serenity-js/serenity-js/pull/3616) had them | `serenity-js-writing-tests` |
| `b` | one skill, `serenity-js-screenplay`: an overview in `SKILL.md`, and `references/tasks.md`, `references/interactions-and-abilities.md` and `references/questions.md` | `serenity-js-writing-tests` |
| `c` | five skills: `serenity-js-screenplay-pattern` for the concepts, and one skill each for tasks, interactions, abilities and questions | `serenity-js-writing-tests` |

*The content stays the same across layouts.* B and C are built by moving #3616's sections and examples between
files, not by rewriting them; only the frontmatter, the overviews and the cross-references differ. Otherwise the
evaluation would measure the writing, not the layout. Writing tests belongs to the test runner's package, so
`serenity-js-writing-tests`, a draft of how to write a Mocha scenario with Serenity/JS, is the same in every layout
but None, apart from the names of the core skills it refers to.

### The requests

The requests are written the way a user of the template would ask, in its domain, and kept in `requests.json`. Each
one's needs are the building blocks its reference solution needs, in `fixtures/reference-solutions/<request id>/`:

| Request | Starts from | Needs |
|---|---|---|
| 1. Write a scenario for a new feature | the template | tests |
| 2. Add a step that does several things the scenarios repeat | the template | tasks, questions |
| 3. Check a value the system returns | the template | questions, tests |
| 4. Talk to an HTTP API the project doesn't use yet | the template | questions, tests |
| 5. Fix a scenario that fails because a step doesn't wait | a typical project | tasks |
| 6. Remove duplication across three scenarios | poor abstractions | tasks, questions |
| 7. Rename a concept everywhere in the tests | the template | tests |
| 8. A control: a change that needs no skill | the template | nothing |
| 9. Use an interface no Serenity/JS integration covers | a typical project | abilities, interactions, questions, tests |
| 10. Repeat the same check for each item of a list | the template | tasks, tests |
| 11. Add to code with poor abstractions | poor abstractions | tasks, tests |
| 12. Check a value, held back | the template | questions, tests |
| 13. A new feature, held back | the template | tests |

Requests 12 and 13 are held back: they're only run once a layout has been chosen, with `--held-back <layout>`, to
check it wasn't tuned to the rest.

*None of the projects demonstrates the skills' practices*, so the evaluation measures whether the skills improve code
beyond what the project shows. In an early pilot, layout None wrote the same code as layout B for request 9, because
its fixture showed what the skills teach, and None copied it. A typical project, the `calculation-jobs` and
`calculation-job-results` fixtures, is correct Serenity/JS without the skills' practices: actors named with strings,
standalone questions, and the waiting a scenario needs written in the scenario. The project with poor abstractions,
the `precision` fixture, has three scenarios that are each a list of `Send` and `Ensure` calls, and a task named
after its mechanics that strings together eight interactions.

### The runs

The full evaluation runs every main request with every layout, in both agents, 3 times: 4 × 11 × 2 × 3 = 264 runs,
33 per layout per agent. `config.json` pins each agent's model, and the harness records the agents' and models'
versions with the results. A pilot runs a few layouts and requests once, to check the harness and the cost per run
first.

### The measures

For each run, the harness records:

1. **Loading:** the skill files the agent read, from its event stream, against the table of what each request needs
2. **Correctness:** `tsc --noEmit` and `npm test` in the run's directory
3. **Conventions:** a fixed checklist, in `src/conventions.ts`, built from the skills' practices. AST patterns score
   some items, which a reviewer may overrule, and the reviewer alone scores the rest, wherever an item applies to the
   code the run added
4. **Review:** what the patterns can't decide, such as whether a task is named in the business domain. The reviewer
   scores each diff against the same checklist without seeing its layout or agent: every run has a random ID, and
   the mapping is kept apart
5. **Cost:** tokens or credits, and time

### The decision rule

- **Working code comes first.** A run is correct when `tsc --noEmit` and `npm test` both pass. A layout whose share
  of correct runs is at least 10 percentage points lower than another layout's, in either agent, can't win
- **Among the layouts left, one is better** only if its conventions score is at least 10 percentage points higher in
  both agents, and it loads the right skills at least as often
- **Otherwise it's a tie,** and the layout with fewer skills wins
- **If no layout does better than None,** on correctness or on conventions, the skills don't help as they're
  written, whatever the layout
- **With 33 runs per layout per agent, smaller differences are noise.** Every percentage is reported with the counts
  behind it, and conventions are reported for the correct runs on their own too

[How the harness applies the rule](#how-the-harness-applies-the-decision-rule) says how `src/summary.ts` reads the
cases it leaves open.

## Building the layouts

B and C move #3616's sections between files; they don't rewrite them. `spec/content.spec.ts` lists every block of
text that differs from #3616's, and fails if any other block changes. To see the blocks themselves:

```bash
node skill-layouts/src/content.ts b c
```

**Don't edit the layouts' core skills by hand: rebuild them.** `src/build-layouts.ts` builds A, B and C from a
serenity-js clone's `packages/core/skills/serenity-js-screenplay`, on #3616's branch, with its detail files under
`references/`:

```bash
pnpm run eval:build-layouts -- --serenity-js ~/Projects/serenity-js
```

It writes B as the skill is, and A and C by moving its sections between skills. A is the three skills it was made
from: each of its files with a frontmatter of its own, its links to the other files written back as references to
the other skills by name, and the tasks skill with "Where tasks fit", which `SKILL.md` has as "How the building blocks
fit together". What A and C write their own way, their frontmatter, C's overviews, the sentences of C's overview's
index and their cross-references, is kept in `build-layouts.ts`, and C's index lists every `##` section of the skills
it points to, so a new section is indexed as soon as it's built. When #3616 changes a block A or C rewrites, such as a
link, the build stops and says which. So does a section added to `references/interactions-and-abilities.md`, until
`build-layouts.ts` says which of C's two skills it goes in, a file added to the skill, until it has a place in A
and C, and a link between B's files that A has no reference for, since it would lead nowhere in A's and C's skills. `spec/build-layouts.spec.ts` rebuilds A and C from layout B, which is the skill as it is, and compares them with
what's committed byte for byte, so the inversion loses nothing, and a layout edited by hand fails it. B's own
overview, its index included, is the skill's, and `spec/content.spec.ts` checks that its index lists every section.

`serenity-js-writing-tests` is a draft. Its copies differ only in the names of the core skills they refer to; the
build leaves them as they are.

## Checking the requests, and the rounds

**Run `--check-references` before every pilot and evaluation.** It checks the requests, not the agents: every request,
held back or not, has a reference solution in `fixtures/reference-solutions/<request id>/`, and a request's needs are
the skills its reference solution needs, so a reference that doesn't work makes the loading score wrong too. For each
request, it prepares layout None, copies the request's fixture and its reference solution over a copy of the project,
starts the local API server, and runs `tsc` and `npm test`, which must pass. Then it makes the reference's expected
value wrong, and runs them again: `tsc` must still pass, and `npm test` must fail, so the reference's scenario checks
what the request asks for. It prints one line per request, ok or failed, and exits non-zero, naming the requests that
failed. Its logs go in `<out>/check-references/<request id>/`, and its working copies in
`<work>/references/<request id>/`.

The expected value is marked in the reference solution, at the end of its line, with what makes it wrong:

```typescript
Ensure.that(ResultFile(jobFile), equals('7')),    // wrong: '7' => '8'
```

Each reference has exactly one marker, and the check refuses one whose value isn't on the marker's line, so a stale
marker can't make the check pass. The control, request 8, changes the README, and has no expected value, so it's only
checked to pass. A reference that needs the local API server's URLs, as request 4's does, names them with the
prompts' placeholders, `{{frankfurter}}` and `{{mathjs}}`, which the check fills in. It runs `tsc` and `npm test` as
the evaluation does, under `sandbox-exec`, so it refuses to check anything inside another sandbox, or without
`sandbox-exec`, unless it's given `--unsandboxed`.

`--pilot` runs the regression check of the skills' content: layouts None and B once each, with requests 5, 6, 9 and
11, in both agents, 16 runs. Requests 5 and 9 start from typical projects, and 6 and 11 from the one with poor
abstractions, so it shows whether a change to the skills still makes B's code better than None's. Run it after each
change to the skills. It can run one agent at a time, Kiro first and Copilot later, in the same `--out`.

`--layouts <list>` and `--requests <list>` give a pilot other layouts, and other main requests by number, such as
`--layouts b,c --requests 5,9`; without them, it's None and B with requests 5, 6, 9 and 11. A pilot of other layouts
or requests is a different plan, so it goes in an `--out` of its own: the harness refuses to resume an `--out` whose
`mapping.json` was planned with others, and says which. `--repeats <n>` runs each of a pilot's runs `n` times, once by
default, such as `--agent copilot --layouts b,c --requests 5,9 --repeats 3`, to see whether a difference holds; it's a
different plan too.

### The smoke run

Run `--smoke` for an agent before its first pilot. It checks the harness, not the agent: one run per agent being
tested, which `--agent` narrows, in layout B, with a request of its own, kept in `src/smoke.ts` rather than
`requests.json`, so the evaluation's conditions don't change. The request asks the agent to load the
`serenity-js-writing-tests` skill, read `serenity-js-screenplay/references/tasks.md` with its file-reading tool, not a shell
command, run `cat .mocharc.yml`, which is a shell read, run `curl` against the math.js API URL in the test script, add
a scenario that checks that 1 + 1 equals 2, and run the tests. Its results go in `<out>/smoke/`, apart from pilots
and evaluations, with conditions of their own; each smoke run starts afresh. Afterwards, it prints one line per check, ok
or failed:

- the parser recognised the stream, with at least one completed tool call
- it found the skill load of `serenity-js-writing-tests/SKILL.md`, via the skill tool
- it found the read of `serenity-js-screenplay/references/tasks.md`, via a file-reading tool, and the shell command. When the
  agent read the file with a shell command instead, the check says so, since the harness saw the read
- a model answered, with at least one `assistant.usage` or `assistant.message` event for Copilot, and every model the
  stream names is the pin, unless the pin is `auto`
- the usage was recorded: credits for Kiro, premium requests for Copilot
- `tsc` and `npm test` ran under `sandbox-exec`, and left their logs
- `result.json` and the review packet exist, and the packet names no skill and no skill path
- the agent's environment held only its own credential; `result.json` records the names of its variables, not
  their values, as `agentEnvironment`
- the agent ran `curl`, and the local API server logged its request, so the server is reachable from the agent's
  sandbox
- the local API server logged requests from the harness's `npm test` too, so the harness's checks used it. The
  harness's probes send an `x-skill-layouts-probe` header, and the server logs which requests had it, so a probe,
  which reaches the server from outside the checks' sandbox, doesn't count as a request of `npm test`'s.
  `result.json` records both counts as `serverRequests`

It exits non-zero, naming the failed checks, if any failed. It tells a run where the agent ignored the prompt, such
as "the agent didn't load the skill", apart from a failure of the harness, such as "the parser found no tool calls".

## Calibrating the judge

The reviewer's packets are to be replaced by a judge: an agent, in a session of its own, that scores each run's change
against the checklist. The judge's verdicts don't count anywhere until they've been compared with the reviewer's, item
by item, on the rounds the reviewer scored. `--calibrate` makes that comparison. Nothing else uses the judge yet.

```bash
pnpm run eval:skill-layouts -- --calibrate --rounds ~/rounds/focus/pilot,~/rounds/copilot-check/pilot,~/rounds/regression/pilot \
    --template ~/Projects/serenity-js-mocha-template --out ~/skill-layouts-calibration
```

`--rounds` takes the results of rounds the reviewer scored: each a mode's directory, with its `mapping.json`,
`conditions.json`, `review/scores.json` and `runs/`. The round's name is its directory's, or its parent's for a mode,
such as `focus` for `focus/pilot`. `--template` is a clone of the template with the rounds' commits. The judge is the
agent and model `config.json` pins in `judge`, Kiro with `claude-sonnet-5.5`, so it needs `KIRO_API_KEY`.

### What the judge is given

For every run the reviewer scored at least one item of, the judge's directory holds what the reviewer's packet had,
and the project:

- `request.md`, the request, with the round's local API server's URLs filled in
- `change.diff` and `reply.md`, the run's diff and its reply, with the skills' names and paths hidden, as in the packets
- `before/` and `after/`, the project as the run found it and left it. That's the template at the round's commit, with
  the newest version of the request's fixture, in the harness's history, that the run's diff applies to
- `rules/<item>/README.md` for every item of the checklist: its text, then the sections of `review-guide.md` that name
  it. `rules.md` lists the items the request exercises first
- `reference/`, the request's reference solution, without the marker of its expected value

The judge's directory has a random name, and the guide's run IDs are renamed `run R1`, `run R2` and so on, so the
judge can't tell which run it's judging. It's told to write `verdicts.json`: a verdict, evidence and a reason for every
item. When that can't be used, a second session is told what was wrong with it. A stream that reports a model other
than the pin stops the calibration, as it stops an evaluation.

A run whose diff applies to no version of its fixture is judged from the request, the diff and the reply alone, as the
reviewer's packet had it, and the report lists it. That's 11 of the focus round's request 9 runs, made before
`CalculationJobs` moved to `system-under-test/`: the harness's history starts after the move.

### The protocol

It was decided before the judge scored anything:

- **Three sessions per run.** Their majority is compared with the reviewer's verdict. A majority is more than half of
  the three sessions, so a run where only one session left a verdict isn't decided by it. Without a majority, the
  result is a split, when every session gave a verdict, or incomplete, when some didn't. Both count as disagreements.
  How often the sessions agree with each other is the judge's noise
- **Held out.** `review-guide.md` cites runs of the very rounds being judged. A verdict is held out when the guide
  doesn't cite its run under a section that names its item. Agreement is reported on every verdict, and on the
  held-out ones, which are what the decisions use
- **The prompt is frozen before the regression round is judged.** If the prompt needs to change, it's tuned on the
  focus and copilot-check rounds only, and the regression round is judged once, afterwards. Each session records a
  hash of the judge, its agent, model and version, of its prompt and of its inputs, and a rerun reuses only the
  sessions whose hash still matches. So a report never mixes two prompts, and never reports one judge's verdicts under
  another's name
- **An item is calibrated when** the judge agrees with at least 85% of at least 10 held-out verdicts, and, where the
  reviewer failed the item in at least 3 held-out verdicts, the judge fails at least two thirds of those runs too.
  The fails the guide cites don't count towards the decision, since the judge's rules describe them, but the report
  counts the fails it caught in every run too
- **An item the reviewer failed in fewer than 3 held-out verdicts** is "calibrated against false alarms only": a
  judge that always says pass would agree with every verdict. Its verdicts don't count until the judge also gets the item's examples
  right, once the items have pass and fail examples of their own
- **An item with fewer than 10 held-out verdicts** isn't calibrated: `timeout` has 7, and the reviewer scored none of
  the pattern items but `answerable-parameters`

The report goes in `<out>/calibration/calibration.md`, with everything it's made from in `calibration.json`:

- per item: the reviewer's verdicts, the agreement on every verdict and on the held-out ones, the reviewer's fails the
  judge caught, in every run and in the held-out ones, how often the sessions were unanimous, and the decision, with
  its reason
- per round, the agreement
- where the judge differs: the reviewer's pass and the judge's fail, the other way round, n/a on either side, splits,
  and sessions without verdicts
- every disagreement, with each session's verdict and reason, for the reviewer to read
- the sessions, their retries and the credits they used

Each session's stream, log, `session.json` and `verdicts.json` are in `<out>/calibration/sessions/<round>/<run>/<n>/`.
A stopped calibration resumes from them. Every session gets a fresh `KIRO_HOME`. They share one `HOME`, in
`<work>/homes/judge/`, so Kiro unpacks its runtime once, rather than about 300 MB per session.

### What it costs

The three recorded rounds have 56 reviewed runs, with 470 verdicts, of which 412 are held out, so a calibration is 168
sessions, plus any retries. Each session reads up to 26 rules and a diff and writes one file. The agents' runs of the
focus round took 0.7 to 1.3 credits and 30 to 50 seconds each. A judge's session does less, so expect roughly 0.5 to
1.5 credits each, 85 to 250 credits in all, and a few hours, since the sessions run one at a time.
`calibration.md` reports what they actually used.

## Options

Run the evaluation from your own terminal, not from inside a sandbox: the harness runs `tsc` and `npm test` under
`sandbox-exec`, which can't start inside another sandbox, so it refuses to start the runs there.

- `--unsandboxed` runs `tsc` and `npm test` without a sandbox where `sandbox-exec` isn't available: on another
  system than macOS, or inside another sandbox. They then run the agents' code with your user's access to your files
  and the network, and each run's `result.json` records `checksSandboxed: false`. Where `sandbox-exec` can start, the
  checks run under it, with or without `--unsandboxed`. It goes with the runs, `--rescore` and `--check-references`

- `--serenity-js` is a compiled clone of `serenity-js/serenity-js`, on the branch with the skills; its `bin/test-skills.ts`
  type-checks the layouts' examples
- `--template` is a clone of `serenity-js-mocha-template`; by default, the one next to the `serenity-js` clone
- `--out`, which is required, is where the results go, one directory per mode: `pilot/`, `full/`, `smoke/` or
  `held-back-<layout>/`
- `--work` is where the tarballs, the layouts' projects and the runs' working copies go. By default, a directory in the
  system's temporary directory, outside any repository, so the agents find no other project's configuration
- `--agent <kiro|copilot>` runs, or rescores, only that agent's runs; without it, every agent's. `fixtures.json` lists
  every agent that has run in the `--out`, with the model and version `conditions.json` recorded for it. The plan in
  `mapping.json` stays the mode's whole plan, so the runs keep their IDs whichever agent runs first. The harness checks
  the pins, credentials, versions and sandboxes of the agents being run only, so a Kiro-only pilot starts without
  Copilot CLI installed, and without `COPILOT_GITHUB_TOKEN`. With `--agent`, the summary, and `compare.md`, cover that
  agent's planned runs only, and say so: a round run with `--agent kiro` leaves Copilot's planned runs without results
  for good, so the decision doesn't wait for them. Without `--agent`, they cover every agent's runs, say so, and the
  decision waits for all of them
- `--calibrate --rounds <dir>,<dir>` judges the runs the reviewer scored in those rounds, and compares the judge's
  verdicts with theirs, in `<out>/calibration/`: see [Calibrating the judge](#calibrating-the-judge). It takes
  `--template`, `--out` and `--work`, and no mode, agent or other action
- `--prepare-only` builds and checks everything up to the runs
- `--summarise` only reads the results, and writes `summary.md` and `summary.json`. It never changes a run's
  `result.json`, so it's safe anywhere, including inside a sandbox. It honours `--agent`, as do the summaries
  written after a round, `--reparse`, `--rescore` and `--rescore-checks`, and `summary.json` then names the agent
- `--compare` only reads the results too, and writes `compare.md`: a section per request, with each layout's runs,
  how many were correct, and how often each checklist item the request exercises passed, the reviewer's verdicts over
  the patterns', leaving out the network failures and the agent failures, which it counts separately; the models
  each layout's runs used, with how many runs used each; in a table of their own, the other
  items a run's code applied to; which skill files each layout's runs loaded, and in how many of its runs; and one
  run's diff per layout, side by side, with the agent's reply. It reads a pilot's results before there are enough of
  them for the decision rule, and honours `--agent`
- `--reparse` parses each saved `stream.jsonl` again, and rewrites what comes from it in `result.json`: the skill
  reads and the loading, the model, tokens, credits and cost. It keeps the outcome, the checks and the logs, and runs
  no agent and no check, so it's safe inside a sandbox. It honours `--agent`. A stream that reports a model other
  than the pin rewrites nothing, and says which. Use it after a change to a parser, as after the pilot's first half
- `--rescore-checks` computes each run's checks again, with the patterns as they are, from its saved `diff.patch` and
  its working copy, and rewrites them in `result.json`, keeping the rest. Where `--work` no longer has a run's working
  copy, it rebuilds one, from `--template` at the commit `conditions.json` recorded, the request's fixture and the
  TypeScript files of the diff, and removes it again. It prints what changed in each run, such as
  `answerable-parameters: n/a → fail`, gives `review/scores.json` a blank for every item the reviewer hasn't got yet,
  keeping their verdicts, writes the review packets again, and summarises. It runs no agent and no check, so it's safe
  inside a sandbox, and honours `--agent`. A diff that doesn't apply rescores nothing, and says which. Use it after a
  change to the checklist or the patterns. It rebuilds from the fixtures as they are now, so a run made before its
  fixture changed only applies in a checkout of the commit it was made with: the focused round's request 9 runs, for
  example, were made before `CalculationJobs` moved to `system-under-test/`
- `--rescore` scores the network failures again, as an evaluation does at the end of its runs, then summarises. It
  reruns `tsc` and `npm test` in the runs' directories in `--work`, so it first checks that `sandbox-exec` can start,
  and, unless it's given `--unsandboxed`, refuses to rescore anything otherwise, leaving every `result.json` as it was.
  A rescored run's `checksSandboxed` says whether the rescore's checks ran under `sandbox-exec`. It also refuses when `config.json`
  sets another port for the local API server than `conditions.json` recorded, since the runs' code calls that port,
  and refuses results whose `conditions.json` records no port, which come from before the local server: their runs'
  code calls the public APIs, so a rescore with the local server would still score the public APIs' latency. Inside
  a sandbox, it refuses, so it's safe there too

`config.json` pins the judge, in `judge`, to Kiro with `claude-sonnet-5.5`. It pins Kiro to `claude-sonnet-5.5`. Copilot's pin is `auto`, since the Copilot plan the evaluation ran
on only offers Copilot Fusion, which has no model ID of its own. Where a pin is a model, every model a stream reports has to match it, or the
evaluation stops. With `auto`, the agent picks the model, and may pick another for layout C than for layout B, so
`result.json` records every model each run used, in `models`, and the summary and `compare.md` break the results down
by them, so that a reader can tell whether the layouts got the same mix. For Copilot, the models are those of the
`model.call_start` events, one per model call, which Copilot 1.0.114 sends. It sends no `assistant.usage` events, which
the Copilot SDK documents as naming the model that served each call, so those are the fallback for a stream that has
them. `session.start`'s `selectedModel` is only what the harness asked for, so it isn't used. With `auto`, Copilot
also sends a `session.auto_mode_resolved`, which `result.json` records as `autoMode`: the `chosenModel`, and the
`availableModels` of the plan. `compare.md` shows the available models per layout, so a reader can see when Copilot
Fusion had more than one model to choose from. The
harness records the agents' versions in `fixtures.json`, and each run's in its `result.json`: the version the stream
reports, as Copilot's does, or else what the agent's `--version` printed, as for Kiro, whose stream reports none.

`config.json` also pins the commit of `serenity-js-mocha-template` the projects are made from, and sets the port of
the local API server, `apiServer.port`. The template clone has to
have that commit; for a pull request that isn't merged yet, `git fetch origin pull/<number>/head` gets it.

## The agents' configuration and credentials

Each run gets a `KIRO_HOME`, a `COPILOT_HOME` and a `HOME` of its own, created empty in `<work>/homes/<id>/`, so your
configuration, agents, MCP servers, steering, skills and dotfiles, such as `~/.npmrc`, `~/.gitconfig` and `gh`'s
login, don't reach the runs, and `COPILOT_AUTO_UPDATE=false`, so Copilot doesn't update itself in the middle of an
evaluation. Without your login, the agents authenticate from the environment:

- **Kiro** needs `KIRO_API_KEY`, as for any headless run
- **Copilot** needs `COPILOT_GITHUB_TOKEN`, with a token that can use Copilot. The runs don't get `GH_TOKEN`, even
  when it's set: `gh`, in the agent's shell commands, would use it too

The harness refuses to start the runs without them, and while `~/.agents/skills` exists: Copilot reads personal
skills from there, whatever `COPILOT_HOME` says. Move it aside for the evaluation.

Each agent writes to its run's `HOME` as it starts: Kiro unpacks its runtime into
`Library/Application Support/kiro-cli/`, about 300 MB, and Copilot its package into `Library/Caches/copilot/`, about
250 MB, with device IDs in `Library/Application Support/Microsoft/` and `.local/state/gh/`. The homes stay in `<work>`
after the runs, so a pilot's take a few GB. npm writes nothing there: `npm_config_cache` points it at `<work>/npm-cache/`,
which every run shares, so each run doesn't download every package again. npm keeps its logs there too, in `_logs/`.

The harness's own `tsc` and `npm test` don't get the run's homes or the shared cache: they run with your `HOME` and
npm's default cache, `~/.npm`, under a sandbox that can't read anything in `HOME` but `~/.npm`, the Node.js
installation and the run's directory, or reach any host but `localhost` (see [What it does](#what-it-does)).

Neither agent gets your environment. Each run's environment has only `PATH`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`
and `SHELL`, the run's `HOME` and other homes, `COPILOT_AUTO_UPDATE`, `npm_config_cache`, `NO_PROXY` and `no_proxy`,
set to `127.0.0.1,localhost` so the local API server is reached directly, `JOBS_DIR` and `RESULTS_DIR`, and that
agent's credential: `KIRO_API_KEY` for Kiro, and `COPILOT_GITHUB_TOKEN` for Copilot. So Kiro doesn't see Copilot's
token, Copilot doesn't see Kiro's key, and neither sees `GH_TOKEN` or anything else you've exported, such as cloud
credentials.

`JOBS_DIR` and `RESULTS_DIR` are `jobs/` and `job-results/` in the run's directory, where request 9's calculation jobs
pick up job files and write their results. Every run gets them, and so do the harness's `tsc` and `npm test`, so every
run's environment is the same. They're left out of the agent's diff, and the harness empties both before its own `tsc`
and `npm test`, so files the agent's test runs left can't make a scenario pass.

Both agents run every tool without asking, with their shell commands in their OS sandbox:

- **Kiro**: `kiro-cli chat --v3 --no-interactive --sandbox --trust-all-tools --output-format stream-json --model <id>`.
  The Kiro home turns on the sandbox, with `COMMON_DEPENDENCIES` for `npm install`, and a `sandbox_network` rule in
  `settings/permissions.yaml` that allows `127.0.0.1` and `localhost`, for the local API server
- **Copilot**: `copilot -p <prompt> --output-format json --model <id> --no-ask-user --allow-all-tools
  --allow-url=127.0.0.1,localhost --sandbox --disable-builtin-mcps`. The Copilot home's
  `settings.json` turns on the sandbox with `allowBypass: false`, so a blocked command stays blocked, without git or
  gh credentials in it, with `allowLocalNetwork`, and with `sandbox.userPolicy.network.allowedHosts` set to
  `127.0.0.1`, `localhost` and `registry.npmjs.org`. Once that list has an entry, every other host is blocked, so it's
  narrower than Kiro's `COMMON_DEPENDENCIES`, which also reaches other package and source services. The built-in MCP servers, such as
  GitHub's, are off, since Kiro's runs have none

Neither sandbox allows `api.mathjs.org` or `api.frankfurter.dev`: the runs only reach the local API server.

## The local API server

The template's scenarios call the math.js API, and request 4 asks for a scenario that calls the Frankfurter API. In
the second pilot, `api.mathjs.org` was slow enough that the template's own scenarios hit Mocha's 5 second timeout, so
both runs of request 4 were scored incorrect, though the agents' code passed. So the runs call a local stand-in
instead, `server/server.ts`, a plain Node.js HTTP server on `127.0.0.1`:

- **The math.js API v4**: `GET /v4/?expr=&precision=` answers with the result, or status 400 and the error, as
  `text/html`; `POST /v4` with `{ expr, precision }` answers with `{ result, error }` as JSON. It evaluates the
  expressions with the `mathjs` package, pinned in `package.json`, and says `Error: ` and math.js's message for any
  error, so its answers match `api.mathjs.org`'s, with its status codes and content types. `compare.ts`, below,
  checks that they do
- **The Frankfurter API v1**: `GET /v1/latest?base=&symbols=` answers in Frankfurter's format, with fixed rates and
  a fixed date, so the scenarios' results don't change between runs

A `POST /v4` without `expr` gets a 400 and `api.mathjs.org`'s error, as `text/html`, with a hint about the content
type for an empty object or list only. One that isn't a JSON object or list sent as `application/json` gets a 400 and
the error page of `api.mathjs.org`'s Express app. An error in a handler gets a 500, so one request can't stop the
server for the rest of the run.

Each run gets a server of its own, from before the agent starts until the harness's `tsc` and `npm test` are done. It
runs in a process of its own, since the harness's checks block the harness's own event loop. It logs every request to
the run's `server.jsonl`; `--rescore` starts another, logging to `server.rescored.jsonl`.

*Every server of an evaluation listens on the same port*, `apiServer.port` in `config.json`, 4170 by default, which
`conditions.json` records with the shared conditions. So every run gets the same prompts, and a rescore's server
answers the URLs the run's code calls, including the Frankfurter URL from request 4's prompt. When something else
listens on that port, the evaluation refuses to start, before it prepares anything, and says which port it is.

So *the runs' projects differ from the template only in the test script's URL*: `startRun` rewrites
`BASE_API_URL=http://api.mathjs.org/v4/` in `package.json` to `BASE_API_URL=http://127.0.0.1:<port>/v4/`, and commits
it before the agent starts, so it isn't in the agent's diff. Request 4's prompt names the server's Frankfurter URL
through a placeholder, `{{frankfurter}}`, which the harness fills in, so `requests.json` doesn't name the port.

To check the server's answers against the public APIs, run this from your own terminal, where they're reachable:

```bash
node skill-layouts/server/compare.ts
```

It compares the status, content type and body of the requests the template's scenarios and the evaluation's requests
make, and of their errors.

## What it does

1. **Packs** every `@serenity-js/*` package the template depends on, with `npm pack`, so the template uses one build
2. **Swaps each layout's skills** into the `core` and `mocha` tarballs, in a directory with an opaque name, so a
   diff of `package.json` doesn't give the layout away
3. **Installs them** into a copy of the template, with `file:` dependencies and `overrides`, because `npm pack` leaves
   the packages' dependencies on each other as `workspace:*`. The first time a layout is prepared for an `--out`,
   `npm install` resolves the dependencies, and the harness saves npm's lockfile in the results, as
   `layouts/<layout>/package-lock.json`; after that, it copies the saved lockfile in and runs `npm ci`, so a resume,
   such as the second agent's half of the pilot, gets the same third-party versions. The layouts' tarballs are
   repacked with `npm pack`, which writes the same bytes for the same files, so the lockfile's integrity hashes still
   match. Then `npx skills experimental_sync -y -a kiro-cli github-copilot`,
   after creating `.kiro/`, without which `npx skills` doesn't link into `.kiro/skills`. For Copilot, whose ID in
   `npx skills` is `github-copilot`, it links into `.agents/skills`, one of the project skill directories Copilot
   reads, with `.github/skills` and `.claude/skills`
4. **Checks** that `node_modules` holds one copy of `@serenity-js/core`, installed from its tarball; that `.kiro/skills`
   and `.agents/skills` link exactly the layout's skills, with the layout's files; and that every `typescript`
   example in the layout's skills compiles, with `bin/test-skills.ts`, in a throwaway copy of the project
5. **Runs** each request in its own copy of the project, committed first, so the agent's changes are a diff. Each run
   gets a local API server of its own, and the copy's test script points at it. Requests about existing code copy a
   fixture from `fixtures/` over the project first: `calculation-jobs` for request 5, `calculation-job-results` for
   request 9, and `precision` for requests 6 and 11. None of them demonstrates the skills' practices, so the evaluation
   measures whether the skills improve code beyond what the project shows. The calculation job fixtures are a typical
   project: correct Serenity/JS, written as the template is, with actors named with strings, standalone questions such
   as `StatusOfLastJob()`, and the waiting a scenario needs in the scenario. The service they test, `CalculationJobs`,
   is in `system-under-test/`, with a header that says it's the system under test and isn't to be changed, so that a
   run that changes it to suit its tests is plainly doing so. The precision fixture has poor
   abstractions: three scenarios, each a list of `Send` and `Ensure` calls, and a `PostAndCheck` task that strings
   together eight interactions. The other requests start from the template as it ships. `fixtures/reference-solutions/` holds a reference solution of every
   request, which `--check-references` checks; it's never copied into a run. *A request's needs in `requests.json`
   are the skills an answer needs, read from its reference solution, and nothing more*, since the loading score marks
   down a run that doesn't read about a building block its request needs:
   - building blocks an integration provides, such as `Send`, `LastResponse` or `CallAnApi`, don't count; writing one
     of your own does, and so does transforming a question, with `.as()` or the fields of its answer
   - code an answer only moves needs no skill: request 11's scenario checks its result as the file's other scenarios
     read theirs
   - `tests` means writing a new scenario, or changing how one is set up, checked or reported; changing a scenario
     only to call a new task doesn't count

   So request 5 needs only `tasks`: its fix waits in the task, with the fixture's question, and leaves the scenario
   as it is. Request 10 needs `tasks` and `tests`: its new scenario repeats its check for each expression with
   `List.of(…).forEach`, which the tasks skill covers. Request 6 needs `tasks` and `questions`: its reference refactors
   the precision fixture as the tasks skill's "Refactor what's there" describes, with a task, and a grouped object for
   the values read in several places. Request 11 needs `tasks` and `tests`: its reference adds the scenario with a new
   task, and lists what it doesn't refactor as suggestions, in a comment block. The reference solutions stay
   exemplary, since they're never copied into a run. They follow the project's actor names where they change a
   scenario of its own, and the six that add a spec with a shared `Role` enum, 1, 4, 9, 10, 12 and 13, move the
   project's specs to it too, so that the project names its actors one way. The agent starts a process group of
   its own; when it runs out of time (`runTimeoutMinutes`), the harness stops the whole group, records the run as
   timed out, and scores what it left: a stream cut off before its final record is scored as far as it goes, while
   one in a format the parser doesn't recognise still stops the evaluation. The summary counts the timeouts.
   Scoring starts once the agent has exited and its output is written to `stream.jsonl` and `agent.log`. A process
   that left the group, and keeps the output open, gets 10 seconds after SIGKILL; then the harness closes the output
   and goes on
6. **Scores** each run: `npx tsc --noEmit` and `npm test`; the skill files it read, from its event stream, against the
   table in `requests.json`; the conventions checklist in the lines it added, with AST patterns, which also read the
   project's TypeScript files before and after the run, for what the project already does; tokens, time and cost.
   - **The model** each stream reports has to be the one `config.json` pins: another model stops the evaluation, and
     names both. A stream that reports none is scored, flagged with `modelUnreported` in `result.json`, and counted
     in the summary
   - **`tsc` and `npm test` run sandboxed and without credentials**: under `sandbox-exec` on macOS, with the agents'
     `PATH`, `USER`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `SHELL`, `NO_PROXY`, `JOBS_DIR` and `RESULTS_DIR`, but none of
     the run's homes: their `HOME` is yours, and npm's cache its default, `~/.npm`. They run the code the agent wrote, so they shouldn't be able to
     change anything else, read your files, or use your tokens. Where `sandbox-exec` isn't available, they only run
     given `--unsandboxed`, and `result.json` records `checksSandboxed: false`. The sandbox:
     - allows writes only in the run's directory and `TMPDIR`, and to the null and terminal devices
     - denies reads in `HOME`, apart from the run's directory and `TMPDIR`, when they're in it, the checks' npm
       cache, `~/.npm`, and the Node.js installation the harness runs on, the prefix of
       `process.execPath`, which is in `HOME` with nvm. A path's metadata can still be read, so a command is still
       found on a `PATH` with directories in `HOME`, such as `~/.local/bin`, but a file's contents and a directory's
       listing can't. The `npm` and `npx` on your `PATH` have to be outside `HOME`, or that installation's: a
       version manager whose shims are in `HOME` outside it, such as Volta, keeps them from starting
     - denies the network, apart from `localhost` and `127.0.0.1`, for the local API server and any server a
       scenario starts, and the system's DNS resolver, so that `localhost` resolves. Other hosts' names resolve too,
       but can't be reached
   - **The local API server not answering is the harness's failure**: when `npm test` fails, the harness probes the
     APIs the run's request needs on the run's local API server, as its `apis` in `requests.json` say: `mathjs` for
     every request, and `frankfurter` for request 4. When one doesn't answer, the server failed, not the run's code,
     so the evaluation stops, with the server's output and its last requests, and saves no `result.json` for the run.
     A rerun resumes from that run. Otherwise, the failure is scored as usual, so a URL the agent got wrong, or a
     scenario that fails for a reason of its own, counts as incorrect. So new runs aren't network failures; results
     made with the public APIs can be, and the summary still counts them and leaves them out of the correctness rate.
     `--rescore`, and the end of an evaluation, rerun `tsc` and `npm test` for network failures, with the local
     server on the evaluation's port, writing `tsc.rescored.log` and `test.rescored.log` next to the run's own logs,
     which stay as the run made them
   - **An agent that errored, or made no tool calls**, leaves the template as it was, which compiles and passes its
     tests, so tsc and npm test would score the run as correct. Its outcome is `agent-failure`, with the reason in
     `agentFailure`: the agent exited with an error, and the timeout didn't stop it, or no tool call completed. The
     summary and `compare.md` count these apart, and leave them out of the correctness rate, as they do the network
     failures. A `session.error` in Copilot's stream stops the evaluation instead, like a stream the parser doesn't
     recognise, since it points at the setup, such as a model that isn't available
   - **A command that couldn't start**, because it wasn't found, or `sandbox-exec` refused to start it, says nothing
     about the run's code. So instead of scoring the run as incorrect, it stops the evaluation, or the rescore, with
     the reason, and saves no `result.json` for the run. A check that `testTimeoutMinutes` stopped did run, so it
     counts as a failure, with a log that says it timed out
7. **Writes a review packet** per run, in `review/<id>.md`: the request, the checklist, the diff, and the agent's
   final reply, what it said after its last tool call, with the names and paths of skills hidden. The reply is where
   an agent reports what it did and suggests what it didn't change, which `suggested-the-rest` scores; scoring saves
   it as the run's `reply.md`. The reviewer fills in `review/scores.json`. Their verdict replaces the AST patterns'
   for every item they score, since they see what the patterns can't, and the summary reports how often the two
   disagree. The checklist, in `src/conventions.ts`, is built from the skills' practices, 1 to 9 in #3616's core
   skills and M1 to M7 in the Mocha draft, and each item says which practice it comes from, who scores it, and which
   requests exercise it. Every item that applies to the code a run added is
   scored, whatever its request: the requests only group the items, in the packet, which lists those its request
   exercises first, and in `--compare`. An item is n/a when the patterns find nothing it applies to, and the
   reviewer's until they score it. The packet links to `review-guide.md`, which has a rule for each decision made so
   far, with the run it was made on. The patterns score twelve items, and the reviewer alone fourteen, such as
   `structure`, `no-copied-abstractions`, `suggested-the-rest`, `no-console-log` and `no-debugging-left`: the patterns
   leave those n/a, the packet marks them "reviewer only", and they don't count as disagreements. `mapping.json`, outside `review/`, says which
   layout, agent and request each ID is
8. **Summarises** the results and applies the decision rule, in `summary.md` and `summary.json`. Until every run in
   `mapping.json` has a result, the summary has no decision, and says how many runs are missing. It has none either
   while every run of a layout with an agent is a network failure: an empty sample isn't a correctness of 0%. Nor
   does it decide on fewer runs per layout per agent than the decision rule was written for, the full evaluation's
   33, `RUNS_PER_LAYOUT_FOR_A_DECISION` in `src/summary.ts`: a complete pilot gets the counts and percentages, and
   "Too small to decide", with the runs it has and the 33 the rule needs, in `summary.md` and in `compare.md`

A stopped evaluation resumes: runs with a `result.json` are skipped, and `mapping.json` keeps their IDs. The
harness records the conditions in `conditions.json`: the shared ones before the first run, which are the template's
and serenity-js's commits, and hashes of `requests.json`, of each layout's skills, of each fixture the plan's requests start from, and of each
layout's saved lockfile, recorded once the lockfile is saved; and each agent's model and
version, when that agent's first run starts. A resume checks the shared conditions, and the conditions of every agent
that already has runs, and refuses to go on when any changed, saying which, so the summary never mixes runs from
different experiments. An agent without runs has no recorded conditions yet, so its pin can still change before its
first run. `--summarise` reports the runs that are done, and withholds the decision while any planned run, of either
agent, has no result.

### Loading a skill

A run has loaded the right skills when it read every file that `src/layouts.ts` says holds a building block the
request needs, or, for the control, no skill file at all. Reading a file counts whichever way the agent does it: with
a file-reading tool (Kiro's `read_file`, Copilot's `view`), with a shell command that prints its contents (`cat`,
`head`, `tail`, `less`, `more`, `bat` or `sed -n`), or, for a `SKILL.md`, with the agent's skill tool (Kiro's
`disclose_context`, Copilot's `skill`). Listing or testing a file, with `ls`, `find` or `test -f`, doesn't count,
and neither does a call that failed or was denied: a read counts only when the tool call has a result that isn't an
error.

### The patterns' checks

The AST patterns judge only the lines a run added or changed, and an item passes when they find it done right,
fails when they find it done wrong, and is n/a when they find neither:

- **`actor-names`**: `actorCalled` with an enum member or a constant passes; with a string or a template string
  written in the call, it fails, unless the project already named its actors with strings, before the run, or on
  lines of the file the run didn't change: a scenario that follows such a project's way, as practice 8 asks, is n/a
- **`answerable-parameters`**: the parameters of a function that returns a task, an interaction or a question pass
  when their type is `Answerable<…>`, and fail otherwise. A function returns one when its declared return type is
  `Task`, `Interaction`, `Activity`, `Question`, `QuestionAdapter` or a meta-question, or when it returns a call to
  `Task.where`, `Interaction.where` or `Question.about`, or a question transformed with `.as()` or `.describedAs()`.
  The constructor of a class with such a method or field, an interaction object, counts too. A parameter without a
  declared type is left out. An `Answerable` parameter fails too where the function places it in an array or an object
  literal that it passes on as data, as in `.with({ expr: [ expression ], precision })`, since `actor.answer()` only
  answers a question at the top level; given to `Question.fromObject`, `Question.fromArray` or `actor.answer()`, it
  passes
- **`clients-through-abilities`**: in the callback of `Interaction.where` or `Question.about`, retrieving an ability
  with `as` passes, and `fetch`, or an imported `fs`, `axios`, `http` or `https`, fails. An ability that wraps them is
  left alone
- **`answering`**: in the callback of `Interaction.where` or `Question.about`, `const x = await actor.answer(…)`
  passes; an answer used straight away, or followed by `then`, fails
- **`names-without-the`**: the names a task, an interaction or a question is assigned to, as a constant, a field or
  an object's property, pass without "The" as a word of the name, as in `CallTheBank` or `TheResult`, and fail with it.
  A name with "the" added to a file whose names already have it, on lines the run didn't change, follows the file's
  naming style, so it's n/a. That includes questions made by transforming another, with `.as()` or `.describedAs()`, such as
  `SumOfResults = () => LastResponse.body().result.as(…)`
- **`repeating`**: `List.of(…).forEach` passes; any other `forEach` with an `async` callback fails
- **`awaiting`**: an `attemptsTo` that's awaited, returned, or the body of an arrow function passes; one whose
  promise nobody waits for fails
- **`waiting`**: `Wait.until` and `Wait.upTo(…).until` pass. `Wait.for` fails anywhere, and `setTimeout` in an
  activity, or in a Mocha `it` or `describe`, with its hooks: an ability, or the system under test, may use
  `setTimeout` for its own reasons
- **`checks`**: `Ensure.that` and `Ensure.eventually` pass; a `Wait.until` that the very next activity of the same
  list follows with an `Ensure.that` fails, since `Ensure.eventually` does both. A wait in a task, checked in the
  scenario that performs it, passes
- **`expectations`**: `Ensure.that` and `Ensure.eventually` pass; answering a question in a scenario, outside an
  activity, fails
- **`no-clients-or-other-assertions`**: abilities wrap clients, so `fetch`, an imported HTTP client such as `axios`,
  or the file system, `fs` and `fs/promises`, fail in the body of an `it` or a `describe`, with its hooks, outside
  the interactions and questions that `clients-through-abilities` checks, so that one client fails one item.
  Elsewhere, such as in an ability or in a `Cast` that gives an actor `CallAnApi.using(axios.create({ baseURL }))`,
  they don't. `expect` and `assert` fail anywhere, and so does `abilityTo`. Defining an ability, giving one to an
  actor with `whoCan`, retrieving one with `as`, and checking with `Ensure`, pass
- **`consistent-actor-names`**: each `actorCalled` names its actor one way: with a string written in place, or from
  the enum or constant it names, by where that comes from, such as `Role imported from src/Role` for every spec that
  imports the shared one, or `Role declared in spec/units.spec.ts` for a spec's own. The patterns read the project's
  TypeScript files before the run, from its first commit, and after it. The `actorCalled`s a run adds pass when the
  project names its actors one way after the run, whether that's its own or a new one applied to every spec, and when
  they name theirs as the project already did; otherwise they fail. So a spec of the run's own with a `Role` enum,
  next to specs that call `actorCalled('Apisitt')`, fails

Scored this way, on the lines they change, the reference solutions fail none of these items.

### How the harness applies the decision rule

`src/summary.ts` applies [the decision rule](#the-decision-rule). Where the rule leaves room, it reads it like this:

- **Being correct 10 percentage points less often than another layout, in either agent, takes a layout out of the
  running,** rather than only stopping it from winning against that one layout
- **"Loads the right skills at least as often" has to hold in both agents,** and doesn't apply when one of the two
  layouts is None, which has no skills to load
- **"Does better than None" uses the rule's own thresholds:** correct at least 10 points more often in either agent,
  or a conventions score at least 10 points higher in both
- **None never wins.** It can take a layout out on correctness, and it's the bar for "the skills don't help", but it
  isn't a candidate for the best layout or for the tie. When None takes every layout with skills out, there's no winner
- **The only layout with skills that no other beats is the winner,** whether it beats the rest on conventions or is
  the only one left; a tie needs two or more

## The event streams

Copilot's recorded streams are two smoke runs. `copilot-cli.smoke-349396b6.jsonl` is a run in which Copilot refused to
start, because the model the harness asked for wasn't available: it has a `session.error`, no tool calls and no
`assistant.usage` or `assistant.message` event. `copilot-cli.smoke-e3c01675.jsonl` is a run of Copilot 1.0.114 with a
pin of `auto`, with tool calls. `copilot-cli.synthetic.jsonl` is written by hand, in the shapes of the recorded events,
and keeps what 1.0.114 doesn't send but the SDK documents: `assistant.usage` events, with tokens.

Kiro's fixtures, `spec/fixtures/kiro-v3.pilot-*.jsonl` and `kiro-v3.smoke-974a67ed.jsonl`, are two of the pilot's
streams and the smoke run whose skill load's `rawInput` was `{ name }`, trimmed: message chunks
dropped, tool outputs and file contents replaced with `[trimmed]`.

The judge's fixtures are `kiro-v3.judge.synthetic.jsonl`, written by hand in the shapes of Kiro's recorded events, for a
session that reads its rules and writes `verdicts.json`, and `kiro-v3.judge-launch-error.jsonl`, recorded when Kiro
couldn't start its engine inside another sandbox. A judge's session recorded by `--calibrate`, trimmed as the pilot's
streams are, can replace the synthetic one.

The recorded streams keep the paths they recorded. They come from before #3616 moved layout B's detail files under
`references/`, so their reads of layout B are of `serenity-js-screenplay/tasks.md` and the like. The specs that check
what a stream recorded keep those paths. The one spec that scores a recorded stream against layout B, `--reparse` of
pilot run `8e3a4613`, says so: its read of `serenity-js-screenplay/questions.md` isn't the
`serenity-js-screenplay/references/questions.md` the request needs now, so its loading isn't right. `--reparse` of a
result recorded before the move scores its loading the same way. `copilot-cli.synthetic.jsonl` isn't a record, so it
reads from `references/`.

- **Copilot**'s `--output-format json` writes the session events the Copilot SDK documents, in
  [Streaming session events](https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events):
  each with a `type` and a `data` payload. The parser reads `session.start` (`copilotVersion`),
  `tool.execution_start` (`toolCallId`, `toolName`, `arguments`), `tool.execution_complete` (`toolCallId`, `success`,
  `result.content`), `model.call_start` (`model`) for the models, `session.auto_mode_resolved` (`chosenModel`, `availableModels`),
  `session.usage_checkpoint` (`totalNanoAiu`, recorded as it is, unconverted, next to the premium requests),
  `assistant.usage` for tokens, and for the models when there's no `model.call_start`, if the stream has it,
  `assistant.message` for the reply, and a final `result` record, without which it counts the run as ended early. A `session.error` stops the
  scoring, with its message, even when the stream ends with a `result` record. Skill files are read with `view` (`path`), `bash` or `powershell` (`command`), or
  loaded with `skill`, whose argument the harness reads as `skill` or `name`. Events of subagents count too. The stream
  reports no cost and, as of 1.0.114, no tokens, so a Copilot run keeps `tokensReported: false`, and the summary shows
  `n/a` for both. Copilot's premium requests are in each run's `stream.jsonl`,
  in the final `result` record's `usage.premiumRequests`
- **Kiro**'s `--output-format stream-json` is the Agent Client Protocol (ACP) in JSONL, as the pilot recorded it: a
  `runStarted` with `data.payloadSchema` `"acp"`, then `sessionUpdate` events, whose ACP update is in `data.update`,
  then `runFinished`, with a `sandboxStatus` early on. A tool call is a `tool_call` update, then `tool_call_update`s
  with the same `toolCallId`, each with the fields that changed: `title`, `kind` (`read`, `execute`, `edit`,
  `search`), `rawInput` and `status`. A call counts when its last status is `completed`. Loading a skill is a call that discloses the skill's context, in
  `_meta.kiro.disclosedContext`, of type `skill`, whose `uri` is the skill's `SKILL.md`, and counts as reading
  `<name>/SKILL.md`. Without one, a call whose `rawInput` is `{ "id": "skill::<name>" }` or only
  `{ "name": "<name>" }` counts, as Kiro 3.3.0 has written both; each load counts once, whichever signals it has; a file is read with `kind` `read`
  and `rawInput.path`, and a shell command is `kind` `execute` with `rawInput.command`. The model is the
  `currentValue` of the `model` entry of the last `config_option_update`'s `configOptions`: Kiro starts with
  `"auto"`, then reports the model it resolved. Kiro reports credits, not tokens or dollars: the last
  `session_info_update` whose `_meta.kiro.kind` is `session_usage` has them in `_meta.kiro.credits[0].usage`. The
  harness records them in `result.json` as `credits`, and the summary has a Credits column; Kiro's tokens stay 0, and
  the summary shows `n/a` for them. The parser refuses a stream without that `runStarted`, or without session
  updates, so a stream in another format, such as AG-UI's, stops the scoring

Both parsers refuse a stream they don't recognise, rather than scoring it as a run that read nothing. A call counts
only when it succeeded: in Copilot's stream, when its `tool.execution_complete` has `success: true` and, for a shell
command, it exited with 0, as `shellExecution.exitCode` says, or else its result's `<shellId: N completed with exit
code M>`: Copilot reports `success: true` for a command that ran, whatever it exited with; in Kiro's, when its last status
is `completed`. A Copilot `view` whose result starts with "File too large to read at once" doesn't count either: Copilot
reports it with `success: true`, but the agent saw none of the file. Copilot's `skill`, `view` and `bash` calls, their results and the `result` record are as the
recorded run `e3c01675` has them.

## Known issues

These are to be fixed in the next pull requests, each with a failing spec first:

- **An agent that commits its own work leaves an empty diff.** The harness diffs the working copy against `HEAD`,
  so a run whose agent ran `git commit` is scored on nothing. It should diff against the commit the run started from
- **There's no deadline once the agent exits while a child keeps its output open.** The run's timeout stops when the
  agent exits, and a child that left its process group can hold the pipes open. The harness should kill the group,
  and keep the timer running until the output closes
- **A stream whose final line was cut off throws.** The parsers should skip the final line only, when it doesn't
  parse, and record that they did; an unparseable line anywhere else should still stop the scoring
- **The decision ignores the mix of models under `auto`.** The summary and `compare.md` report each layout's models,
  but the decision rule compares layouts whose runs may have used different ones
- **Kiro's parser keeps only the last model the stream reports,** and its `modelAnswered` means the session started,
  not that a model answered
- **`compare.ts` reads the reviewer's verdicts without `asVerdict`,** so a verdict the summary refuses, such as
  `Pass`, falls back to the patterns' verdict in `compare.md` without a word
- **"Too small to decide" counts the failed runs.** The sample it compares with the 33 runs the rule needs should
  leave out the network failures and agent failures, as the correctness rate does
- **Each run's `HOME` keeps the agents' own installs.** Kiro unpacks about 300 MB into it, and Copilot about 250 MB,
  and the homes stay in `<work>` after the runs, so a 16-run pilot leaves 4 to 5 GB there
- **Preparing the layouts' projects gives npm your whole environment.** `project.ts` runs `npm install`, `npm pack`
  and `npx skills` with every variable you've exported, credentials included, and `npm install` runs the install
  scripts of the projects' dependencies with them. They should get the basics the checks get, and no credentials
- **The checks are only sandboxed on macOS.** On Linux, `tsc` and `npm test` only run given `--unsandboxed`, with your
  access to your files and the network. Linux needs a backend of its own, such as bubblewrap, as another
  `ChecksSandbox` in `sandbox.ts`, whose specs CI's Linux job would run

## Developing the harness

From the repository's root:

```bash
pnpm install
npx tsc --noEmit
npx vitest run
```

The specs replay recorded event streams, in `spec/fixtures/`, and the diffs of earlier runs, in
`spec/fixtures/runs/`. The specs that run commands under `sandbox-exec`, under `sandboxed > under sandbox-exec` in
`spec/runs.spec.ts`, are skipped where it can't start: on Linux, and inside another sandbox, such as a coding agent's.

CI runs the specs on Linux and on macOS. On macOS, the job fails if any spec is skipped, so the `sandbox-exec` specs
can't stop running there unnoticed. On Linux, it fails if any spec other than those is skipped. Both read vitest's
JSON report, with `scripts/check-skipped-specs.ts`:

```bash
npx vitest run --reporter=default --reporter=json --outputFile.json=vitest.json
node scripts/check-skipped-specs.ts vitest.json                                              # as on macOS
node scripts/check-skipped-specs.ts vitest.json --may-skip 'sandboxed > under sandbox-exec'  # as on Linux
```
