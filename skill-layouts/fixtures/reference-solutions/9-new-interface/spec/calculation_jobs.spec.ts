import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled, Wait } from '@serenity-js/core';

import { Role } from '../src/Role';

import { CalculateInBackground, ResultOfLastJob, StatusOfLastJob } from '../src/calculation-jobs';

describe('Calculation jobs', () => {

    it('calculate expressions in the background', () =>
        actorCalled(Role.Analyst).attemptsTo(
            CalculateInBackground('2 + 2'),
            Wait.until(StatusOfLastJob(), equals('done')),
            Ensure.that(ResultOfLastJob(), equals('4')),
        ));
});
