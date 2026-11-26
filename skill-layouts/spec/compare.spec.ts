import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments } from '../src/cli.ts';
import { compareResults } from '../src/compare.ts';
import type { PlannedRun } from '../src/review.ts';
import type { RunRecord } from '../src/runs.ts';

const runs: PlannedRun[] = [
    { id: 'aaaa0001', agent: 'kiro', layout: 'none', request: '11-add-to-messy-code', repeat: 1 },
    { id: 'aaaa0002', agent: 'copilot', layout: 'none', request: '11-add-to-messy-code', repeat: 1 },
    { id: 'bbbb0001', agent: 'kiro', layout: 'b', request: '11-add-to-messy-code', repeat: 1 },
    { id: 'bbbb0002', agent: 'copilot', layout: 'b', request: '11-add-to-messy-code', repeat: 1 },
    { id: 'cccc0001', agent: 'kiro', layout: 'b', request: '9-new-interface', repeat: 1 },
];

const record = (id: string, fields: Partial<RunRecord>): RunRecord => ({
    id, outcome: 'correct', tsc: { exitCode: 0 }, test: { exitCode: 0 }, loading: undefined, skillReads: [], checks: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, durationMs: 1, agentExitCode: 0, timedOut: false, testAttempts: 1,
    unreachable: [], costUsd: undefined, tokensReported: false, credits: undefined, models: [ 'claude-sonnet-5.5' ], modelAnswered: true, modelUnreported: false, agentVersion: '',
    ...fields,
});

