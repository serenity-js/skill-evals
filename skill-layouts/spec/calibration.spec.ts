import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildStartingProject, calibrate, type CalibrationEntry, calibrationReport, CalibrationFiles, citedPairs, fixtureVersions,
    guideSections, judgeInputOf, majorityOf, renderCalibration, reviewedRunsOf, roundNameOf, rulesOf, statusOf,
} from '../src/calibration.ts';
import type { Finished } from '../src/child-processes.ts';
import { CHECKLIST, type ChecklistItem, type Verdict } from '../src/conventions.ts';
import { JUDGE_PROMPT_WITHOUT_PROJECT, type JudgeVerdict, type Spawn } from '../src/judge.ts';
import { loadRequests } from '../src/requests.ts';
import { REVIEW_GUIDE } from '../src/review.ts';

const git = (directory: string, ...args: string[]) =>
    execFileSync('git', [ '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args ], { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();

const write = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
};

const GUIDE = [
    '# Reviewing a run',
    '',
    'The introduction, which no item names.',
    '',
    '## Answerable parameters',
    '',
    '**Items:** `answerable-parameters`',
    '',
    'An `Answerable` in a literal fails. *5a6adab8* and *3cf1d4ac* fail for this; see [Grouping](#grouping).',
    '',
    '## Grouping',
    '',
    '**Items:** `grouping`, `structure`',
    '',
    'Standalone questions are fine: *5a6adab8* passes.',
    '',
    '### Within a grouping',
    '',
    '**Items:** `structure`',
    '',
    '*ccb92e43* passes.',
    '',
].join('\n');

const { requests } = loadRequests();
const requestOf = (id: string) => requests.find(request => request.id === id)!;

describe('calibrating the judge', () => {

    describe('the review guide, as the judge\'s rules', () => {

        it('reads each section, with the items it names, its text and the runs it cites', () => {
            expect(guideSections(GUIDE)).toEqual([
                { heading: 'Answerable parameters', items: [ 'answerable-parameters' ], text: 'An `Answerable` in a literal fails. *5a6adab8* and *3cf1d4ac* fail for this; see [Grouping](#grouping).', cited: [ '5a6adab8', '3cf1d4ac' ] },
                { heading: 'Grouping', items: [ 'grouping', 'structure' ], text: 'Standalone questions are fine: *5a6adab8* passes.', cited: [ '5a6adab8' ] },
                { heading: 'Within a grouping', items: [ 'structure' ], text: '*ccb92e43* passes.', cited: [ 'ccb92e43' ] },
            ]);
        });

        it('refuses a section that names an item the checklist doesn\'t have', () => {
            expect(() => guideSections('## Naming\n\n**Items:** `naming`\n')).toThrow('review-guide.md\'s section "Naming" names naming, which aren\'t items of the checklist');
        });

        it('cites a run for the items of the sections that cite it only', () => {
            const cited = citedPairs(guideSections(GUIDE));

            expect([ ...cited ].sort()).toEqual([ '3cf1d4ac answerable-parameters', '5a6adab8 answerable-parameters', '5a6adab8 grouping', '5a6adab8 structure', 'ccb92e43 structure' ]);
        });

        it("reads the harness's own review-guide.md, whose sections only name items of the checklist", () => {
            const cited = citedPairs(guideSections(readFileSync(REVIEW_GUIDE, 'utf8')));

            expect(cited.has('924363f0 waits-in-tasks')).toBe(true);
            expect(cited.has('924363f0 grouping')).toBe(false);
        });

        it('gives the judge a rule for every item of the checklist, with its text and the sections that name it', () => {
            const rules = rulesOf(GUIDE);

            expect(rules.map(rule => rule.id)).toEqual(CHECKLIST.map(item => item.id));
            expect(rules.find(rule => rule.id === 'structure')!.readme).toBe([
                '# structure',
                '',
                CHECKLIST.find(item => item.id === 'structure')!.text,
                '',
                '## Grouping',
                '',
                'Standalone questions are fine: *run R1* passes.',
                '',
                '## Within a grouping',
                '',
                '*run R3* passes.',
            ].join('\n'));
        });

        it('names the runs the guide cites by number, the same in every rule, and keeps only the text of its links', () => {
            const readme = rulesOf(GUIDE).find(rule => rule.id === 'answerable-parameters')!.readme;

            expect(readme).toContain('*run R1* and *run R2* fail for this; see Grouping.');
            expect(rulesOf(readFileSync(REVIEW_GUIDE, 'utf8')).map(rule => rule.readme).join('\n')).not.toMatch(/[\da-f]{8}/);
        });
    });

    describe('the recorded rounds', () => {

        let round: string;

        beforeEach(() => {
            round = join(mkdtempSync(join(tmpdir(), 'skill-layouts-calibration-')), 'focus', 'pilot');
            write(join(round, 'mapping.json'), JSON.stringify([
                { id: 'aaaaaaaa', agent: 'kiro', layout: 'b', request: '6-duplication', repeat: 1 },
                { id: 'bbbbbbbb', agent: 'kiro', layout: 'none', request: '6-duplication', repeat: 1 },
                { id: 'cccccccc', agent: 'copilot', layout: 'b', request: '6-duplication', repeat: 1 },
            ]));
            write(join(round, 'review', 'scores.json'), JSON.stringify({
                aaaaaaaa: { 'structure': 'pass', 'grouping': 'n/a', 'cast': '' },
                bbbbbbbb: { 'structure': '', 'grouping': '' },
            }));
            for (const id of [ 'aaaaaaaa', 'bbbbbbbb', 'cccccccc' ]) {
                write(join(round, 'runs', id, 'diff.patch'), '');
            }
        });
        afterEach(() => rmSync(dirname(dirname(round)), { recursive: true, force: true }));

        it("names a round after its directory, or the round's, for a mode's results", () => {
            expect(roundNameOf('/rounds/skill-layouts-focus/pilot')).toBe('skill-layouts-focus');
            expect(roundNameOf('/rounds/skill-layouts-focus/held-back-b')).toBe('skill-layouts-focus');
            expect(roundNameOf('/rounds/regression')).toBe('regression');
        });

        it('reads the runs the reviewer scored, with the verdicts they gave, and none they left blank', () => {
            const reviewed = reviewedRunsOf(round);

            expect(reviewed.map(run => [ run.round, run.run.id, run.verdicts ])).toEqual([ [ 'focus', 'aaaaaaaa', { 'structure': 'pass', 'grouping': 'n/a' } ] ]);
        });

        it("refuses a verdict that isn't one, naming the item, the run and the round", () => {
            write(join(round, 'review', 'scores.json'), JSON.stringify({ aaaaaaaa: { structure: 'Pass' } }));

            expect(() => reviewedRunsOf(round)).toThrow('the review of structure of run aaaaaaaa, in focus says "Pass"');
        });

        it('refuses a reviewed run without its diff', () => {
            rmSync(join(round, 'runs', 'aaaaaaaa', 'diff.patch'));

            expect(() => reviewedRunsOf(round)).toThrow('run aaaaaaaa, in focus, was reviewed, but has no diff.patch');
        });
    });

    describe('the project before and after a run', () => {

        let root: string;
        let template: string;
        let commit: string;
        let harness: string;

        // a change to the fixture's spec, as it was before the fixture changed
        const diff = [
            'diff --git a/spec/precision.spec.ts b/spec/precision.spec.ts',
            '--- a/spec/precision.spec.ts',
            '+++ b/spec/precision.spec.ts',
            '@@ -1 +1,2 @@',
            ' // the first version',
            '+// the run\'s line',
            '',
        ].join('\n');

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-calibration-'));
            template = join(root, 'template');
            write(join(template, 'package.json'), '{}\n');
            git(template, 'init', '--quiet');
            git(template, 'add', '--all');
            git(template, 'commit', '--quiet', '--message', 'the template');
            commit = git(template, 'rev-parse', 'HEAD');

            // the harness, as a repository with the fixture's history
            harness = join(root, 'skill-evals', 'skill-layouts');
            write(join(harness, 'fixtures', 'precision', 'spec', 'precision.spec.ts'), '// the first version\n');
            git(dirname(harness), 'init', '--quiet');
            git(dirname(harness), 'add', '--all');
            git(dirname(harness), 'commit', '--quiet', '--message', 'the first version');
            write(join(harness, 'fixtures', 'precision', 'spec', 'precision.spec.ts'), '// the second version\n');
            git(dirname(harness), 'commit', '--quiet', '--all', '--message', 'the second version');
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        const read = (path: string) => readFileSync(join(root, 'project', path), 'utf8');

        it('builds the template with the fixture as it is, when the diff applies to it', () => {
            const used = buildStartingProject(join(root, 'project'), { template, commit, versions: fixtureVersions('precision', harness), diff: diff.replace('the first version', 'the second version') });

            expect(used).toBe('the precision fixture as it is');
            expect(read('before/spec/precision.spec.ts')).toBe('// the second version\n');
            expect(read('after/spec/precision.spec.ts')).toBe('// the second version\n// the run\'s line\n');
            expect(read('before/package.json')).toBe('{}\n');
            expect(existsSync(join(root, 'project', 'after', '.git'))).toBe(false);
        });

        it("goes back through the fixture's history to the newest version the diff applies to", () => {
            const used = buildStartingProject(join(root, 'project'), { template, commit, versions: fixtureVersions('precision', harness), diff });

            expect(used).toMatch(/^the precision fixture as of [\da-f]{7}$/);
            expect(read('before/spec/precision.spec.ts')).toBe('// the first version\n');
            expect(read('after/spec/precision.spec.ts')).toBe('// the first version\n// the run\'s line\n');
        });

        it("leaves the project as it was for a run that changed nothing, and has only the template for a request without a fixture", () => {
            const used = buildStartingProject(join(root, 'project'), { template, commit, versions: fixtureVersions(undefined, harness), diff: '' });

            expect(used).toBe('no fixture');
            expect(read('after/package.json')).toBe('{}\n');
        });

        it('says why, version by version, when the diff applies to none', () => {
            expect(() => buildStartingProject(join(root, 'project'), { template, commit, versions: fixtureVersions('precision', harness), diff: diff.replace('the first version', 'no version') }))
                .toThrow(/doesn't apply to the template at [\da-f]+ with the precision fixture as it is: .+; the precision fixture as of/);
        });

        it("gives the judge the request with the round's URLs, the rules it exercises first, and the reference without its expected value's marker", () => {
            const round = join(root, 'round');
            write(join(round, 'runs', 'aaaaaaaa', 'diff.patch'), diff);
            write(join(round, 'runs', 'aaaaaaaa', 'reply.md'), 'I added the scenario.\n');
            const reviewed = { round: 'focus', results: new (class { run = () => ({ read: (file: string) => readFileSync(join(round, 'runs', 'aaaaaaaa', file === 'diff' ? 'diff.patch' : 'reply.md'), 'utf8') }) })() as never, run: { id: 'aaaaaaaa', agent: 'kiro' as const, layout: 'b' as const, request: '4-new-http-api', repeat: 1 }, verdicts: {} };

            const input = judgeInputOf(reviewed, { rules: rulesOf(GUIDE), request: requestOf('4-new-http-api'), port: 4170, before: 'b', after: 'a' });

            expect(input.request).toContain('http://127.0.0.1:4170/v1/latest?base=EUR&symbols=USD');
            expect(input.diff).toBe(diff);
            expect(input.reply).toBe('I added the scenario.\n');
            expect(input.exercised).toEqual(CHECKLIST.filter(item => item.requests.includes('4-new-http-api')).map(item => item.id));
            expect(input.rules.slice(0, input.exercised.length).map(rule => rule.id)).toEqual(input.exercised);
            expect([ ...input.reference.values() ].join('\n')).not.toMatch(/\/\/ wrong:|\{\{frankfurter\}\}/);
        });
    });

    describe('the report', () => {

        const judged = (...verdicts: Array<Verdict | undefined>): Array<JudgeVerdict | undefined> =>
            verdicts.map(verdict => verdict ? { rule: 'structure', verdict, evidence: [ 'after/src/a.ts:1: a' ], reason: `it's ${ verdict }` } : undefined);
        const entry = (item: ChecklistItem, reviewer: Verdict, verdicts: Array<JudgeVerdict | undefined>, { heldOut = true, round = 'focus', run = 'aaaaaaaa' } = {}): CalibrationEntry =>
            ({ round, run, item, reviewer, heldOut, judged: verdicts });
        const meta = { judge: { agent: 'kiro', model: 'claude-sonnet-5.5', version: 'kiro-cli 3.5.0' }, sessions: { sessions: 6, withoutVerdicts: 1, retried: 2, credits: 4.5, durationMs: 360_000 }, withoutProject: [] };

        it('takes the verdict most sessions agree on, a split when none has a majority, and missing when no session gave one', () => {
            expect(majorityOf([ 'pass', 'fail', 'pass' ])).toBe('pass');
            expect(majorityOf([ 'pass', undefined, 'pass' ])).toBe('pass');
            expect(majorityOf([ 'pass', 'fail', 'n/a' ])).toBe('split');
            expect(majorityOf([ 'pass', 'fail', undefined ])).toBe('split');
            expect(majorityOf([ undefined, undefined ])).toBe('missing');
        });

        it('counts the agreement on every verdict and on the held-out ones, the fails caught, the confusion and the unanimous sessions', () => {
            const report = calibrationReport([
                entry('structure', 'pass', judged('pass', 'pass', 'pass')),
                entry('structure', 'fail', judged('fail', 'fail', 'pass'), { heldOut: false }),
                entry('structure', 'fail', judged('pass', 'pass', 'pass')),
                entry('structure', 'n/a', judged('pass', 'fail', 'n/a')),
                entry('structure', 'pass', judged(undefined, undefined, undefined)),
            ], meta);

            expect(report.items).toEqual([ expect.objectContaining({
                item: 'structure',
                reviewer: { 'pass': 2, 'fail': 2, 'n/a': 1 },
                agreement: { count: 2, of: 4 },
                heldOut: { count: 1, of: 3 },
                failsCaught: { count: 1, of: 2 },
                confusion: { reviewerPassJudgeFail: 0, reviewerFailJudgePass: 1, otherNa: 0, split: 1, missing: 1 },
                unanimous: { count: 2, of: 4 },
                status: 'too few held-out verdicts',
            }) ]);
        });

        it.each([
            [ 'too few held-out verdicts', { heldOut: { count: 9, of: 9 }, failsCaught: { count: 5, of: 5 } }, '9 held-out verdicts, of the 10 it needs' ],
            [ 'not calibrated', { heldOut: { count: 16, of: 20 }, failsCaught: { count: 5, of: 5 } }, 'agrees with 16 of 20 (80%) held-out verdicts, under 85%' ],
            [ 'calibrated against false alarms only', { heldOut: { count: 20, of: 20 }, failsCaught: { count: 2, of: 2 } }, 'the reviewer failed it 2 times, fewer than 3' ],
            [ 'not calibrated', { heldOut: { count: 18, of: 20 }, failsCaught: { count: 3, of: 5 } }, 'fails 3 of 5 (60%) of the runs the reviewer failed, under two thirds' ],
            [ 'calibrated', { heldOut: { count: 17, of: 20 }, failsCaught: { count: 2, of: 3 } }, 'agrees with 17 of 20 (85%) held-out verdicts, and fails 2 of 3 (67%)' ],
        ])('decides an item is %s, as the protocol says', (status, counts, why) => {
            const decision = statusOf(counts);

            expect(decision.status).toBe(status);
            expect(decision.why).toContain(why);
        });

        it('reports each round, and every disagreement with the sessions\' reasons', () => {
            const report = calibrationReport([
                entry('structure', 'fail', judged('pass', 'pass', 'fail'), { run: 'aaaaaaaa' }),
                entry('grouping', 'pass', judged('pass', 'pass', 'pass'), { run: 'aaaaaaaa' }),
                entry('structure', 'pass', judged('pass', 'pass', 'pass'), { round: 'regression', run: 'bbbbbbbb', heldOut: false }),
            ], meta);

            expect(report.rounds).toEqual([
                { round: 'focus', agreement: { count: 1, of: 2 }, heldOut: { count: 1, of: 2 } },
                { round: 'regression', agreement: { count: 1, of: 1 }, heldOut: { count: 0, of: 0 } },
            ]);
            expect(report.disagreements).toEqual([ { round: 'focus', run: 'aaaaaaaa', item: 'structure', reviewer: 'fail', judge: 'pass', heldOut: true, reasons: [ "pass: it's pass", "pass: it's pass", "fail: it's fail" ] } ]);

            const markdown = renderCalibration(report);
            expect(markdown).toContain('| structure | 1 / 1 / 0 | 1 of 2 (50%) | 0 of 1 (0%) | 0 of 1 (0%) | 1 of 2 (50%) | too few held-out verdicts: 1 held-out verdict, of the 10 it needs |');
            expect(markdown).toContain('| regression | 1 of 1 (100%) | 0 of 0 (n/a) |');
            expect(markdown).toContain('### structure\n\n- **focus aaaaaaaa**: the reviewer says fail, the judge pass\n  - pass: it\'s pass\n');
            expect(markdown).toContain('6 sessions, 2 of them retried, 1 left no verdicts the harness could use. They used 4.5 credits, and took 6 minutes.');
        });
    });

    describe('calibrate', () => {

        let root: string;
        let round: string;
        let template: string;
        const config = { judge: { agent: 'kiro' as const, model: 'claude-sonnet-5.5' }, runTimeoutMinutes: 2, apiServer: { port: 4170 } };

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-calibrate-'));
            template = join(root, 'template');
            write(join(template, 'README.md'), 'Node.js 18 or later\n');
            git(template, 'init', '--quiet');
            git(template, 'add', '--all');
            git(template, 'commit', '--quiet', '--message', 'the template');

            round = join(root, 'regression', 'pilot');
            write(join(round, 'mapping.json'), JSON.stringify([
                { id: 'aaaaaaaa', agent: 'kiro', layout: 'b', request: '8-control', repeat: 1 },
                { id: 'bbbbbbbb', agent: 'kiro', layout: 'none', request: '8-control', repeat: 1 },
            ]));
            write(join(round, 'conditions.json'), JSON.stringify({ shared: { template: { commit: git(template, 'rev-parse', 'HEAD') }, apiServer: { port: 4170 } }, agents: {} }));
            write(join(round, 'review', 'scores.json'), JSON.stringify({ aaaaaaaa: { 'structure': 'pass', 'timeout': 'n/a' }, bbbbbbbb: { 'structure': 'fail' } }));
            write(join(round, 'runs', 'aaaaaaaa', 'diff.patch'), 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Node.js 18 or later\n+Node.js 22 or later\n');
            write(join(round, 'runs', 'bbbbbbbb', 'diff.patch'), 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Node.js 16 or later\n+Node.js 22 or later\n');
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        /** A judge that passes structure and leaves every other rule n/a, and remembers what it was given. */
        function fakeJudge() {
            const seen: string[] = [];
            const prompts: string[] = [];
            const spawn: Spawn = async (command, args, options) => {
                const after = join(options.cwd, 'after', 'README.md');
                seen.push(existsSync(after) ? readFileSync(after, 'utf8') : '(no project)');
                prompts.push(args.at(-1)!);
                writeFileSync(options.stdout, readFileSync(join(import.meta.dirname, 'fixtures', 'kiro-v3.judge.synthetic.jsonl')));
                writeFileSync(options.stderr, '');
                writeFileSync(join(options.cwd, 'verdicts.json'), JSON.stringify({ verdicts: CHECKLIST.map(item => item.id === 'structure'
                    ? { rule: item.id, verdict: 'pass', evidence: [ 'after/README.md:1: Node.js 22 or later' ], reason: 'It changes only the README.' }
                    : { rule: item.id, verdict: 'n/a', evidence: [], reason: 'Nothing it applies to.' }) }));
                return { exitCode: 0, durationMs: 1000, timedOut: false } satisfies Finished;
            };
            return { spawn, seen, prompts };
        }

        const options = (spawn: Spawn) => ({ rounds: [ round ], template, out: join(root, 'out'), work: join(root, 'work'), config, repeats: 2, env: { PATH: '/usr/bin', KIRO_API_KEY: 'k' }, spawn, judgeVersion: 'kiro-cli 3.5.0' });

        it("judges each reviewed run as many times as it's asked, and compares the judge's verdicts with the reviewer's", async () => {
            const { spawn, seen } = fakeJudge();

            const report = await calibrate(options(spawn));

            expect(seen.slice(0, 2)).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n' ]);
            expect(report.items.map(item => [ item.item, item.agreement ])).toEqual([ [ 'structure', { count: 1, of: 2 } ], [ 'timeout', { count: 1, of: 1 } ] ]);
            expect(report.sessions).toMatchObject({ sessions: 4, withoutVerdicts: 0, credits: 0.9536 });
            const files = new CalibrationFiles(join(root, 'out'));
            expect(readFileSync(files.markdown, 'utf8')).toContain('# Calibrating the judge');
            expect(JSON.parse(readFileSync(files.json, 'utf8')).entries).toHaveLength(3);
            expect(existsSync(join(files.session('regression', 'aaaaaaaa', 2), 'verdicts.json'))).toBe(true);
        });

        it("judges a run whose diff applies to no version of its project from its diff alone, as the reviewer's packet had it, and says so", async () => {
            const { spawn, prompts, seen } = fakeJudge();

            const report = await calibrate(options(spawn));

            expect(seen).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n', '(no project)', '(no project)' ]);
            expect(prompts.slice(2)).toEqual([ JUDGE_PROMPT_WITHOUT_PROJECT, JUDGE_PROMPT_WITHOUT_PROJECT ]);
            expect(report.withoutProject).toEqual([ { round: 'regression', run: 'bbbbbbbb', reason: expect.stringContaining("its diff doesn't apply") } ]);
            expect(renderCalibration(report)).toContain('- regression bbbbbbbb: its diff doesn\'t apply');
        });

        it('resumes, judging again only the sessions whose prompt or inputs changed', async () => {
            await calibrate(options(fakeJudge().spawn));

            const again = fakeJudge();
            await calibrate(options(again.spawn));
            expect(again.seen).toHaveLength(0);

            write(join(round, 'runs', 'aaaaaaaa', 'reply.md'), 'I updated the README.\n');
            const changed = fakeJudge();
            await calibrate(options(changed.spawn));
            expect(changed.seen).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n' ]);
        });

        it('refuses two rounds of the same name', async () => {
            await expect(calibrate({ ...options(fakeJudge().spawn), rounds: [ round, join(root, 'other', 'regression') ] }))
                .rejects.toThrow('two rounds are named regression');
        });
    });
});
