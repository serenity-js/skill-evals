import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

import { Role } from '../src/Role';

const SumOfResults = () =>
    LastResponse.body<{ result: string[] }>().result
        .as(results => results.reduce((total, result) => total + Number(result), 0))
        .describedAs('the sum of the results');

describe('Calculating several expressions in one request', () => {

    it('gives results that add up as the expressions do', () =>
        actorCalled(Role.Analyst).attemptsTo(
            Send.a(PostRequest.to('/v4').with({ expr: [ '10 / 4', '3 * 3' ] })),
            Ensure.that(SumOfResults(), equals(11.5)),    // wrong: equals(11.5) => equals(12)
        ));
});
