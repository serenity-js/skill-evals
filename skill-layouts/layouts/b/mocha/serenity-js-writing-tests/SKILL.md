---
name: serenity-js-writing-tests
description: "Writing Mocha test scenarios with Serenity/JS: scenarios that actors perform, giving actors their abilities in a Cast, configuring Serenity/JS and its reporting, checking outcomes with Ensure.that, and with Ensure.eventually for outcomes that arrive later, and waiting with Wait.until. Use when adding or changing a test scenario, including adding to the existing scenarios of a spec, in a project that runs Serenity/JS with Mocha, or its Serenity/JS configuration."
---

# Writing tests with Serenity/JS and Mocha

A Serenity/JS scenario in Mocha is an `it` block in which actors perform activities and check their outcome.
Mocha runs the scenarios; Serenity/JS gives the actors their abilities, and reports what each of them did.

## Adding to existing scenarios

Before you add a scenario to a spec, read the ones it already has. They're the nearest example, but not always a
good one: a scenario that's a long list of built-in interactions, such as `Send` and `Ensure.that` calls repeated
from one scenario to the next, is a poor abstraction. Don't copy it.

- **Write the new scenario with a task**, named for the business step it achieves.
- **Follow the spec's conventions**, such as how it names its actors, or apply a new convention to every spec, and
  say so in your report. Never mix the two: a `Role` enum in the new scenario, next to actors named with plain
  strings, such as `'Apisitt'`, in the others, is two ways of doing one thing.
- **Leave the waiting to the task that causes the delay.** The task waits for its own outcome, and the new scenario
  checks it with `Ensure.that`. `Ensure.eventually` is for an outcome checked after a task that already waits for its
  own completion, or one nothing in the code is responsible for.
- **Refactor only what your change touches**, and suggest the rest in your report.
- **For what to look for, and how to refactor it**, load the serenity-js-screenplay skill, and
  read its "Refactor what's there".

## Write a scenario as activities an actor performs

Get an actor with `actorCalled`, and have it perform the scenario's steps with `attemptsTo`:

```typescript
import { Ensure, equals } from '@serenity-js/assertions'
import { Activity, actorCalled, QuestionAdapter } from '@serenity-js/core'
import { describe, it } from 'mocha'

// the actors' names: the roles they play, and the personas who play them
declare enum Role { Cardholder = 'Alice, the cardholder' }

// a task and a question of the project
declare const ReportALostCard: () => Activity
declare const CardStatus: () => QuestionAdapter<string>

describe('Lost cards', () => {

    it('are blocked as soon as they are reported', async () => {
        await actorCalled(Role.Cardholder).attemptsTo(
            ReportALostCard(),
            Ensure.that(CardStatus(), equals('blocked')),
        )
    })
})
```

- **Name the `describe` after the feature, and the `it` after the behaviour**, so the report reads as a
  specification: "Lost cards are blocked as soon as they are reported".
- **Await, or return, the promise `attemptsTo` returns.** Otherwise Mocha finishes the scenario before the actor does.
- **Write the steps as tasks in the language of the business domain**, rather than as interactions with the
  system's interface. When several scenarios repeat the same steps, extract them into a task.
- **Name actors after the role they play**, and keep the names in an enum whose keys are the roles, and whose
  values are personas who play them: `Role.Cardholder = 'Alice, the cardholder'`. `actorCalled(Role.Cardholder)`
  returns the same actor for the rest of the scenario, and a new one in the next scenario.

## Give actors their abilities in a Cast

The `actors` of the Serenity/JS configuration are a `Cast`, which gives every actor the abilities it needs, such
as `CallAnApi` from `@serenity-js/rest` to send HTTP requests:

```typescript
import { Actor, Cast, configure, TakeNotes } from '@serenity-js/core'
import { CallAnApi } from '@serenity-js/rest'

class Actors implements Cast {
    constructor(private readonly baseApiUrl: string) {
    }

    prepare(actor: Actor): Actor {
        return actor.whoCan(
            CallAnApi.at(this.baseApiUrl),
            TakeNotes.usingAnEmptyNotepad(),
        )
    }
}

configure({
    actors: new Actors(process.env.BASE_API_URL ?? 'http://localhost:3000/'),
    crew: [
        [ '@serenity-js/console-reporter', { theme: 'auto' } ],
    ],
})
```

