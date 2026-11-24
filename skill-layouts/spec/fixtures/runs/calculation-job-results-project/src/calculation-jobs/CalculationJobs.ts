import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensure, isNotBlank } from 'tiny-types';

/**
 * A calculation service that works through its jobs in the background, like a queue of long calculations.
 * It adds up the numbers in an expression such as "2 + 2", and the result is ready a moment after the job is submitted.
 *
 * It also accepts jobs as files: it picks up an expression written to a file in `jobsDirectory`, and writes the result
 * to a file of the same name in `resultsDirectory`.
 */
export class CalculationJobs {
    private readonly results = new Map<string, string>();
    private readonly jobFilesPickedUp = new Set<string>();
    private nextId = 1;

    constructor(
        private readonly jobsDirectory: string,
        private readonly resultsDirectory: string,
        private readonly processingTimeInMilliseconds = 500,
        pollingIntervalInMilliseconds = 100,
    ) {
        ensure('jobsDirectory', jobsDirectory, isNotBlank());
        ensure('resultsDirectory', resultsDirectory, isNotBlank());
        mkdirSync(jobsDirectory, { recursive: true });
        mkdirSync(resultsDirectory, { recursive: true });
        // unref, so that the service doesn't keep the test run going once its scenarios are done
        setInterval(() => this.pickUpJobFiles(), pollingIntervalInMilliseconds).unref();
    }

    submit(expression: string): string {
        const id = `job-${ this.nextId++ }`;
        setTimeout(() => this.results.set(id, String(sum(expression))), this.processingTimeInMilliseconds);
        return id;
    }

    status(id: string): 'pending' | 'done' {
        return this.results.has(id) ? 'done' : 'pending';
    }

    result(id: string): string | undefined {
        return this.results.get(id);
    }

    private pickUpJobFiles(): void {
        if (! existsSync(this.jobsDirectory)) {
            return;
        }
        for (const entry of readdirSync(this.jobsDirectory, { withFileTypes: true })) {
            if (! entry.isFile() || this.jobFilesPickedUp.has(entry.name)) {
                continue;
            }
            const expression = readFileSync(join(this.jobsDirectory, entry.name), 'utf8').trim();
            // a file that's still being written gets picked up on the next poll
            if (! expression) {
                continue;
            }
            this.jobFilesPickedUp.add(entry.name);
            setTimeout(() => {
                mkdirSync(this.resultsDirectory, { recursive: true });
                writeFileSync(join(this.resultsDirectory, entry.name), String(sum(expression)));
            }, this.processingTimeInMilliseconds);
        }
    }
}

function sum(expression: string): number {
    return expression.split('+').map(term => Number(term.trim())).reduce((total, term) => total + term, 0);
}
