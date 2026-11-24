import { Ability } from '@serenity-js/core';

import { CalculationJobs } from '../../system-under-test/CalculationJobs';

export class RunCalculationJobs extends Ability {
    static using(jobs: CalculationJobs): RunCalculationJobs {
        return new RunCalculationJobs(jobs);
    }

    private lastJobId: string | undefined;

    constructor(private readonly jobs: CalculationJobs) {
        super();
    }

    submit(expression: string): void {
        this.lastJobId = this.jobs.submit(expression);
    }

    statusOfLastJob(): string {
        return this.lastJobId ? this.jobs.status(this.lastJobId) : 'none';
    }

    resultOfLastJob(): string | undefined {
        return this.lastJobId ? this.jobs.result(this.lastJobId) : undefined;
    }
}
