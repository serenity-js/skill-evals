import { Answerable, Interaction, Question, the } from '@serenity-js/core';

import { UseJobFiles } from './UseJobFiles';

export const SubmitAJobAsAFile = (name: Answerable<string>, expression: Answerable<string>) =>
    Interaction.where(the`#actor submits a job file ${ name } to calculate ${ expression }`, async actor => {
        const fileName = await actor.answer(name);
        const job = await actor.answer(expression);
        await UseJobFiles.as(actor).writeJob(fileName, job);
    });

export const ResultFile = (name: Answerable<string>) =>
    Question.about(the`the result file ${ name }`, async actor => {
        const fileName = await actor.answer(name);
        return UseJobFiles.as(actor).readResult(fileName);
    });
