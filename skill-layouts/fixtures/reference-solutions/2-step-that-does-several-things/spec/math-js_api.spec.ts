/* eslint-disable unicorn/filename-case, unicorn/consistent-function-scoping */
import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

import { CalculateExpression } from '../src/calculations';

describe('Math-js API', () => {

    describe('GET /v4/?expr', () => {

        it('supports calculating a single expression', () =>
            actorCalled('Apisitt').attemptsTo(
                CalculateExpression('2 + 2'),
                Ensure.that(LastResponse.body<number>(), equals(4)),    // wrong: equals(4) => equals(5)
            ));
    });

    describe('POST /v4', () => {

        const RequestToCalculateExpressions = (expressions: string[], precision?: number) =>
            PostRequest.to(`/v4`).with({ expr: expressions, precision })
                .describedAs(`a request to calculate ${ expressions.join(', ') }`)

        interface CalculatedExpressions {
            result: string[] | string | null;
            error: string | null;
        }

        it('supports calculating multiple expressions in one request', () =>
            actorCalled('Apisitt').attemptsTo(

                Send.a(RequestToCalculateExpressions([ '2 + 2', '5 - 3' ])),

                // note that LastResponse.body is generic;
                // you can configure it with an interface specifying the shape of the expected response body
                Ensure.that(LastResponse.body<CalculatedExpressions>(), equals({
                    result: [ '4', '2' ],
                    error: null,            // eslint-disable-line unicorn/no-null
                })),
            ));
    });
});
