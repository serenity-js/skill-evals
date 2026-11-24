import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments, rescoreChecks } from '../src/cli.ts';
import type { Check } from '../src/conventions.ts';
import type { PlannedRun } from '../src/review.ts';
import { diffOf, type FixtureRun, workingCopyOf } from './fixture-runs.ts';

const runs: PlannedRun[] = [
    { id: '89a97301', agent: 'kiro', layout: 'a', request: '11-add-to-messy-code', repeat: 1 },
    { id: 'fb87227b', agent: 'kiro', layout: 'c', request: '11-add-to-messy-code', repeat: 1 },
];

// the checks as the eighth pilot saved them: scoped to request 11, and from before the new items
const savedChecks: Check[] = [
    { item: 'names-without-the', verdict: 'pass', evidence: [ 'src/precision.ts:22: CalculateWithPrecision' ] },
    { item: 'awaiting', verdict: 'pass', evidence: [] },
];

const git = (directory: string, ...args: string[]) =>
    execFileSync('git', [ '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args ], { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();

describe('rescoreChecks', () => {

    let root: string;
    let results: string;
    let work: string;
    let template: string;

    const resultOf = (run: FixtureRun) => JSON.parse(readFileSync(join(results, 'runs', run, 'result.json'), 'utf8'));
    const verdictsOf = (run: FixtureRun) => Object.fromEntries((resultOf(run).checks as Check[]).map(check => [ check.item, check.verdict ]));

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-rescore-checks-'));
        results = join(root, 'results');
        work = join(root, 'work');
        mkdirSync(join(work, 'runs'), { recursive: true });

        // the template, as a repository: the precision project's files, without the request's fixture
        template = join(root, 'template');
        cpSync(join(import.meta.dirname, 'fixtures', 'runs', 'precision-project'), template, { recursive: true });
        rmSync(join(template, 'spec', 'precision.spec.ts'));
        rmSync(join(template, 'src', 'precision.ts'));
        git(template, 'init', '--quiet');
        git(template, 'add', '--all');
        git(template, 'commit', '--quiet', '--message', 'the template');

        mkdirSync(join(results, 'review'), { recursive: true });
        writeFileSync(join(results, 'mapping.json'), JSON.stringify(runs));
        writeFileSync(join(results, 'conditions.json'), JSON.stringify({ shared: { template: { commit: git(template, 'rev-parse', 'HEAD') } }, agents: {} }));
        for (const { id } of runs) {
            mkdirSync(join(results, 'runs', id), { recursive: true });
            writeFileSync(join(results, 'runs', id, 'result.json'), JSON.stringify({ id, outcome: 'correct', checks: savedChecks, skillReads: [], testAttempts: 1 }, null, 2));
            writeFileSync(join(results, 'runs', id, 'diff.patch'), diffOf(id as FixtureRun));
        }
        writeFileSync(join(results, 'review', 'scores.json'), JSON.stringify({ '89a97301': { 'structure': 'pass', 'tasks-for-steps': '' } }));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("recomputes a run's checks from its saved diff and its working copy, where --work still has it, and keeps the rest of its result", () => {
        renameSync(workingCopyOf('89a97301'), join(work, 'runs', '89a97301'));

        rescoreChecks(results, { work, template });

        expect(verdictsOf('89a97301')).toMatchObject({ 'answerable-parameters': 'fail', 'consistent-actor-names': 'pass', 'names-without-the': 'pass' });
        expect(resultOf('89a97301')).toMatchObject({ outcome: 'correct', testAttempts: 1 });
        expect(resultOf('89a97301').checksRescored).toMatch(/^\d{4}-\d\d-\d\dT/);
    });

    it("rebuilds a working copy that's gone, from the template at the run's commit, the request's fixture and the saved diff, and removes it again", () => {
        rescoreChecks(results, { work, template });

        expect(verdictsOf('fb87227b')).toMatchObject({ 'clients-through-abilities': 'n/a', 'consistent-actor-names': 'fail' });
        expect(existsSync(join(work, 'rescore-checks', 'fb87227b'))).toBe(false);
    });

    it('scores every item of the checklist, so each result.json has them all, in order', () => {
        rescoreChecks(results, { work, template });

        expect((resultOf('89a97301').checks as Check[]).map(check => check.item)).toContain('consistent-actor-names');
        expect(resultOf('89a97301').checks).toHaveLength(resultOf('fb87227b').checks.length);
    });

    it('says what changed in each run, with an item its saved result has no verdict on counted as n/a', () => {
        const rescored = rescoreChecks(results, { work, template });
        const changes = rescored.find(({ id }) => id === '89a97301')!.changes;

        expect(changes).toEqual(expect.arrayContaining([ 'answerable-parameters: n/a → fail', 'consistent-actor-names: n/a → pass' ]));
        expect(changes.filter(change => change.startsWith('names-without-the') || change.startsWith('waiting'))).toEqual([]);
    });

    it("rescores a run that changed nothing, whose diff is empty, with the others", () => {
        writeFileSync(join(results, 'runs', 'fb87227b', 'diff.patch'), '');

        rescoreChecks(results, { work, template });

        expect(Object.values(verdictsOf('fb87227b')).every(verdict => verdict === 'n/a')).toBe(true);
        expect(verdictsOf('89a97301')).toMatchObject({ 'answerable-parameters': 'fail' });
    });

    it("rescores nothing when a run's diff doesn't apply to its rebuilt working copy, and says which", () => {
        writeFileSync(join(results, 'runs', 'fb87227b', 'diff.patch'), diffOf('fb87227b').replace("import { LastResponse, PostRequest, Send } from '@serenity-js/rest';", 'something else'));
        const before = readFileSync(join(results, 'runs', '89a97301', 'result.json'), 'utf8');

        expect(() => rescoreChecks(results, { work, template })).toThrow(/^nothing rescored: run fb87227b: its diff doesn't apply to the template at [\da-f]{40} with the precision fixture/);
        expect(readFileSync(join(results, 'runs', '89a97301', 'result.json'), 'utf8')).toBe(before);
    });

    it("adds a blank to scores.json for each item the reviewer hasn't scored yet, keeping their verdicts, and writes the packets again with the checklist as it is", () => {
        rescoreChecks(results, { work, template });

        const scores = JSON.parse(readFileSync(join(results, 'review', 'scores.json'), 'utf8'));
        expect(scores['89a97301']).toMatchObject({ 'structure': 'pass', 'consistent-actor-names': '', 'answerable-parameters': '' });
        expect(scores.fb87227b).toMatchObject({ 'structure': '' });
        expect(readFileSync(join(results, 'review', 'fb87227b.md'), 'utf8')).toContain('- [ ] consistent-actor-names:');
    });

    it("leaves the other agent's runs alone with --agent", () => {
        const before = readFileSync(join(results, 'runs', '89a97301', 'result.json'), 'utf8');

        expect(rescoreChecks(results, { work, template, agents: [ 'copilot' ] })).toEqual([]);
        expect(readFileSync(join(results, 'runs', '89a97301', 'result.json'), 'utf8')).toBe(before);
    });
});

describe('--rescore-checks', () => {

    it('only reads the saved results and rebuilds working copies, like --reparse, so it needs no serenity-js clone', () => {
        expect(parseArguments([ '--rescore-checks', '--pilot', '--out', '/out' ], '/work/kiro')).toMatchObject({
            rescoreChecksOnly: true, mode: { mode: 'pilot' }, template: '/work/serenity-js-mocha-template',
        });
    });

    it("doesn't combine with another action", () => {
        expect(() => parseArguments([ '--rescore-checks', '--reparse', '--pilot', '--out', '/out' ], '/')).toThrow(/^usage:/);
    });
});
