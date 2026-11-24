import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { GetRequest, LastResponse, Send } from '@serenity-js/rest';

import { Role } from '../src/Role';

describe('Matrices', () => {

    it('have a determinant', () =>
        actorCalled(Role.Analyst).attemptsTo(
            Send.a(GetRequest.to('/v4').using({ params: { expr: 'det([[1, 2], [3, 4]])' } })),
            Ensure.that(LastResponse.body<number>(), equals(-2)),    // wrong: equals(-2) => equals(2)
        ));
});
