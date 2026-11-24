import { Ensure, equals, includes } from '@serenity-js/assertions';
import { Answerable, Question, Task, the } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

interface CalculatedExpressions {
    result: string[];
    error: string | null;
}

/** The API's answer to the last request to calculate expressions. */
export const Calculation = {
    error: () =>
        LastResponse.body<CalculatedExpressions>().error.describedAs('the error'),

    results: () =>
        LastResponse.body<CalculatedExpressions>().result.describedAs('the results'),

    firstResult: () =>
        LastResponse.body<CalculatedExpressions>().result[0].describedAs('the first result'),
};

export const CalculateToSignificantDigits = (expression: Answerable<string>, precision: Answerable<number>) =>
    Task.where(the`#actor calculates ${ expression } to ${ precision } significant digits`,
        Send.a(PostRequest.to('/v4').with(Question.fromObject({ expr: [ expression ], precision }))),
        Ensure.that(LastResponse.status(), equals(200)),
        Ensure.that(LastResponse.header('content-type'), includes('application/json')),
        Ensure.that(Calculation.error(), equals(null)),
        Ensure.that(Calculation.results().length, equals(1)),
    );
