import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { GetRequest, LastResponse, Send } from '@serenity-js/rest';

import { Role } from '../src/Role';

describe('Unit conversion', () => {

    it('converts inches to centimetres', () =>
        actorCalled(Role.Analyst).attemptsTo(
            Send.a(GetRequest.to('/v4').using({ params: { expr: '5 inch to cm' } })),
            Ensure.that(LastResponse.body<string>(), equals('12.7 cm')),    // wrong: '12.7 cm' => '12.8 cm'
        ));
});
