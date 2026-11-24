# Reviewing a run

This guide is for whoever fills in `review/scores.json`. The checklist in each review packet says what each item asks
for; this guide says how the decisions made so far settle the cases the checklist leaves open. Each rule names the
items it settles, and the runs it was decided on, by their IDs. A run comes from one of two rounds: the focused round,
or the Copilot check of layouts B and C. The one run cited from another round, the regression check, says so where
it's cited. The rounds' results aren't in this repository; the runs that specs replay, such as *89a97301*, have their
diffs in `spec/fixtures/runs/`.

A rule applies wherever the code a run added is about it, whether or not the run's request is listed for the item.
When a case isn't covered here, score it from the item's text, and add the decision to this guide.

## Answerable parameters

**Items:** `answerable-parameters`

Every parameter of a task, an interaction or a question is `Answerable<T>`. An `Answerable` placed in an array or an
object literal that's passed on as data fails, even when the parameter's type is right:

```typescript
Send.a(PostRequest.to('/v4').with({ expr: [ expression ], precision }))
```

`actor.answer()` resolves only a question or a promise at the top level, so the `Answerable`s inside the literal reach
the request unanswered. The run's tests don't catch it: `.with()` takes `Answerable<any>`, so it compiles, and the
scenarios pass static strings, which need no answering. *5a6adab8*, *3cf1d4ac* and *2196d6e5* fail for this.

Three forms pass:

- **`Question.fromObject`**, which answers every property, nested arrays included, and **`Question.fromArray`** for a
  list. *be977ebc* passes with `.with(Question.fromObject({ expr: Question.fromArray([ expression ]), precision }))`
- **A `Question.about` that answers each parameter**, with `await actor.answer(…)`, before building the data.
  *a185af41* passes with `expr: [ await actor.answer(expression) ]` inside one

## Checks inside tasks

**Items:** `structure`, `tasks-for-steps`

A task that checks it completed correctly is a valid design. The status, the content type and the absence of errors
belong in the task that makes the request, so that every caller gets them. *3cf1d4ac* passes `structure` with
`CalculateWithPrecision` checking the status and the error after its `Send`.

When several of those checks would be repeated wherever the request is made, a custom expectation over a typed
response, defined with `Expectation.define`, is the better form, as in
`Ensure.that(LastResponse.body<CalculationResponse>(), hasNoErrors())`. Checks repeated inline in each task are a
missed expectation, not a failure.

## Inline response reads in new scenarios

**Items:** `no-copied-abstractions`, `structure`

A new scenario that reads the response inline, as in
`Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result, equals([ '0.667' ]))`, copies the
fixture's poor abstraction, even when the fixture's scenarios do the same. *2196d6e5* and *7fab4daa* fail
`no-copied-abstractions` for it. A question that names what's read, such as `CalculatedResult()`, passes.

## Activities in specs

**Items:** `structure`, `suggested-the-rest`

An activity or a question may start in the spec that needs it, while no other spec uses the pattern, or as a first
pass while refactoring one spec. Once it works, or another spec needs it, it belongs in `src/`, next to the related
code. A finished change that leaves it in the spec, next to related code in `src/`, fails `structure`: *20222fe7*
defines `CalculateWithPrecision` and `CalculatedResult` in `spec/precision.spec.ts`, while `PostAndCheck` stays in
`src/precision.ts`, and *7fab4daa* defines `Calculate` in the spec.

## Grouping or an expectation

**Items:** `grouping`

