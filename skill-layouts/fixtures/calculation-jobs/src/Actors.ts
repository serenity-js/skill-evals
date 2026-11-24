import { Actor, Cast, TakeNotes } from '@serenity-js/core';
import { CallAnApi } from '@serenity-js/rest';
import { ensure, isNotBlank } from 'tiny-types';

import { CalculationJobs } from '../system-under-test/CalculationJobs';
import { RunCalculationJobs } from './calculation-jobs';

export class Actors implements Cast {
    constructor(private readonly baseApiUrl: string) {
        ensure('apiUrl', baseApiUrl, isNotBlank());
    }

    prepare(actor: Actor): Actor {
        return actor.whoCan(
            CallAnApi.at(this.baseApiUrl),
            RunCalculationJobs.using(new CalculationJobs()),
            TakeNotes.usingAnEmptyNotepad()
        );
    }
}
