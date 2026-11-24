import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { summariseResults } from '../src/cli.ts';
import { compareResults } from '../src/compare.ts';
import { readPlan, readRecord, readScores } from '../src/records.ts';
import type { PlannedRun } from '../src/review.ts';
import { loadConfig } from '../src/runs.ts';

const kiroRun: PlannedRun = { id: 'aaaa0001', agent: 'kiro', layout: 'b', request: '11-add-to-messy-code', repeat: 1 };
const copilotRun: PlannedRun = { id: 'bbbb0001', agent: 'copilot', layout: 'none', request: '11-add-to-messy-code', repeat: 1 };

// the fields every result.json has, from the first pilot's on, and that the summary reads from each
const record = {
    id: 'aaaa0001', outcome: 'correct', checks: [ { item: 'checks', verdict: 'pass', evidence: [] } ], skillReads: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, durationMs: 1, timedOut: false, modelUnreported: false,
};

describe('the files the harness reads', () => {

    let directory: string;
    const write = (name: string, content: unknown) => {
        const file = join(directory, name);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
        return file;
    };

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-records-'));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    describe('readPlan', () => {

        it("reads mapping.json's planned runs, of the given agents only", () => {
            write('mapping.json', [ kiroRun, copilotRun ]);

            expect(readPlan(directory)).toEqual([ kiroRun, copilotRun ]);
            expect(readPlan(directory, [ 'copilot' ])).toEqual([ copilotRun ]);
        });

        it("names the file when it isn't JSON", () => {
            const file = write('mapping.json', '[ { "id": ');

            expect(() => readPlan(directory)).toThrow(new RegExp(`^${ file } isn't JSON: `));
        });

        it("names the file when it isn't a list", () => {
            const file = write('mapping.json', { runs: [ kiroRun ] });

            expect(() => readPlan(directory)).toThrow(`${ file }: the file is {"runs":[{"id":"aaaa0001","agent":"kiro","layout":"b","reque…, not a list`);
        });

        it.each([
            [ 'a missing id', { ...kiroRun, id: undefined }, '[0].id is missing' ],
            [ 'an agent that is not one', { ...kiroRun, agent: 'claude' }, '[0].agent is "claude", not one of kiro, copilot' ],
            [ 'a layout that is not one', { ...kiroRun, layout: 'd' }, '[0].layout is "d", not one of none, a, b, c' ],
            [ 'a missing request', { ...kiroRun, request: undefined }, '[0].request is missing' ],
            [ 'a repeat that is not a whole number', { ...kiroRun, repeat: '1' }, '[0].repeat is "1", not a whole number, 1 or more' ],
        ])('names the field and the file for %s', (_, run, problem) => {
            const file = write('mapping.json', [ run ]);

            expect(() => readPlan(directory)).toThrow(`${ file }: ${ problem }`);
        });
    });

    describe('readRecord', () => {

        it('reads a run\'s result.json', () => {
            const file = write('result.json', record);

            expect(readRecord(file)).toEqual(record);
        });

        it.each([
            [ 'a missing outcome', { ...record, outcome: undefined }, 'outcome is missing' ],
            [ 'an outcome that is not one', { ...record, outcome: 'passed' }, 'outcome is "passed", not one of correct, incorrect, network-failure, agent-failure' ],
            [ 'checks that are not a list', { ...record, checks: {} }, 'checks is {}, not a list' ],
            [ 'a verdict that is not one', { ...record, checks: [ { item: 'checks', verdict: 'ok', evidence: [] } ] }, 'checks[0].verdict is "ok", not one of pass, fail, n/a' ],
            [ 'missing skill reads', { ...record, skillReads: undefined }, 'skillReads is missing' ],
            [ 'a skill read without its file', { ...record, skillReads: [ { via: 'read' } ] }, 'skillReads[0].file is missing' ],
            [ 'a duration that is not a number', { ...record, durationMs: '1' }, 'durationMs is "1", not a number' ],
            [ 'a missing duration', { ...record, durationMs: undefined }, 'durationMs is missing' ],
            [ 'missing tokens', { ...record, tokens: undefined, tokensReported: true }, 'tokens is missing' ],
            [ 'tokens without their output', { ...record, tokens: { input: 0, cacheRead: 0, cacheWrite: 0 } }, 'tokens.output is missing' ],
            [ 'a missing timeout', { ...record, timedOut: undefined }, 'timedOut is missing' ],
            [ 'a missing model unreported', { ...record, modelUnreported: undefined }, 'modelUnreported is missing' ],
            [ 'models that are not names', { ...record, models: [ 1 ] }, 'models[0] is 1, not a string' ],
            [ 'a timeout that is not true or false', { ...record, timedOut: 'no' }, 'timedOut is "no", not true or false' ],
        ])('names the field and the file for %s', (_, content, problem) => {
            const file = write('result.json', content);

            expect(() => readRecord(file)).toThrow(`${ file }: ${ problem }`);
        });
    });

    describe('readScores', () => {

        it("reads the reviewer's scores, and none where there's no scores.json yet", () => {
            const file = write('scores.json', { aaaa0001: { structure: 'pass', checks: '' } });

            expect(readScores(file)).toEqual({ aaaa0001: { structure: 'pass', checks: '' } });
            expect(readScores(join(directory, 'no-such', 'scores.json'))).toEqual({});
        });

        it.each([
            [ 'a list', [], 'the file is [], not an object' ],
            [ "a run's scores that are not an object", { aaaa0001: 'pass' }, 'aaaa0001 is "pass", not an object' ],
            [ 'a verdict that is not a string', { aaaa0001: { structure: true } }, 'aaaa0001.structure is true, not a string' ],
        ])('names the field and the file for %s', (_, content, problem) => {
            const file = write('scores.json', content);

            expect(() => readScores(file)).toThrow(`${ file }: ${ problem }`);
        });
    });

    describe('loadConfig', () => {

        const config = { models: { kiro: 'claude-sonnet-5.5', copilot: 'auto' }, template: { commit: 'abc' }, apiServer: { port: 4170 }, runTimeoutMinutes: 30, testTimeoutMinutes: 10 };

        it('reads config.json', () => {
            write('config.json', config);

            expect(loadConfig(directory)).toEqual(config);
        });

        it.each([
            [ "a missing agent's model", { ...config, models: { kiro: 'claude-sonnet-5.5' } }, 'models.copilot is missing' ],
            [ 'a missing template commit', { ...config, template: {} }, 'template.commit is missing' ],
            [ 'a port that is not one', { ...config, apiServer: { port: '4170' } }, 'apiServer.port is "4170", not a port, 1 to 65535' ],
            [ 'a timeout that is not a number of minutes', { ...config, runTimeoutMinutes: 0 }, 'runTimeoutMinutes is 0, not a number of minutes, more than 0' ],
        ])('names the field and the file for %s', (_, content, problem) => {
            const file = write('config.json', content);

            expect(() => loadConfig(directory)).toThrow(`${ file }: ${ problem }`);
        });
    });

    describe('where the results are read', () => {

        it('--compare names the field and the file of a result.json it cannot use', () => {
            write('mapping.json', [ kiroRun ]);
            const file = write(`runs/${ kiroRun.id }/result.json`, { ...record, skillReads: undefined });

            expect(() => compareResults(directory)).toThrow(`${ file }: skillReads is missing`);
        });

        it('--compare names the field and the file of a mapping.json it cannot use', () => {
            const file = write('mapping.json', [ { ...kiroRun, layout: undefined } ]);

            expect(() => compareResults(directory)).toThrow(`${ file }: [0].layout is missing`);
        });

        it("--summarise names the file of a scores.json it cannot use", () => {
            write('mapping.json', [ kiroRun ]);
            write(`runs/${ kiroRun.id }/result.json`, record);
            const file = write('review/scores.json', { [kiroRun.id]: 'pass' });

            expect(() => summariseResults(directory)).toThrow(`${ file }: aaaa0001 is "pass", not an object`);
        });
    });
});