Call `configure` once, before any scenario runs: in a file that Mocha loads first, with `require` in
`.mocharc.yml`, such as `spec/support/serenity.config.ts` in the Serenity/JS Mocha template. That's where the
`crew` is configured too: the reporters, and a `StreamReporter` you add for a while to debug a scenario. Read the configuration a test environment needs, like the address of the system under test,
from environment variables, so the same scenarios run against any environment.

## Configure Mocha to report with Serenity/JS

The `@serenity-js/mocha` reporter turns Mocha's scenarios into Serenity/JS events, which the reporters of the
`crew` turn into reports:

```yaml
reporter: '@serenity-js/mocha'
require:
  - ts-node/register
  - spec/support/serenity.config.ts
spec: 'spec/**/*.spec.ts'
timeout: 5000
```

The `timeout` applies to each scenario, so it must leave time for every activity in it, including waits.

## Check outcomes with `Ensure.that`

`Ensure.that` compares the answer to a question with an expectation, and reports both:

```typescript
import { and, Ensure, equals, includes, isGreaterThan, startsWith } from '@serenity-js/assertions'
import { actorCalled, QuestionAdapter } from '@serenity-js/core'

// the actors' names: the roles they play, and the personas who play them
declare enum Role { Cardholder = 'Alice, the cardholder' }

declare const ConnectedNumber: () => QuestionAdapter<string>
declare const CallHistory: () => QuestionAdapter<string[]>

await actorCalled(Role.Cardholder).attemptsTo(
    Ensure.that(ConnectedNumber(), and(startsWith('0800'), includes('123'))),
    Ensure.that(CallHistory().length, isGreaterThan(0)),
    Ensure.that(CallHistory()[0], equals('0800 123 456')),
)
```

The expectations come from `@serenity-js/assertions`. Combine them with `and`, `or` and `not`, rather than
answering the question yourself and comparing the answer.

`Ensure.that` checks an outcome that's already there, and fails straight away when it isn't. When a task causes the
delay, the task waits for its own outcome, as the serenity-js-screenplay skill's "Make a task wait for its own outcome"
describes, and the scenario checks it with `Ensure.that`. `Ensure.eventually` is for an outcome that arrives later
though the task before it already waits for its own completion, or one nothing in the code is responsible for. It
keeps asking until the answer meets the expectation, or until the timeout passes, instead of a `Wait.until` followed
by an `Ensure.that`:

```typescript
import { Ensure, equals } from '@serenity-js/assertions'
import { Activity, actorCalled, QuestionAdapter } from '@serenity-js/core'

// the actors' names: the roles they play, and the personas who play them
declare enum Role { Cardholder = 'Alice, the cardholder' }

// a task that waits until the bank has taken the report, and a question about the card, which the bank's back office
// blocks later, outside anything the task does
declare const ReportALostCard: () => Activity
declare const CardStatus: () => QuestionAdapter<string>

await actorCalled(Role.Cardholder).attemptsTo(
    ReportALostCard(),
    Ensure.eventually(CardStatus(), equals('blocked')),
)
```

## Wait for the system with `Wait.until`

When the system takes time to respond, wait for the outcome rather than for a fixed time, in the task that causes
the delay, so that its callers don't have to:

```typescript
import { equals } from '@serenity-js/assertions'
import { Activity, Duration, QuestionAdapter, Task, the, Wait } from '@serenity-js/core'

declare const CallBank: () => Activity
declare const CardStatus: () => QuestionAdapter<string>

export const BlockACard = () =>
    Task.where(the`#actor blocks a card`,
        CallBank(),
        Wait.upTo(Duration.ofSeconds(5)).until(CardStatus(), equals('blocked')),
    )
```

`Wait.until` asks the question until its answer meets the expectation, or until the timeout passes, and then
fails the scenario with the last answer it got.

## Write the tasks and questions with the Screenplay Pattern

The skills of `@serenity-js/core` cover the building blocks a scenario uses:

- **How they fit together:** the serenity-js-screenplay skill
- **Tasks:** the serenity-js-screenplay skill
- **Interactions:** the serenity-js-screenplay skill
- **Abilities:** the serenity-js-screenplay skill
- **Questions:** the serenity-js-screenplay skill

## Avoid

- **Calling a client from an `it` block**, such as an HTTP client, instead of an interaction that uses the actor's
  ability. The report then misses the step
- **Assertions from other libraries**, like `expect` from Chai, which the report doesn't show as the actor's
  activities
- **`Wait.for` a fixed duration**, which makes the scenario slow when the system is fast, and fail when it's slow
- **State shared between scenarios** in variables. Each scenario gets new actors; keep what an actor remembers in
  its notes, with `TakeNotes`
