# AGENTS.md

Guidance for coding agents, and for people, changing this repository: evaluations of the agent skills that
[Serenity/JS](https://serenity-js.org) packages ship. Each evaluation's README says what it measures and how to run it.

## Commands

From the repository's root, with Node.js 24 and pnpm:

```bash
pnpm install
npx tsc --noEmit
npx vitest run
npx vitest run --reporter=default --reporter=json --outputFile.json=vitest.json
node scripts/check-skipped-specs.ts vitest.json --may-skip 'sandboxed > under sandbox-exec'   # as CI's Linux job does
```

A change is done when all three pass. The specs that run commands under `sandbox-exec` are skipped on Linux and inside
another sandbox, such as a coding agent's, so a change to the checks' sandbox also needs CI's macOS job.

## Changes

- A failing spec first, then the change that makes it pass
- Conventional Commits, scoped by the directory the change is in, such as `fix(skill-layouts): …`
- A refactoring changes no behaviour. Show that it doesn't: compare what the code writes, before and after, byte for
  byte, rather than relying on the specs alone

## How the code is designed

New code is written as a domain model: the concepts of the evaluation, such as a verdict, a ballot or a judge, as types
that hold their data and the behaviour that uses it. `skill-layouts/src/judging/` is written this way.

- **Values are small, immutable classes with static factories**, as `@serenity-js/core`'s `Duration` and `Timestamp`
  are: `Share.of(17, 20)`, `Verdict.of('pass')`, `JudgeIdentity.of(agent, model, version)`. Their fields are
  `readonly`, their constructors private, and each says how it's rendered and serialised, with `toString()` and
  `toJSON()`
- **A static factory builds a value from data in memory only.** Anything that reads or writes files, runs a process
  or uses the clock is an instance method of an object given those dependencies at construction. `JudgeBrief.of`
  makes what the judge is given, as files and their contents, and `JudgeWorkspace.prepare` writes it, with the
  filesystem operations the workspace was constructed with. Likewise, `RecordedRounds.read` reads a round's results,
  and the `RecordedRound` it returns is a plain value
- **Behaviour lives with the data it uses.** A ballot knows its majority, a comparison knows whether it agrees, and a
  share renders its own percentage, rather than functions elsewhere filtering plain structs. Compute a derived value
  once, where its data is, rather than every time it's needed
- **Dependencies are given at construction**: the process runner, the clock, the log, random names, the
  environment, and the filesystem. A class doesn't import them, and they don't travel in options bags. The command
  line is where they're chosen, as `calibrationOf` in `cli.ts` composes a `Calibration`. A class that reads or writes
  files takes only the operations of `Filesystem`, in `judging/filesystem.ts`, that it uses, as a `Pick<Filesystem, …>`.
  `cli.ts` gives it `nodeFilesystem()`; a spec can give it an in-memory one, as `spec/memory-filesystem.ts` is
- **No module-level mutable state, and no module-level configuration.** Only true constants live at a module's top
  level, such as a validator or a file's fixed name. A threshold, a number of repeats or a model is configuration: a
  constructor argument, with its default where the class is defined, or a field of `config.json`
- **A decision with several outcomes is a list, or a polymorphic type, not a chain of ifs.** The calibration
  protocol's criteria are an ordered list, each with its own status and message, so adding one adds an entry.
  `Comparison.differences` and the results a `Ballot` comes to work the same way
- **Files the harness reads are validated field by field**, with `records.ts`'s combinators, so that a malformed field
  is reported by its path in the file, whichever file it's in
- **Parameter properties aren't allowed**: the TypeScript configuration has `erasableSyntaxOnly`, since Node.js runs
  the sources as they are. Declare each field, and assign it in the constructor

The older modules, such as `runs.ts`, `summary.ts` and `cli.ts`, are written as functions over plain structs. **They
move to this style when a pull request changes them**, one module at a time, as part of that change. Don't rewrite them
in one sweep.