describe('compareResults', () => {

    let results: string;

    const write = (path: string, content: string) => {
        mkdirSync(join(results, path, '..'), { recursive: true });
        writeFileSync(join(results, path), content);
    };

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-compare-'));
        write('mapping.json', JSON.stringify(runs));
        write('runs/aaaa0001/result.json', JSON.stringify(record('aaaa0001', {
            checks: [ { item: 'checks', verdict: 'pass', evidence: [] }, { item: 'awaiting', verdict: 'pass', evidence: [] }, { item: 'actor-names', verdict: 'fail', evidence: [] } ],
        })));
        write('runs/aaaa0001/diff.patch', "+    it('rounds two thirds', () =>\n+        PostAndCheck('2 / 3', 3, '0.667'))");
        write('runs/aaaa0001/reply.md', 'Added the scenario.\n');
        write('runs/aaaa0002/result.json', JSON.stringify(record('aaaa0002', {
            outcome: 'incorrect',
            checks: [ { item: 'checks', verdict: 'fail', evidence: [] }, { item: 'awaiting', verdict: 'pass', evidence: [] } ],
        })));
        write('runs/aaaa0002/diff.patch', '+    broken');
        write('runs/bbbb0001/result.json', JSON.stringify(record('bbbb0001', {
            checks: [ { item: 'checks', verdict: 'pass', evidence: [] }, { item: 'awaiting', verdict: 'n/a', evidence: [] } ],
            skillReads: [ { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' }, { file: 'serenity-js-screenplay/references/tasks.md', via: 'read' }, { file: 'serenity-js-screenplay/references/tasks.md', via: 'shell' } ],
        })));
        write('runs/bbbb0001/diff.patch', "+        CalculateToSignificantDigits('2 / 3', 3),");
        write('runs/bbbb0001/reply.md', 'Added the scenario with a task. Suggestions: replace PostAndCheck.\n');
        write('runs/cccc0001/result.json', JSON.stringify(record('cccc0001', {})));
        // bbbb0002 has no result yet
        write('review/scores.json', JSON.stringify({ aaaa0001: { 'no-copied-abstractions': 'fail' }, bbbb0001: { 'no-copied-abstractions': 'pass', 'awaiting': 'pass' } }));
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    const section = (markdown: string, request: string) => {
        const start = markdown.indexOf(`## ${ request }\n`);
        const end = markdown.indexOf('\n## ', start + 1);
        return markdown.slice(start, end === -1 ? undefined : end);
    };

    it('says how many of the planned runs have a result, and has a section per request', () => {
        const compared = compareResults(results);

        expect(compared).toContain('4 of the 5 planned runs have a result.');
        expect(compared.indexOf('## 9-new-interface\n')).toBeGreaterThan(-1);
        expect(compared.indexOf('## 11-add-to-messy-code\n')).toBeGreaterThan(compared.indexOf('## 9-new-interface\n'));
    });

    it("covers only that agent's planned runs with an agent, and says which agent it covers", () => {
        const compared = compareResults(results, { agent: 'kiro' });

        expect(compared).toContain("kiro's runs only: 3 of its 3 planned runs have a result.");
        // aaaa0002, copilot's run of layout none, has a result, but isn't counted
        expect(section(compared, '11-add-to-messy-code')).toContain('| Runs with a result | 1 | 1 |');
        expect(section(compared, '11-add-to-messy-code')).toContain('run aaaa0001, kiro');
        expect(compared).not.toContain('aaaa0002');
    });

    it("leaves out a layout or a request only the other agent's plan has, with an agent", () => {
        write('mapping.json', JSON.stringify([ ...runs, { id: 'dddd0001', agent: 'copilot', layout: 'c', request: '9-new-interface', repeat: 1 } ]));

        expect(section(compareResults(results, { agent: 'kiro' }), '9-new-interface')).toContain('| | b |\n');
        expect(section(compareResults(results), '9-new-interface')).toContain('| | b | c |\n');
    });

    it('says a pilot with fewer runs per layout than the decision rule needs is too small to decide', () => {
        expect(compareResults(results)).toContain('Too small to decide: 1 run per layout per agent, and the decision rule needs 33.');
    });

    it("doesn't, once every layout has as many runs per agent as the rule needs", () => {
        const full: PlannedRun[] = [ 'none', 'b' ].flatMap(layout => Array.from({ length: 33 }, (_, index) =>
            ({ id: `${ layout }${ String(index).padStart(7, '0') }`, agent: 'kiro' as const, layout: layout as 'none' | 'b', request: '11-add-to-messy-code', repeat: index + 1 })));
        write('mapping.json', JSON.stringify(full));
        for (const run of full) {
            write(`runs/${ run.id }/result.json`, JSON.stringify(record(run.id, {})));
        }

        expect(compareResults(results)).not.toContain('Too small to decide');
    });

    it("covers every agent's planned runs without an agent, and says so", () => {
        expect(compareResults(results)).toContain("Every agent's runs: 4 of the 5 planned runs have a result.");
    });

    it("gives each layout's runs, correct runs, and how often each checklist item the request exercises passed, with the reviewer's verdicts over the patterns'", () => {
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| | none | b |');
        expect(request11).toContain('| Runs with a result | 2 | 1 |');
        expect(request11).toContain('| Correct | 1 of 2 | 1 of 1 |');
        expect(request11).toContain('| `checks` | 1 of 2 | 1 of 1 |');
        expect(request11).toContain('| `awaiting` | 2 of 2 | 1 of 1 |');
        expect(request11).toContain('| `no-copied-abstractions` | 0 of 1 | 1 of 1 |');
        // request 11 doesn't exercise actor-names, so it's in the other items, below
        expect(request11.slice(request11.indexOf('| | none | b |'), request11.indexOf('| Other item'))).not.toContain('`actor-names`');
        // the reviewer hasn't scored suggested-the-rest, which only they score
        expect(request11).toContain('| `suggested-the-rest` | n/a | n/a |');
    });

    it("leaves runs that couldn't reach the scenarios' APIs out of the correct runs and the checklist, and counts them separately", () => {
        write('runs/bbbb0002/result.json', JSON.stringify(record('bbbb0002', {
            outcome: 'network-failure',
            checks: [ { item: 'checks', verdict: 'fail', evidence: [] } ],
        })));
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Runs with a result | 2 | 2 |');
        expect(request11).toContain('| Network failures | 0 | 1 |');
        expect(request11).toContain('| Correct | 1 of 2 | 1 of 1 |');
        expect(request11).toContain('| `checks` | 1 of 2 | 1 of 1 |');
    });

    it("leaves runs whose agent failed out of the correct runs and the checklist, and counts them apart from the network failures", () => {
        write('runs/bbbb0002/result.json', JSON.stringify(record('bbbb0002', {
            outcome: 'agent-failure',
            checks: [ { item: 'checks', verdict: 'fail', evidence: [] } ],
        })));
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Runs with a result | 2 | 2 |');
        expect(request11).toContain('| Network failures | 0 | 0 |');
        expect(request11).toContain('| Agent failures | 0 | 1 |');
        expect(request11).toContain('| Correct | 1 of 2 | 1 of 1 |');
        expect(request11).toContain('| `checks` | 1 of 2 | 1 of 1 |');
        expect(request11).toContain('agent failures');
    });

    it("lists the models the layout's runs used, with how many runs used each, so a reader can tell whether the layouts got the same mix", () => {
        write('runs/bbbb0002/result.json', JSON.stringify(record('bbbb0002', { models: [ 'claude-opus-5.5', 'gpt-5.4' ] })));
        write('runs/aaaa0002/result.json', JSON.stringify(record('aaaa0002', { models: [ 'gpt-5.4' ] })));
        write('runs/aaaa0001/result.json', JSON.stringify(record('aaaa0001', { models: [], modelAnswered: false, modelUnreported: true })));
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Models | gpt-5.4: 1 of 2<br>(not reported): 1 of 2 | claude-opus-5.5: 1 of 2<br>claude-sonnet-5.5: 1 of 2<br>gpt-5.4: 1 of 2 |');
    });

    it("lists the models Copilot's auto mode could choose from, per layout, so a reader sees when it had more than one", () => {
        write('runs/bbbb0002/result.json', JSON.stringify(record('bbbb0002', { models: [ 'gpt-6-luna' ], autoMode: { chosenModel: 'gpt-6-luna', availableModels: [ 'gpt-6-luna', 'claude-sonnet-5.5' ] } })));
        write('runs/aaaa0002/result.json', JSON.stringify(record('aaaa0002', { models: [ 'gpt-6-luna' ], autoMode: { chosenModel: 'gpt-6-luna', availableModels: [ 'gpt-6-luna' ] } })));
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Models Auto could choose from | gpt-6-luna: 1 of 2<br>(not reported): 1 of 2 | claude-sonnet-5.5: 1 of 2<br>gpt-6-luna: 1 of 2<br>(not reported): 1 of 2 |');
    });

    it("leaves out the row of the models Auto could choose from when no run of the request has them, as with Kiro's", () => {
        expect(section(compareResults(results), '11-add-to-messy-code')).not.toContain('| Models Auto could choose from |');
    });

    it("reads the model of a result scored before runs recorded every model", () => {
        const { models, ...older } = record('bbbb0001', {});
        write('runs/bbbb0001/result.json', JSON.stringify({ ...older, model: 'claude-opus-5.5' }));

        expect(section(compareResults(results), '11-add-to-messy-code')).toContain('claude-opus-5.5: 1 of 1');
    });

    it("shows the items the request doesn't exercise apart, where a run has a verdict on them", () => {
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Other item | none | b |');
        expect(request11).toContain('| `actor-names` | 0 of 1 | n/a |');
        expect(request11).not.toContain('`timeout`');
    });

    it('says which skill files each layout loaded, in how many of its runs', () => {
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('| Skill file | none | b |');
        expect(request11).toContain('| `serenity-js-screenplay/references/tasks.md` | 0 of 2 | 1 of 1 |');
        expect(request11).toContain('| `serenity-js-writing-tests/SKILL.md` | 0 of 2 | 1 of 1 |');
    });

    it("shows one run's diff per layout, side by side, with the agent's reply", () => {
        const request11 = section(compareResults(results), '11-add-to-messy-code');

        expect(request11).toContain('<th>none: run aaaa0001, kiro, correct</th>');
        expect(request11).toContain('<th>b: run bbbb0001, kiro, correct</th>');
        expect(request11).toMatch(/<td valign="top">\n\n```diff\n\+ {4}it\('rounds two thirds'[\s\S]*```\n\n\*\*The agent's reply\*\*\n\nAdded the scenario\.\n\n<\/td>/);
        expect(request11).toContain('Suggestions: replace PostAndCheck.');
    });

    it("says when a layout has no run with a result, or a run has no reply", () => {
        const request9 = section(compareResults(results), '9-new-interface');

        expect(request9).toContain('| | b |');
        expect(request9).toContain('(no diff)');
        expect(request9).toContain('(none: the agent said nothing after its last tool call)');
    });

    it('--compare writes compare.md next to the results, and changes nothing else', () => {
        const out = mkdtempSync(join(tmpdir(), 'skill-layouts-compare-out-'));
        try {
            execFileSync('mv', [ results, join(out, 'pilot') ]);
            const resultFile = join(out, 'pilot', 'runs', 'aaaa0001', 'result.json');
            const modified = statSync(resultFile).mtimeMs;

            execFileSync(process.execPath, [ join(import.meta.dirname, '..', 'src', 'cli.ts'), '--compare', '--pilot', '--out', out ], { stdio: 'pipe' });

            expect(readFileSync(join(out, 'pilot', 'compare.md'), 'utf8')).toContain('## 11-add-to-messy-code');
            expect(statSync(resultFile).mtimeMs).toBe(modified);
            expect(existsSync(join(out, 'pilot', 'summary.md'))).toBe(false);
        }
        finally {
            rmSync(out, { recursive: true, force: true });
            mkdirSync(results, { recursive: true });
        }
    });
});

describe("compareResults' run shown per layout", () => {

    let results: string;

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-compare-shown-'));
        // the IDs sort the other way, so only the repeat, then the agent, can pick the run shown
        const planned: PlannedRun[] = [
            { id: 'aaaa0003', agent: 'kiro', layout: 'b', request: '11-add-to-messy-code', repeat: 2 },
            { id: 'aaaa0002', agent: 'copilot', layout: 'b', request: '11-add-to-messy-code', repeat: 1 },
            { id: 'zzzz0001', agent: 'kiro', layout: 'b', request: '11-add-to-messy-code', repeat: 1 },
        ];
        writeFileSync(join(results, 'mapping.json'), JSON.stringify(planned));
        for (const { id } of planned) {
            mkdirSync(join(results, 'runs', id), { recursive: true });
            writeFileSync(join(results, 'runs', id, 'result.json'), JSON.stringify(record(id, {})));
        }
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    it("shows the first repeat's run, and Kiro's before Copilot's within a repeat, whatever their IDs", () => {
        expect(compareResults(results)).toContain('<th>b: run zzzz0001, kiro, correct</th>');
    });

    it("shows Copilot's run of the first repeat when Kiro has none, before Kiro's of a later repeat", () => {
        rmSync(join(results, 'runs', 'zzzz0001'), { recursive: true });

        expect(compareResults(results)).toContain('<th>b: run aaaa0002, copilot, correct</th>');
    });
});

describe('--compare', () => {

    it("only reads, like --summarise, so it needs no serenity-js clone", () => {
        expect(parseArguments([ '--compare', '--pilot', '--out', '/out' ], '/')).toMatchObject({ compareOnly: true, mode: { mode: 'pilot' } });
    });

    it("doesn't combine with another action", () => {
        expect(() => parseArguments([ '--compare', '--summarise', '--out', '/out' ], '/')).toThrow(/usage/);
    });
});
