import { equals } from '@serenity-js/assertions';
import { Answerable, Interaction, Question, Task, the, Wait } from '@serenity-js/core';

import { RunCalculationJobs } from './RunCalculationJobs';

const SubmitAJob = (expression: Answerable<string>) =>
    Interaction.where(the`#actor submits a job to calculate ${ expression }`, async actor => {
        RunCalculationJobs.as(actor).submit(await actor.answer(expression));
    });

export const CalculateInBackground = (expression: Answerable<string>) =>
    Task.where(the`#actor calculates ${ expression } in the background`,
        SubmitAJob(expression),
        Wait.until(StatusOfLastJob(), equals('done')),    // wrong: 'done' => 'pending'
    );

export const StatusOfLastJob = () =>
    Question.about('the status of the last job', actor =>
        RunCalculationJobs.as(actor).statusOfLastJob()
    );

export const ResultOfLastJob = () =>
    Question.about('the result of the last job', actor =>
        RunCalculationJobs.as(actor).resultOfLastJob()
    );
