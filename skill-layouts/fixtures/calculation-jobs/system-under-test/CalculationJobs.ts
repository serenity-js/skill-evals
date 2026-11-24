// The system under test: a calculation service that the scenarios check, standing in for one that would run outside
// the project. It isn't part of the test code, so don't change it: reach it through the interfaces it offers, as its
// users would, with the abilities in src/.
/**
 * A calculation service that works through its jobs in the background, like a queue of long calculations.
 * It adds up the numbers in an expression such as "2 + 2", and the result is ready a moment after the job is submitted.
 */
export class CalculationJobs {
    private readonly results = new Map<string, string>();
    private nextId = 1;

    constructor(private readonly processingTimeInMilliseconds = 500) {
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
}

function sum(expression: string): number {
    return expression.split('+').map(term => Number(term.trim())).reduce((total, term) => total + term, 0);
}
