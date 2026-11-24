import 'mocha';

import { Ensure, equals, includes } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

import { CalculateToSignificantDigits } from '../src/precision';

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

    it('rounds two thirds up to the given number of significant digits', () =>
        actorCalled('Apisitt').attemptsTo(
            CalculateToSignificantDigits('2 / 3', 3),
            Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result[0], equals('0.667')),    // wrong: '0.667' => '0.666'
        ));
});

/*
 * Suggestions, beyond this change:
 *
 * - The other three scenarios repeat the same request, and read the same values from the response, in a list of
 *   Send and Ensure calls. CalculateToSignificantDigits, and a question grouping the values they read, could
 *   replace those lists.
 * - PostAndCheck is named after its mechanics, takes plain values rather than Answerables, and isn't described with
 *   the. No scenario uses it, so it could go, once the scenarios use CalculateToSignificantDigits.
 */
