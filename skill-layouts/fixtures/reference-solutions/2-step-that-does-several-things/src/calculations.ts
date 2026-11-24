import { Ensure, equals, not, startsWith } from '@serenity-js/assertions';
import { Answerable, Question, Task, the } from '@serenity-js/core';
import { GetRequest, LastResponse, Send } from '@serenity-js/rest';

// the API answers an expression it can't calculate with an error message, such as "Error: Unexpected end of expression"
const ResponseText = () =>
    LastResponse.body<number | string>().as(String)
        .describedAs('the response');

export const CalculateExpression = (expression: Answerable<string>) =>
    Task.where(the`#actor calculates ${ expression }`,
        Send.a(GetRequest.to('/v4').using(Question.fromObject({ params: { expr: expression } }))),
        Ensure.that(LastResponse.status(), equals(200)),
        Ensure.that(ResponseText(), not(startsWith('Error'))),
    );