Until anything is reused, standalone questions are fine: *5a6adab8*'s `CalculatedResult()` and `CalculationError()`
pass. Grouped questions, such as `Calculator.result()` and `Calculator.error()`, fit when different tasks or specs
need different parts of the same thing: *ccb92e43* and *baed32fb* pass. When several places would repeat the same
combined check, a custom expectation fits instead, as in [Checks inside tasks](#checks-inside-tasks).

## Tasks that take the expected value

**Items:** `tasks-for-steps`, `structure`

The scenario checks the expected outcome of the workflow, at the business level; the task makes it happen. A task
that takes the expected value mixes the two levels, and fails: *9063dce3*'s
`CalculateWithPrecision('1 / 3', 3, '0.333')`, described as "calculates … and expects …", fails `tasks-for-steps` and
`structure`. Transport checks in the task, with the scenario checking the result, pass.

### Expected values the test works out itself

**Items:** `tasks-for-steps`, `structure`, `no-copied-abstractions`

A task that works out the expected result itself, by copying the system's own logic, fails all three. It checks the
business outcome, which is the scenario's job, and a bug in the system would be expected by the test too. *1d26de24*
and *8c51bf2c* copy `CalculationJobs`' `sum()`,
`expression.split('+').map(term => Number(term.trim())).reduce((total, term) => total + term, 0)`, into the
`Wait.until` of the task that submits the job file: *1d26de24* as a `sum` function of its own in `activities.ts`, and
*8c51bf2c* inline, in `equals(String(…))`.

A task that waits for the result to be present passes: *f61935c2*'s `CalculateFromFile` ends with
`Wait.until(ResultOfJobFile(fileName), isPresent())`, and leaves checking the result to the scenario.

## Interaction object naming

**Items:** `tasks-for-steps`, `question-names`

An object that groups tasks and questions is an interaction object: a noun for the object, verbs for its tasks, and
nouns for its questions. *ccb92e43*'s `Calculator.calculate()` and `Calculator.result()` pass. *d9ec173d*'s
`Calculation.of('1 / 3', 3)` names a task with a noun, and fails `tasks-for-steps`.

## Where waits belong

**Items:** `waits-in-tasks`

A task waits for the outcome it causes, with `Wait.until` or `Ensure.eventually` inside the task, so that its callers
don't have to. A scenario that waits for what a task caused fails:

- *924363f0* and *b002da42* follow their task with `Wait.until(…)` and an `Ensure.that` of the same question
- *eb5ca992* follows a task that doesn't wait with `Ensure.eventually`

*ba998d30* passes: `CalculateUsingJobFile` ends with `Wait.until(ResultOfLastJobFile(), isPresent())`, and the scenario
checks the result with `Ensure.that`. `Ensure.eventually` in a scenario passes for an outcome checked after a task
that already waits for its own completion, or for one nothing in the code is responsible for.

## Changing the system under test

**Items:** `structure`

Test code uses the system under test through its interfaces. It doesn't change the system to suit itself: exposing
its internals, or adding client code to it, fails `structure`, whatever else the run does well.

- *924363f0* and *ba998d30* make `CalculationJobs`' `jobsDirectory` and `resultsDirectory` public, so that their
  abilities can write job files
- *eb5ca992* adds `submitFile`, `resultFile` and `removeFiles` to `CalculationJobs`

The client is the test's own, in an ability, reaching the system the way its users do: here, by writing to the
directory `JOBS_DIR` names, and reading from the one `RESULTS_DIR` names.

Test code doesn't change the system under test at all, including to satisfy the test project's lint: when the lint
reports a problem in the system under test, the run reports it instead. *f61935c2* and *ed5ba5de* fail for changing
`system-under-test/CalculationJobs.ts`'s `import { join } from 'path'` to `import path from 'path'`, after
`npm run lint` reported it. *661802dc* passes: it leaves the file alone, and its reply says "Full-repository lint still
reports an existing import-style issue in `system-under-test/CalculationJobs.ts`."

## Clients outside abilities

**Items:** `clients-through-abilities`, `cast`

Interactions and questions reach the system through an ability, retrieved with `Ability.as(actor)`, never through
`fs`, `fetch`, `axios`, `http` or `https` directly. *b002da42*'s `WriteAJobFile` calls `writeFileSync`, and its
`ResultFileOfLastJobFile` calls `existsSync` and `readFileSync`, with the directories read from the environment in
`activities.ts`: it fails `clients-through-abilities`, which the patterns score, and `cast`, since the configuration
the test environment gives isn't the `Cast`'s. The other request 9 runs pass, with an ability such as
`ExchangeJobFiles` or `RunCalculationJobs` wrapping the file system.

## Configuration from the environment

**Items:** `cast`

Environment variables are globals, so the test code injects them explicitly, as it would any other dependency.
Ideally, the configuration file passes `process.env` to the `Cast`, as in `new Actors(process.env)`, and `prepare()`
reads `this.env.JOBS_DIR ?? 'jobs'`. A default belongs where the variable is read: `?? ''` followed by a check for an
empty string sets the default in one place and checks it in another.

An ability's factory method may default a parameter to an environment variable, as in
`using(jobs, jobsDirectory = process.env.JOBS_DIR)`, when that makes the ability simpler to call. A default in the
ability's constructor as well is unnecessary: a weakness, which still passes.

- *661802dc* passes: the `Cast`'s `prepare()` reads `process.env.JOBS_DIR` and `process.env.RESULTS_DIR`, and passes
  them to `RunCalculationJobs.using(jobs, jobsDirectory, resultsDirectory)`, whose constructor takes them as they are
- *bfefa006* and *f61935c2* pass, with the constructor's default as a weakness. *bfefa006*'s
  `using(jobs: CalculationJobs, jobsDirectory = process.env.JOBS_DIR, resultsDirectory = process.env.RESULTS_DIR)` is
  the factory default this allows, and its constructor defaults the same parameters to the same variables again.
  *f61935c2*'s `Cast` resolves `process.env.JOBS_DIR ?? 'jobs'` and `process.env.RESULTS_DIR ?? 'results'` and passes
  them to `using()`, and its constructor defaults them to the same expressions
- *1d26de24* and *8c51bf2c* fail: they read the environment inside the ability's methods. *1d26de24*'s
  `submitAsFile` and `resultOfFile` read `process.env.JOBS_DIR` and `process.env.RESULTS_DIR`, and *8c51bf2c*'s
  `submitFile` and `resultFromFile` read `process.env.JOBS_DIR ?? ''`, then check it with
  `ensure('JOBS_DIR', jobsDirectory, isNotBlank())`
- *ed5ba5de* fails: its `using(jobs: CalculationJobs)` reads `process.env.JOBS_DIR ?? ''` and
  `process.env.RESULTS_DIR ?? ''` itself, so a caller can't pass other directories. Optional parameters that default to
  the variables would have been the better design

## Files a run leaves behind

**Items:** `no-debugging-left`

A run leaves nothing behind that the change doesn't need: neither debugging code, such as `Log.the` or a
`StreamReporter`, nor files that its own test runs produced. *f61935c2* fails for leaving `results/calculation-job.txt`
and `results/calculation-job-49028.txt` in the project.

## Mocha's timeout and the waits

**Items:** `timeout`

A scenario's waits finish inside Mocha's timeout, so that a wait that gives up reports what it expected, rather than
Mocha's `Timeout of 5000ms exceeded`. The template's `.mocharc.yml` sets `timeout: 5000`, and `Wait.until` and
`Ensure.eventually` wait for up to `interactionTimeout`, 5 seconds by default. So a wait of 5 seconds fails, whether
it's written as `Wait.upTo(Duration.ofSeconds(5))` or left at the default: the same behaviour scores the same.

- Every run of the Copilot check fails. *1d26de24*, *26a3a505*, *8c51bf2c*, *afee10f3* and *bfefa006* wait with
  `Wait.upTo(Duration.ofSeconds(5))`; *661802dc*, *c4d37f89*, *e11904d9*, *ed5ba5de* and *f61935c2* with `Wait.until`
  at the default; *550883ad* and *5ede5a84* with `Ensure.eventually` at the default
- *3e529c3d*, of the regression check, passes with
  `Wait.upTo(Duration.ofSeconds(3)).until(StatusOfLastJob(), equals('done'))`

Raising Mocha's timeout, so that it leaves time for the waits, passes too.
