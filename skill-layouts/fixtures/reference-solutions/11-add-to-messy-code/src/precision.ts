import { Ensure, equals, includes } from '@serenity-js/assertions';
import { Answerable, Question, Task, the } from '@serenity-js/core';
import { LastResponse, PostRequest, Send } from '@serenity-js/rest';

export const PostAndCheck = (expression: string, precision: number, expected: string) =>
    Task.where(`#actor posts ${ expression } and checks it`,
        Send.a(PostRequest.to('/v4').with({ expr: [ expression ], precision })),
        Ensure.that(LastResponse.status(), equals(200)),
        Ensure.that(LastResponse.header('content-type'), includes('application/json')),
        Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().error, equals(null)),
        Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result.length, equals(1)),
        Ensure.that(LastResponse.body<{ result: string[], error: string | null }>().result[0], equals(expected)),
        Send.a(PostRequest.to('/v4').with({ expr: [ expression ] })),
        Ensure.that(LastResponse.status(), equals(200)),
    );

export const CalculateToSignificantDigits = (expression: Answerable<string>, precision: Answerable<number>) =>
    Task.where(the`#actor calculates ${ expression } to ${ precision } significant digits`,
        Send.a(PostRequest.to('/v4').with(Question.fromObject({ expr: [ expression ], precision }))),
        Ensure.that(LastResponse.status(), equals(200)),
    );
