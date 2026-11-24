/* eslint-disable unicorn/filename-case, unicorn/consistent-function-scoping */
import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled, Answerable, Question, the } from '@serenity-js/core';
import { GetRequest, LastResponse, PostRequest, Send } from '@serenity-js/rest';

describe('Math-js API', () => {

    describe('GET /v4/?expr', () => {

        // you can give domain meaning to your API requests by introducing
        const RequestToCalculateFormula = (formula: Answerable<string>) =>
            GetRequest.to('/v4').using(Question.fromObject({ params: { expr: formula } }))
                .describedAs(the`a request to calculate ${ formula }`)

        it('supports calculating a single formula', () =>
            actorCalled('Apisitt').attemptsTo(
                Send.a(RequestToCalculateFormula('2 + 2')),
                Ensure.that(LastResponse.body<number>(), equals(4)),    // wrong: equals(4) => equals(5)
            ));
    });

    describe('POST /v4', () => {

        const RequestToCalculateFormulas = (formulas: Answerable<string[]>, precision?: Answerable<number>) =>
            PostRequest.to(`/v4`).with(Question.fromObject({ expr: formulas, precision }))
                .describedAs(the`a request to calculate ${ formulas }`)

        interface CalculatedFormulas {
            result: string[] | string | null;
            error: string | null;
        }

        it('supports calculating multiple formulas in one request', () =>
            actorCalled('Apisitt').attemptsTo(

                Send.a(RequestToCalculateFormulas([ '2 + 2', '5 - 3' ])),

                // note that LastResponse.body is generic;
                // you can configure it with an interface specifying the shape of the expected response body
                Ensure.that(LastResponse.body<CalculatedFormulas>(), equals({
                    result: [ '4', '2' ],
                    error: null,            // eslint-disable-line unicorn/no-null
                })),
            ));
    });
});
