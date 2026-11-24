---
name: serenity-js-screenplay-pattern
description: "The Screenplay Pattern in Serenity/JS: actors, abilities, interactions, questions and tasks, how they fit together, naming actors, and which to write. Use when deciding how to structure a test, a step or a piece of test code with Serenity/JS, before writing a task, an interaction, an ability or a question."
---

# The Screenplay Pattern

Serenity/JS tests are written with the Screenplay Pattern. Choose the building block by what the test needs:

| The test needs to | Write | Read |
|---|---|---|
| Reach a goal of the business domain, or take a step that does several things | a task | the serenity-js-writing-tasks skill |
| Do one thing with the system under test | an interaction | the serenity-js-writing-interactions skill |
| Reach an interface that no Serenity/JS integration covers | an ability | the serenity-js-writing-abilities skill |
| Find out about the system under test, to check it or to wait for it | a question | the serenity-js-writing-questions skill |

## What each skill covers

### serenity-js-writing-tasks

Tasks: composing activities into the goals of the business domain, describing them, waiting for their outcome, and
growing and refactoring the tests they're part of.

- Write a task as a function that returns `Task.where`
- Describe it with `the`
- Accept `Answerable` parameters
- Repeat activities with `List.of(…).forEach`
- Leave a task pending until you can implement it
- Make a task wait for its own outcome
- Make a task check that it did what it should
- Grow the structure as the project needs it
- Refactor what's there
- Avoid

### serenity-js-writing-interactions

Interactions, which do one thing with the system under test.

- Write an interaction with `Interaction.where`
- Avoid

### serenity-js-writing-abilities

Abilities, which wrap the client of an interface no Serenity/JS integration covers, and give interactions and
questions access to it.

- Check whether you need a new ability
- Wrap the client in an ability
- Retrieve it with `as`
- Initialise and discard the resources the ability uses
- Make implementations interchangeable
- Avoid

### serenity-js-writing-questions

Questions, which find out about the system under test, and debugging a scenario by what they answer.

- Write a question with `Question.about`
- Transform answers instead of writing new questions
- Ask about part of something with `.of()`
- Define an expectation for a comparison that's missing
- Debug a scenario with `Log.the` and `StreamReporter`
- Avoid

## How the building blocks fit together

In the Screenplay Pattern, an actor uses **abilities** to perform **interactions** and to answer **questions**,
and **tasks** compose interactions and other tasks into goals:

```typescript
import { Ability, actorCalled, Answerable, Interaction, Question, Task, the } from '@serenity-js/core'

// an ability wraps the client of one of the system's interfaces, here a phone
interface Phone {
    dial(phoneNumber: string): Promise<void>
    press(key: string): Promise<void>
    connectedNumber(): Promise<string>
}
declare const phone: Phone

class MakePhoneCalls extends Ability {
    static using(phone: Phone): MakePhoneCalls {
        return new MakePhoneCalls(phone)
    }

    constructor(private readonly phone: Phone) {
        super()
    }

    dial(phoneNumber: string): Promise<void> { return this.phone.dial(phoneNumber) }
    press(key: string): Promise<void> { return this.phone.press(key) }
    connectedNumber(): Promise<string> { return this.phone.connectedNumber() }
}

// interactions do one thing with the system, using the ability
const Dial = (phoneNumber: Answerable<string>) =>
    Interaction.where(the`#actor dials ${ phoneNumber }`, async actor => {
        const number = await actor.answer(phoneNumber)
        await MakePhoneCalls.as(actor).dial(number)
    })

const Press = (key: Answerable<string>) =>
    Interaction.where(the`#actor presses ${ key }`, async actor => {
        const pressed = await actor.answer(key)
        await MakePhoneCalls.as(actor).press(pressed)
    })

// questions find out about the system, using the ability
const ConnectedNumber = () =>
    Question.about('the connected number', actor => MakePhoneCalls.as(actor).connectedNumber())

// tasks compose interactions and other tasks into a goal of the business domain
const ReportALostCard = () =>
    Task.where(the`#actor reports a lost card`,
        Dial('0800 123 456'),
        Press('2'),
    )

// an actor performs them, under the name of a persona who plays a role
enum Role {
    Cardholder = 'Alice, the cardholder',
}

await actorCalled(Role.Cardholder)
    .whoCan(MakePhoneCalls.using(phone))
    .attemptsTo(
        ReportALostCard(),      // reported as: Alice, the cardholder reports a lost card
    )
```

`actorCalled` returns the actor with the name you give it. Always `await` what `attemptsTo` returns: it settles once
the actor has performed every activity, or one of them has failed. Name actors after the role they play, and keep
the names in an enum or constants, as `Role` does: its keys are the roles, and its values the personas who play
them, so that every scenario calls the same actor the same way, and the report says who did what.

Most projects get their abilities, and many interactions and questions, from the Serenity/JS integrations, such as
`BrowseTheWeb` and `Click` from `@serenity-js/web`. The serenity-js-writing-abilities and serenity-js-writing-interactions
skills cover writing your own, and the serenity-js-writing-questions skill covers questions. The other Screenplay skills
use the interactions and the question above.

