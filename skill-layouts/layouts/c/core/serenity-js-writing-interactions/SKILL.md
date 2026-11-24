---
name: serenity-js-writing-interactions
description: "Writing Screenplay Pattern interactions with Serenity/JS: interactions with Interaction.where, one action each, when two closely related steps are one action, using the integrations' interactions first, with Answerable parameters and descriptions for the report. Use when adding or changing an interaction with the system under test."
---

# Writing Screenplay interactions

An interaction is one thing an actor does with the system under test: dial a number, click a button, send a
request. The serenity-js-writing-abilities skill covers the abilities that enable interactions.

Tests rarely use interactions directly. They use tasks, which compose interactions into goals in the business domain;
the serenity-js-writing-tasks skill covers those.

## Write an interaction with `Interaction.where`

`Interaction.where` takes the description to report and a function that performs the interaction:

```typescript
import { Ability, Answerable, Interaction, the } from '@serenity-js/core'

declare class MakePhoneCalls extends Ability {
    press(key: string): Promise<void>
}

export const Press = (key: Answerable<string>) =>
    Interaction.where(the`#actor presses ${ key }`, async actor => {
        const pressed = await actor.answer(key)
        await MakePhoneCalls.as(actor).press(pressed)
    })
```

- **One interaction, one action, through one ability.** `Dial` and `Press`, not `DialAndChooseAnOption`. Several
  actions that achieve a goal together are a task.
- **Use the interactions the Serenity/JS modules provide** before writing your own, such as `Click` from
  `@serenity-js/web` or `Send` from `@serenity-js/rest`.
- **Name it after the action, in the vocabulary of the interface**: `Dial`, `Click`, `Send`, `Navigate`.
- **Accept `Answerable` parameters, and answer them here.** An interaction is where a value meets the client, so
  it's the place to call `actor.answer()`: a test can then pass a static value or a question about the system.
  Answer each parameter into a constant of its own, `const number = await actor.answer(phoneNumber)`, with
  `async` and `await` rather than a chain of `then` calls, so that each step reads in the order it happens.
- **Describe it with the `the` tag**, so that the report shows what the actor did: "Alice, the cardholder presses "2"".
- **Use a class only for a fluent API**, like `Send.a(request)` in `@serenity-js/rest`. A function that returns
  `Interaction.where` covers everything else.

An interaction may take two closely related steps, even through more than one ability, when they're one action
from the actor's point of view. Saving a file means checking that its directory is writable, then writing it:

```typescript
import { Ability, Answerable, Interaction, the } from '@serenity-js/core'

declare class UseFileSystem extends Ability {
    isWritable(directory: string): Promise<boolean>
    writeFile(directory: string, name: string, contents: string): Promise<void>
}

export const SaveAFile = (directory: Answerable<string>, name: Answerable<string>, contents: Answerable<string>) =>
    Interaction.where(the`#actor saves ${ name } in ${ directory }`, async actor => {
        const path = await actor.answer(directory)
        const fileName = await actor.answer(name)
        const text = await actor.answer(contents)
        const fileSystem = UseFileSystem.as(actor)

        if (! await fileSystem.isWritable(path)) {
            throw new Error(`${ path } isn't writable`)
        }

        await fileSystem.writeFile(path, fileName, text)
    })
```

If the steps make sense apart, so that a test might take one without the other, they're two interactions, composed
in a task.

## Avoid

- **Changing the system under test to suit the test**, by importing its modules, exposing its internals, or adding
  client code to it. Reach it through its interfaces, with a client of the test's own
- **Interactions that perform other activities.** Composing activities is what tasks are for
- **Retrieving information in an interaction.** Information is what questions are for; the
  serenity-js-writing-questions skill covers those
