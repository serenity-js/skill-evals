import 'mocha';

import { Ensure, equals } from '@serenity-js/assertions';
import { actorCalled } from '@serenity-js/core';

import { CalculateInBackground, ResultOfLastJob } from '../src/calculation-jobs';

describe('Calculation jobs', () => {

    it('calculate expressions in the background', () =>
        actorCalled('Jobson').attemptsTo(
            CalculateInBackground('2 + 2'),
            Ensure.that(ResultOfLastJob(), equals('4')),
        ));
});
