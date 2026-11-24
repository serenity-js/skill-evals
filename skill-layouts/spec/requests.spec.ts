import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { evalRoot } from '../src/layouts.ts';
import { loadRequests, parseRequests, promptFor } from '../src/requests.ts';

describe('the requests', () => {

    const { requests } = loadRequests();
    const control = requests.find(request => request.needs.length === 0)!;

    it('have one control, which needs no building block', () => {
        expect(requests.filter(request => request.needs.length === 0).map(request => request.id)).toEqual([ '8-control' ]);
    });

    it("give the control a change that no skill covers: not the tests, the scenarios or their configuration", () => {
        expect(control.prompt).toMatch(/README/);
        expect(control.prompt).not.toMatch(/test|scenario|step|timeout|mocha|serenity|actor|task|question/i);
    });

    it('say which of the APIs each request needs, so a network failure is only one of those: request 4 needs both, the rest only math.js', () => {
        const { heldBack } = loadRequests();

        expect(Object.fromEntries([ ...requests, ...heldBack ].map(request => [ request.id, request.apis ]))).toEqual({
            '1-new-feature': [ 'mathjs' ],
            '2-step-that-does-several-things': [ 'mathjs' ],
            '3-check-a-value': [ 'mathjs' ],
            '4-new-http-api': [ 'mathjs', 'frankfurter' ],
            '5-step-that-does-not-wait': [ 'mathjs' ],
            '6-duplication': [ 'mathjs' ],
            '7-rename-a-concept': [ 'mathjs' ],
            '8-control': [ 'mathjs' ],
            '9-new-interface': [ 'mathjs' ],
            '10-check-each': [ 'mathjs' ],
            '11-add-to-messy-code': [ 'mathjs' ],
            '12-check-a-value': [ 'mathjs' ],
            '13-new-feature': [ 'mathjs' ],
        });
    });

    it('say which building blocks each request needs', () => {
        const { heldBack } = loadRequests();

        expect(Object.fromEntries([ ...requests, ...heldBack ].map(request => [ request.id, request.needs ]))).toEqual({
            '1-new-feature': [ 'tests' ],
            '2-step-that-does-several-things': [ 'tasks', 'questions' ],
            '3-check-a-value': [ 'questions', 'tests' ],
            // @serenity-js/rest's CallAnApi covers any HTTP API, so the right answer adds no ability or interaction
            '4-new-http-api': [ 'questions', 'tests' ],
            // the smallest fix waits in the task, with the fixture's question, and leaves the scenario as it is
            '5-step-that-does-not-wait': [ 'tasks' ],
            // the refactoring "Refactor what's there" describes: tasks for the steps, and a grouped object for the values read in several places
            '6-duplication': [ 'tasks', 'questions' ],
            '7-rename-a-concept': [ 'tests' ],
            '8-control': [],
            // no Serenity/JS integration reads or writes files, so the right answer adds an ability, an interaction and a question
            '9-new-interface': [ 'abilities', 'interactions', 'questions', 'tests' ],
            // a new scenario that repeats its activities for each example with List.of().forEach, which the tasks skill covers
            '10-check-each': [ 'tasks', 'tests' ],
            // a new scenario, with a new task; it checks the result as the file's scenarios read it
            '11-add-to-messy-code': [ 'tasks', 'tests' ],
            '12-check-a-value': [ 'questions', 'tests' ],
            '13-new-feature': [ 'tests' ],
        });
    });

    it('ask for an interface no Serenity/JS integration covers in request 9: submitting a calculation job as a file in JOBS_DIR, and checking its result file in RESULTS_DIR', () => {
        const request9 = requests.find(request => request.id === '9-new-interface')!;

        expect(request9).toMatchObject({
            kind: 'Use an interface no Serenity/JS integration covers',
            prompt: 'The calculation jobs service also accepts jobs as files: it picks up an expression written to a file in the directory given by JOBS_DIR, and writes the result to a file of the same name in the directory given by RESULTS_DIR. Add a scenario that submits a job by writing a file, and checks the result file.',
            fixture: 'calculation-job-results',
        });
    });

    it('ask for a scenario that checks a list of examples in request 10, which List.of().forEach repeats its activities for', () => {
        const request10 = requests.find(request => request.id === '10-check-each')!;

        expect(request10).toMatchObject({
            kind: 'Repeat the same check for each item of a list',
            prompt: 'Add a scenario that checks these expressions give these results: 2 + 2 is 4, 10 / 4 is 2.5, 3 * 3 is 9.',
        });
        expect(request10.fixture).toBeUndefined();
    });

    it("ask request 11 to add a scenario to request 6's file with poor abstractions, with request 6's fixture", () => {
        expect(requests.find(request => request.id === '11-add-to-messy-code')).toMatchObject({
            kind: 'Add to code with poor abstractions',
            prompt: 'Add a scenario to spec/precision.spec.ts that checks 2 / 3 rounded to 3 significant digits.',
            fixture: 'precision',
        });
    });

    it('hold back requests 12 and 13, of the same kinds as requests 3 and 1', () => {
        const { heldBack } = loadRequests();

        expect(heldBack.map(({ id, kind }) => [ id, kind ])).toEqual([
            [ '12-check-a-value', requests.find(request => request.id === '3-check-a-value')!.kind ],
            [ '13-new-feature', requests.find(request => request.id === '1-new-feature')!.kind ],
        ]);
    });

    it("give request 6 a fixture with poor abstractions: scenarios made of Send and Ensure calls, and a task named after its mechanics that strings together eight interactions", () => {
        const fixture = join(evalRoot, 'fixtures', 'precision');
        const scenarios = readFileSync(join(fixture, 'spec', 'precision.spec.ts'), 'utf8');
        const task = readFileSync(join(fixture, 'src', 'precision.ts'), 'utf8');

        expect(scenarios.match(/\bit\(/g)).toHaveLength(3);
        expect(scenarios).not.toMatch(/PostAndCheck|Task\.where/);
        expect(scenarios.match(/^\s+(Send\.a|Ensure\.that)\(/gm)!.length).toBeGreaterThanOrEqual(15);
        const body = /export const PostAndCheck =[\s\S]*?Task\.where\([^,]+,([\s\S]*?)\n {4}\);/.exec(task)![1];
        expect(body.match(/^\s+(Send\.a|Ensure\.that)\(/gm)).toHaveLength(8);
    });

    it('have a directory in fixtures/ for each fixture they name', () => {
        const { heldBack } = loadRequests();

        for (const { fixture } of [ ...requests, ...heldBack ].filter(request => request.fixture)) {
            expect(existsSync(join(evalRoot, 'fixtures', fixture!)), fixture).toBe(true);
        }
    });

    it("name the local server's Frankfurter URL in request 4 through a placeholder, which the harness fills in per run", () => {
        const request4 = requests.find(request => request.id === '4-new-http-api')!;

        expect(request4.prompt).toContain('{{frankfurter}}/latest?base=EUR&symbols=USD');
        expect(requests.map(request => request.prompt).join(' ')).not.toMatch(/api\.frankfurter\.dev|api\.mathjs\.org/);
        expect(promptFor(request4, { mathjs: 'http://127.0.0.1:4567/v4/', frankfurter: 'http://127.0.0.1:4567/v1' }))
            .toContain('at http://127.0.0.1:4567/v1/latest?base=EUR&symbols=USD,');
    });

    it('refuses an API the local server has no stand-in for', () => {
        const json = JSON.stringify({ requests: [ { id: 'x', kind: '', prompt: 'p', needs: [], apis: [ 'example' ] } ], heldBack: [] });

        expect(() => parseRequests(json)).toThrow(/example, which the local API server doesn't serve/);
    });
});
