import 'mocha';

import { Ensure, equals, includes } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

describe('Precision', () => {

    it('rounds a result to the given number of significant digits', () =>
        actorCalled('Apisitt').attemptsTo(
            Send.a(PostRequest.to('/v4').with({ expr: [ '1 / 3' ], precision: 3 })),
            Ensure.that(LastResponse.status(), equals(200)),
            Ensure.that(LastResponse.header('content-type'), includes('application/json')),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().error, equals(null)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result.length, equals(1)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result[0], equals('0.333')),
        ));

    it('keeps a whole number whole', () =>
        actorCalled('Apisitt').attemptsTo(
            Send.a(PostRequest.to('/v4').with({ expr: [ '10 / 2' ], precision: 3 })),
            Ensure.that(LastResponse.status(), equals(200)),
            Ensure.that(LastResponse.header('content-type'), includes('application/json')),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().error, equals(null)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result.length, equals(1)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result[0], equals('5')),
        ));

    it('rounds a large number in scientific notation', () =>
        actorCalled('Apisitt').attemptsTo(
            Send.a(PostRequest.to('/v4').with({ expr: [ '2 ^ 64' ], precision: 3 })),
            Ensure.that(LastResponse.status(), equals(200)),
            Ensure.that(LastResponse.header('content-type'), includes('application/json')),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().error, equals(null)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result.length, equals(1)),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result[0], equals('1.84e+19')),
        ));
});
