import { Actor, Cast, TakeNotes } from '@serenity-js/core';
import { CallAnApi } from '@serenity-js/rest';
import { ensure, isNotBlank } from 'tiny-types';

import { CalculationJobs, RunCalculationJobs } from './calculation-jobs';

export class Actors implements Cast {
    private readonly jobs: CalculationJobs;

    constructor(private readonly baseApiUrl: string) {
        ensure('apiUrl', baseApiUrl, isNotBlank());
        this.jobs = new CalculationJobs(process.env.JOBS_DIR ?? '', process.env.RESULTS_DIR ?? '');
    }

    prepare(actor: Actor): Actor {
        return actor.whoCan(
            CallAnApi.at(this.baseApiUrl),
            RunCalculationJobs.using(this.jobs),
            TakeNotes.usingAnEmptyNotepad()
        );
    }
}
