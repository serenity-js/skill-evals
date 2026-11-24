import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';
import { randomUUID } from 'crypto';

import { ResultFile, SubmitAJobAsAFile } from '../src/job-files';
import { Role } from '../src/Role';

describe('Calculation jobs submitted as files', () => {

    it('write their result to a file of the same name', () => {
        // unique to this run, so a result file left by an earlier run can't make the scenario pass
        const jobFile = `job-${ randomUUID() }`;

        return actorCalled(Role.Analyst).attemptsTo(
            SubmitAJobAsAFile(jobFile, '3 + 4'),
            Ensure.eventually(ResultFile(jobFile), equals('7')),    // wrong: '7' => '8'
        );
    });
});
