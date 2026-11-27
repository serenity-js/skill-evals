import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Results, runFiles } from '../src/results.ts';
import type { PlannedRun } from '../src/review.ts';
import type { RunRecord } from '../src/runs.ts';
import { Work } from '../src/work.ts';

const record = (id: string): RunRecord => ({
    id, outcome: 'correct', tsc: { exitCode: 0 }, test: { exitCode: 0 }, loading: undefined, skillReads: [], checks: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, durationMs: 1, agentExitCode: 0, timedOut: false, testAttempts: 1,
    unreachable: [], costUsd: undefined, tokensReported: false, credits: undefined, models: [ 'claude-sonnet-5.5' ], modelAnswered: true, modelUnreported: false, agentVersion: '',
});

describe('Results', () => {

    it("keeps each mode's results in a directory of its own in --out", () => {
        expect(Results.of('/out', { mode: 'pilot' }).directory).toBe('/out/pilot');
        expect(Results.of('/out', { mode: 'full' }).directory).toBe('/out/full');
        expect(Results.of('/out', { mode: 'smoke' }).directory).toBe('/out/smoke');
        expect(Results.of('/out', { mode: 'held-back', layout: 'b' }).directory).toBe('/out/held-back-b');
        expect(Results.ofReferences('/out').directory).toBe('/out/check-references');
    });

    it('lays out the files of the results as the evaluations recorded so far have them', () => {
        const results = new Results('/out/pilot');

        expect(results).toMatchObject({
            review: '/out/pilot/review',
            conditionsFile: '/out/pilot/conditions.json',
            summaryMarkdown: '/out/pilot/summary.md',
            compareMarkdown: '/out/pilot/compare.md',
        });
        expect(results.reviewPacket('3f9c2a1e')).toBe('/out/pilot/review/3f9c2a1e.md');
        expect(results.savedLockfile('b')).toBe('/out/pilot/layouts/b/package-lock.json');
        expect(results.referenceLogs('9-new-interface')).toBe('/out/pilot/9-new-interface');
        expect(results.referenceServerLog('9-new-interface')).toBe('/out/pilot/9-new-interface/server.jsonl');
    });

    it("lays out a run's files in its directory, runs/<id>", () => {
        const { read: _read, testAttemptLog, ...files } = new Results('/out/pilot').run('3f9c2a1e');

        expect(files).toEqual({
            directory: '/out/pilot/runs/3f9c2a1e',
            result: '/out/pilot/runs/3f9c2a1e/result.json',
            stream: '/out/pilot/runs/3f9c2a1e/stream.jsonl',
            agentLog: '/out/pilot/runs/3f9c2a1e/agent.log',
            diff: '/out/pilot/runs/3f9c2a1e/diff.patch',
            reply: '/out/pilot/runs/3f9c2a1e/reply.md',
            serverLog: '/out/pilot/runs/3f9c2a1e/server.jsonl',
            tscLog: '/out/pilot/runs/3f9c2a1e/tsc.log',
            testLog: '/out/pilot/runs/3f9c2a1e/test.log',
            rescored: {
                tscLog: '/out/pilot/runs/3f9c2a1e/tsc.rescored.log',
                testLog: '/out/pilot/runs/3f9c2a1e/test.rescored.log',
                serverLog: '/out/pilot/runs/3f9c2a1e/server.rescored.jsonl',
            },
        });
        expect(testAttemptLog(2)).toBe('/out/pilot/runs/3f9c2a1e/test.2.log');
        expect(runFiles('/out/pilot/runs/3f9c2a1e').result).toBe(files.result);
    });

    describe('in a directory', () => {

        let directory: string;
        let results: Results;
        const planned: PlannedRun[] = [
            { id: 'bbbb0001', agent: 'copilot', layout: 'b', request: '9-new-interface', repeat: 1 },
            { id: 'aaaa0001', agent: 'kiro', layout: 'none', request: '9-new-interface', repeat: 1 },
            { id: 'cccc0001', agent: 'kiro', layout: 'b', request: '9-new-interface', repeat: 1 },
        ];

        beforeEach(() => {
            directory = mkdtempSync(join(tmpdir(), 'skill-layouts-results-'));
            results = new Results(directory);
        });
        afterEach(() => rmSync(directory, { recursive: true, force: true }));

        it('writes JSON indented by two spaces, with a final newline, as every file of the results has it', () => {
            results.savePlan(planned);
            // a run's directory is there before its result, which saving it doesn't create
            mkdirSync(join(directory, 'runs', 'aaaa0001'), { recursive: true });
            results.saveResult('aaaa0001', record('aaaa0001'));

            expect(readFileSync(join(directory, 'mapping.json'), 'utf8')).toBe(`${ JSON.stringify(planned, null, 2) }\n`);
            expect(readFileSync(join(directory, 'runs', 'aaaa0001', 'result.json'), 'utf8')).toBe(`${ JSON.stringify(record('aaaa0001'), null, 2) }\n`);
        });

        it("reads back the plan, and the planned runs with a result, in the plan's order", () => {
            results.savePlan(planned);
            for (const id of [ 'cccc0001', 'bbbb0001' ]) {
                mkdirSync(join(directory, 'runs', id), { recursive: true });
                results.saveResult(id, record(id));
            }

            expect(results.hasPlan()).toBe(true);
            expect(results.plan([ 'kiro' ])).toEqual([ planned[1], planned[2] ]);
            expect(results.scored(results.plan()).map(({ run, record }) => [ run.id, record.id ])).toEqual([ [ 'bbbb0001', 'bbbb0001' ], [ 'cccc0001', 'cccc0001' ] ]);
        });

        it("reads a run's diff, reply and stream, and nothing where the run has none", () => {
            mkdirSync(join(directory, 'runs', 'aaaa0001'), { recursive: true });
            writeFileSync(join(directory, 'runs', 'aaaa0001', 'diff.patch'), '+ added');

            expect(results.run('aaaa0001').read('diff')).toBe('+ added');
            expect(results.run('aaaa0001').read('reply')).toBeUndefined();
            expect(results.run('aaaa0001').read('stream')).toBeUndefined();
        });

        it('has no plan, scores or conditions before the evaluation saves them', () => {
            expect(results.hasPlan()).toBe(false);
            expect(results.hasScores()).toBe(false);
            expect(results.scores()).toEqual({});
            expect(results.conditions()).toBeUndefined();
        });

        it('creates the review directory for the scores it saves', () => {
            results.saveScores({ aaaa0001: { checks: '' } });

            expect(results.hasScores()).toBe(true);
            expect(readFileSync(join(directory, 'review', 'scores.json'), 'utf8')).toBe(`${ JSON.stringify({ aaaa0001: { checks: '' } }, null, 2) }\n`);
        });

        it('writes the summary, as JSON and as markdown, and compare.md, as markdown', () => {
            results.saveSummary({ runs: 1 }, '# Summary\n');
            results.saveCompare('# Compared\n');

            expect(readFileSync(join(directory, 'summary.json'), 'utf8')).toBe('{\n  "runs": 1\n}\n');
            expect(readFileSync(join(directory, 'summary.md'), 'utf8')).toBe('# Summary\n');
            expect(readFileSync(join(directory, 'compare.md'), 'utf8')).toBe('# Compared\n');
        });
    });
});

describe('Work', () => {

    it('lays out the work directory as the evaluations so far have it', () => {
        const work = new Work('/work');

        expect(work.run('3f9c2a1e')).toBe('/work/runs/3f9c2a1e');
        expect(work.homes('3f9c2a1e')).toBe('/work/homes/3f9c2a1e');
        expect(work.npmCache).toBe('/work/npm-cache');
        expect(work.layout('b')).toEqual({ project: '/work/layouts/b/project', examples: '/work/layouts/b/examples', templateArchive: '/work/layouts/b/template.tar' });
        expect(work.tarballs('packed')).toBe('/work/tarballs/packed');
        expect(work.reference('9-new-interface')).toBe('/work/references/9-new-interface');
        expect(work.rescoredChecks('3f9c2a1e')).toBe('/work/rescore-checks/3f9c2a1e');
    });
});
