import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled, List } from '@serenity-js/core';
import { GetRequest, LastResponse, Send } from '@serenity-js/rest';

import { Role } from '../src/Role';

const examples = [
    { expression: '2 + 2', result: 4 },
    { expression: '10 / 4', result: 2.5 },    // wrong: 2.5 => 3
    { expression: '3 * 3', result: 9 },
];

describe('Expressions', () => {

    it('give the results they should', () =>
        actorCalled(Role.Analyst).attemptsTo(
            List.of(examples).forEach(({ actor, item }) =>
                actor.attemptsTo(
                    Send.a(GetRequest.to('/v4').using({ params: { expr: item.expression } })),
                    Ensure.that(LastResponse.body<number>(), equals(item.result)),
                )
            ),
        ));
});
