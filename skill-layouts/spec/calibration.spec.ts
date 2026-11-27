import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run, runBuffer } from '../src/child-processes.ts';
import type { Finished } from '../src/child-processes.ts';
import { calibrationOf } from '../src/cli.ts';
import { CHECKLIST, type ChecklistItem, exercises } from '../src/conventions.ts';
import { Ballot } from '../src/judging/ballot.ts';
import { CalibrationFiles } from '../src/judging/calibration.ts';
import { Comparison } from '../src/judging/comparison.ts';
import { JudgePrompt, type Spawn } from '../src/judging/judge.ts';
import { renderCalibration } from '../src/judging/markdown.ts';
import { CalibrationProtocol } from '../src/judging/protocol.ts';
import { RecordedRound } from '../src/judging/recorded-round.ts';
import { CalibrationReport } from '../src/judging/report.ts';
import { GuideSection, ReviewGuide } from '../src/judging/review-guide.ts';
import { RuleVerdict } from '../src/judging/rule-verdict.ts';
import { Share } from '../src/judging/share.ts';
import { JudgeIdentity } from '../src/judging/session-store.ts';
import { FixtureHistory, ProjectBuilder } from '../src/judging/starting-project.ts';
import { Verdict, type VerdictName } from '../src/judging/verdict.ts';
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

const ITEMS = CHECKLIST.map(item => item.id);
const commands = { run, runBuffer };
const { requests } = loadRequests();
const requestOf = (id: string) => requests.find(request => request.id === id)!;

describe('calibrating the judge', () => {

    describe('the review guide, as the judge\'s rules', () => {

        it('reads each section, with the items it names, its text and the runs it cites', () => {
            expect(ReviewGuide.parse(GUIDE, CHECKLIST).sections).toEqual([
                GuideSection.of('Answerable parameters', [ 'answerable-parameters' ], 'An `Answerable` in a literal fails. *5a6adab8* and *3cf1d4ac* fail for this; see [Grouping](#grouping).', [ '5a6adab8', '3cf1d4ac' ]),
                GuideSection.of('Grouping', [ 'grouping', 'structure' ], 'Standalone questions are fine: *5a6adab8* passes.', [ '5a6adab8' ]),
                GuideSection.of('Within a grouping', [ 'structure' ], '*ccb92e43* passes.', [ 'ccb92e43' ]),
            ]);
        });

        it('refuses a section that names an item the checklist it\'s given doesn\'t have', () => {
            expect(() => ReviewGuide.parse('## Naming\n\n**Items:** `naming`\n', CHECKLIST)).toThrow('review-guide.md\'s section "Naming" names naming, which aren\'t items of the checklist');
            expect(() => ReviewGuide.parse(GUIDE, [ { id: 'structure', text: 'one' } ])).toThrow('names answerable-parameters, which aren\'t items of the checklist');
        });

        it('cites a run for the items of the sections that cite it only', () => {
            const guide = ReviewGuide.parse(GUIDE, CHECKLIST);
            const cited = [ '3cf1d4ac', '5a6adab8', 'ccb92e43', 'aaaaaaaa' ].flatMap(id => ITEMS.filter(item => guide.cites(id, item)).map(item => `${ id } ${ item }`));

            expect(cited.sort()).toEqual([ '3cf1d4ac answerable-parameters', '5a6adab8 answerable-parameters', '5a6adab8 grouping', '5a6adab8 structure', 'ccb92e43 structure' ]);
        });

        it("reads the harness's own review-guide.md, whose sections only name items of the checklist", () => {
            const guide = ReviewGuide.parse(readFileSync(REVIEW_GUIDE, 'utf8'), CHECKLIST);

            expect(guide.cites('924363f0', 'waits-in-tasks')).toBe(true);
            expect(guide.cites('924363f0', 'grouping')).toBe(false);
        });

        it('gives the judge a rule for every item of the checklist, with its text and the sections that name it', () => {
            const { rules } = ReviewGuide.parse(GUIDE, CHECKLIST);

            expect(rules.map(rule => rule.id)).toEqual(ITEMS);
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
            const readme = ReviewGuide.parse(GUIDE, CHECKLIST).rules.find(rule => rule.id === 'answerable-parameters')!.readme;

            expect(readme).toContain('*run R1* and *run R2* fail for this; see Grouping.');
            expect(ReviewGuide.parse(readFileSync(REVIEW_GUIDE, 'utf8'), CHECKLIST).rules.map(rule => rule.readme).join('\n')).not.toMatch(/[\da-f]{8}/);
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
            write(join(round, 'conditions.json'), JSON.stringify({ shared: { template: { commit: 'abc' }, apiServer: { port: 4171 } }, agents: {} }));
            write(join(round, 'review', 'scores.json'), JSON.stringify({
                aaaaaaaa: { 'structure': 'pass', 'grouping': 'n/a', 'cast': '' },
                bbbbbbbb: { 'structure': '', 'grouping': '' },
            }));
            for (const id of [ 'aaaaaaaa', 'bbbbbbbb', 'cccccccc' ]) {
                write(join(round, 'runs', id, 'diff.patch'), '');
            }
        });
        afterEach(() => rmSync(dirname(dirname(round)), { recursive: true, force: true }));

        const at = (directory: string) => RecordedRound.at(directory, { items: ITEMS, defaultPort: 4170 });

        it("names a round after its directory, or the round's, for a mode's results", () => {
            expect(RecordedRound.nameOf('/rounds/skill-layouts-focus/pilot')).toBe('skill-layouts-focus');
            expect(RecordedRound.nameOf('/rounds/skill-layouts-focus/held-back-b')).toBe('skill-layouts-focus');
            expect(RecordedRound.nameOf('/rounds/regression')).toBe('regression');
        });

        it('reads the runs the reviewer scored, with the verdicts they gave, in the checklist\'s order, and none they left blank', () => {
            const reviewed = at(round).reviewedRuns;

            expect(reviewed.map(run => [ run.round, run.id, Object.fromEntries([ ...run.verdicts ].map(([ item, verdict ]) => [ item, verdict.name ])) ]))
                .toEqual([ [ 'focus', 'aaaaaaaa', { 'grouping': 'n/a', 'structure': 'pass' } ] ]);
            expect([ ...reviewed[0].verdicts.keys() ]).toEqual(ITEMS.filter(item => [ 'grouping', 'structure' ].includes(item)));
        });

        it("reads the template's commit and the local API server's port the round recorded, or the default port without one", () => {
            expect(at(round)).toMatchObject({ name: 'focus', templateCommit: 'abc', port: 4171 });

            write(join(round, 'conditions.json'), JSON.stringify({ shared: { template: { commit: 'abc' } }, agents: {} }));
            expect(at(round).port).toBe(4170);
        });

        it("refuses a verdict that isn't one, naming the item, the run and the round", () => {
            write(join(round, 'review', 'scores.json'), JSON.stringify({ aaaaaaaa: { structure: 'Pass' } }));

            expect(() => at(round)).toThrow('the review of structure of run aaaaaaaa, in focus says "Pass"');
        });

        it('refuses a reviewed run without its diff', () => {
            rmSync(join(round, 'runs', 'aaaaaaaa', 'diff.patch'));

            expect(() => at(round)).toThrow('run aaaaaaaa, in focus, was reviewed, but has no diff.patch');
        });

        it("refuses a round whose conditions.json doesn't record the template's commit", () => {
            write(join(round, 'conditions.json'), JSON.stringify({ shared: {}, agents: {} }));

            expect(() => at(round)).toThrow("focus's conditions.json doesn't record the template's commit, which the runs started from");
        });
    });

    describe('the project before and after a run', () => {

        let root: string;
        let template: string;
        let commit: string;
        let harness: string;
        const projects = new ProjectBuilder(commands);

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
        const versionsOf = (fixture: string | undefined) => new FixtureHistory(harness, commands).versionsOf(fixture);

        it('builds the template with the fixture as it is, when the diff applies to it', () => {
            const project = projects.build(join(root, 'project'), { template, commit, versions: versionsOf('precision'), diff: diff.replace('the first version', 'the second version') });

            expect(project).toMatchObject({ version: 'the precision fixture as it is', before: join(root, 'project', 'before'), after: join(root, 'project', 'after') });
            expect(read('before/spec/precision.spec.ts')).toBe('// the second version\n');
            expect(read('after/spec/precision.spec.ts')).toBe('// the second version\n// the run\'s line\n');
            expect(read('before/package.json')).toBe('{}\n');
            expect(existsSync(join(root, 'project', 'after', '.git'))).toBe(false);
        });

        it("goes back through the fixture's history to the newest version the diff applies to", () => {
            const project = projects.build(join(root, 'project'), { template, commit, versions: versionsOf('precision'), diff });

            expect(project.version).toMatch(/^the precision fixture as of [\da-f]{7}$/);
            expect(read('before/spec/precision.spec.ts')).toBe('// the first version\n');
            expect(read('after/spec/precision.spec.ts')).toBe('// the first version\n// the run\'s line\n');
        });

        it("leaves the project as it was for a run that changed nothing, and has only the template for a request without a fixture", () => {
            const project = projects.build(join(root, 'project'), { template, commit, versions: versionsOf(undefined), diff: '' });

            expect(project.version).toBe('no fixture');
            expect(read('after/package.json')).toBe('{}\n');
        });

        it('says why, version by version, when the diff applies to none', () => {
            expect(() => projects.build(join(root, 'project'), { template, commit, versions: versionsOf('precision'), diff: diff.replace('the first version', 'no version') }))
                .toThrow(/doesn't apply to the template at [\da-f]+ with the precision fixture as it is: .+; the precision fixture as of/);
        });

        it("gives the judge the request with the round's URLs, the rules it exercises first, and the reference without its expected value's marker", () => {
            const directory = join(root, 'round', 'pilot');
            write(join(directory, 'mapping.json'), JSON.stringify([ { id: 'aaaaaaaa', agent: 'kiro', layout: 'b', request: '4-new-http-api', repeat: 1 } ]));
            write(join(directory, 'conditions.json'), JSON.stringify({ shared: { template: { commit } }, agents: {} }));
            write(join(directory, 'review', 'scores.json'), JSON.stringify({ aaaaaaaa: { structure: 'pass' } }));
            write(join(directory, 'runs', 'aaaaaaaa', 'diff.patch'), diff);
            write(join(directory, 'runs', 'aaaaaaaa', 'reply.md'), 'I added the scenario.\n');
            const [ reviewed ] = RecordedRound.at(directory, { items: ITEMS, defaultPort: 4170 }).reviewedRuns;
            const { rules } = ReviewGuide.parse(GUIDE, CHECKLIST);

            const input = reviewed.judgeInput({ rules, request: requestOf('4-new-http-api'), port: 4170, project: undefined, exercises: (request, item) => exercises(request, item as ChecklistItem) });

            expect(input.request).toContain('http://127.0.0.1:4170/v1/latest?base=EUR&symbols=USD');
            expect(input.diff).toBe(diff);
            expect(input.reply).toBe('I added the scenario.\n');
            expect(input).not.toHaveProperty('before');
            expect(input.exercised).toEqual(CHECKLIST.filter(item => item.requests.includes('4-new-http-api')).map(item => item.id));
            expect(input.rules.slice(0, input.exercised.length).map(rule => rule.id)).toEqual(input.exercised);
            expect([ ...input.reference.values() ].join('\n')).not.toMatch(/\/\/ wrong:|\{\{frankfurter\}\}/);
        });
    });

    describe('the report', () => {

        const judged = (...verdicts: Array<VerdictName | undefined>) =>
            Ballot.of(verdicts.map(verdict => verdict ? RuleVerdict.of('structure', Verdict.of(verdict), [ 'after/src/a.ts:1: a' ], `it's ${ verdict }`) : undefined));
        const compare = (item: string, reviewer: VerdictName, ballot: Ballot, { heldOut = true, round = 'focus', run = 'aaaaaaaa' } = {}) =>
            Comparison.of({ round, run, item, reviewer: Verdict.of(reviewer), heldOut, ballot });
        const protocol = new CalibrationProtocol();
        const meta = { items: ITEMS, protocol, judge: JudgeIdentity.of('kiro', 'claude-sonnet-5.5', 'kiro-cli 3.5.0'), sessions: { sessions: 6, withoutVerdicts: 1, retried: 2, credits: 4.5, durationMs: 360_000 }, withoutProject: [] };
        const reportOf = (comparisons: Comparison[]) => CalibrationReport.of(comparisons, meta);

        it('takes the verdict more than half of the planned sessions agree on', () => {
            expect(judged('pass', 'fail', 'pass').result).toBe('pass');
            expect(judged('pass', undefined, 'pass').majority).toBe(Verdict.pass);
        });

        it('takes a split when every session gave a verdict, but none has a majority', () => {
            expect(judged('pass', 'fail', 'n/a').result).toBe('split');
            expect(judged('pass', 'fail').result).toBe('split');
            expect(judged('pass', 'fail').majority).toBeUndefined();
        });

        it("never lets fewer than half of the planned sessions decide: it's incomplete when sessions left no verdict, and no verdict has a majority of them all", () => {
            expect(judged('pass', undefined, undefined).result).toBe('incomplete');
            expect(judged('pass', 'fail', undefined).result).toBe('incomplete');
            expect(judged(undefined, undefined).result).toBe('missing');
        });

        it('knows whether the sessions that voted were unanimous, and their reasons', () => {
            expect(judged('pass', 'pass', undefined).isUnanimous()).toBe(true);
            expect(judged('pass', 'fail', 'pass').isUnanimous()).toBe(false);
            expect(judged('pass', undefined, undefined).canBeUnanimous()).toBe(false);
            expect(judged('fail', undefined, 'pass').reasons()).toEqual([ "fail: it's fail", "pass: it's pass" ]);
        });

        it('shows a share with its percentage, and of nothing as n/a', () => {
            expect(`${ Share.of(17, 20) }`).toBe('17 of 20 (85%)');
            expect(`${ Share.of(0, 0) }`).toBe('0 of 0 (n/a)');
            expect(Share.of(17, 20).isAtLeast(0.85)).toBe(true);
            expect(JSON.stringify(Share.counting([ 1, 2, 3 ], number => number > 1))).toBe('{"count":2,"of":3}');
        });

        it("counts an incomplete result against the judge's agreement, and reports it apart", () => {
            const report = reportOf([
                compare('structure', 'pass', judged('pass', undefined, undefined)),
                compare('structure', 'pass', judged('pass', 'pass', 'pass')),
            ]);

            expect(report.items[0]).toMatchObject({ agreement: Share.of(1, 2), confusion: { incomplete: 1, split: 0, missing: 0 } });
        });

        it('counts the agreement on every verdict and on the held-out ones, the fails caught, the confusion and the unanimous sessions', () => {
            const report = reportOf([
                compare('structure', 'pass', judged('pass', 'pass', 'pass')),
                compare('structure', 'fail', judged('fail', 'fail', 'pass'), { heldOut: false }),
                compare('structure', 'fail', judged('pass', 'pass', 'pass')),
                compare('structure', 'n/a', judged('pass', 'fail', 'n/a')),
                compare('structure', 'pass', judged(undefined, undefined, undefined)),
            ]);

            expect(JSON.parse(JSON.stringify(report.items))).toEqual([ expect.objectContaining({
                item: 'structure',
                reviewer: { 'pass': 2, 'fail': 2, 'n/a': 1 },
                agreement: { count: 2, of: 4 },
                heldOut: { count: 1, of: 3 },
                failsCaught: { count: 1, of: 2 },
                heldOutFailsCaught: { count: 0, of: 1 },
                confusion: { reviewerPassJudgeFail: 0, reviewerFailJudgePass: 1, otherNa: 0, split: 1, incomplete: 0, missing: 1 },
                unanimous: { count: 2, of: 4 },
                status: 'too few held-out verdicts',
            }) ]);
        });

        it.each([
            [ 'too few held-out verdicts', { heldOut: Share.of(9, 9), heldOutFailsCaught: Share.of(5, 5) }, '9 held-out verdicts, of the 10 it needs' ],
            [ 'not calibrated', { heldOut: Share.of(16, 20), heldOutFailsCaught: Share.of(5, 5) }, 'agrees with 16 of 20 (80%) held-out verdicts, under 85%' ],
            [ 'calibrated against false alarms only', { heldOut: Share.of(20, 20), heldOutFailsCaught: Share.of(2, 2) }, 'the reviewer failed it in 2 held-out verdicts, fewer than 3' ],
            [ 'not calibrated', { heldOut: Share.of(18, 20), heldOutFailsCaught: Share.of(3, 5) }, 'fails 3 of 5 (60%) of the held-out runs the reviewer failed, under two thirds' ],
            [ 'calibrated', { heldOut: Share.of(17, 20), heldOutFailsCaught: Share.of(2, 3) }, 'agrees with 17 of 20 (85%) held-out verdicts, and fails 2 of 3 (67%) of the held-out runs the reviewer failed' ],
        ])('decides an item is %s, as the protocol says', (status, evidence, why) => {
            const decision = protocol.decide(evidence);

            expect(decision.status).toBe(status);
            expect(decision.why).toContain(why);
        });

        it('takes other thresholds, and says them in its decisions and in the report', () => {
            const strict = new CalibrationProtocol({ sessionsPerRun: 5, agreement: 0.9, minHeldOut: 20, minFails: 4, caught: { fraction: 3 / 4, words: 'three quarters' } });

            expect(strict.decide({ heldOut: Share.of(18, 19), heldOutFailsCaught: Share.of(4, 4) }).why).toBe('19 held-out verdicts, of the 20 it needs');
            expect(strict.decide({ heldOut: Share.of(18, 20), heldOutFailsCaught: Share.of(4, 4) }).status).toBe('calibrated');
            expect(strict.decide({ heldOut: Share.of(18, 20), heldOutFailsCaught: Share.of(2, 4) }).why).toBe('fails 2 of 4 (50%) of the held-out runs the reviewer failed, under three quarters');
            expect(renderCalibration(reportOf([]), strict)).toContain('Each run is judged by 5 sessions');
            expect(renderCalibration(reportOf([]), strict)).toContain('at least 90% of at least 20 held-out verdicts, and, where the reviewer failed it in at least 4 held-out verdicts, fails at least three quarters of those runs too.');
        });

        it("decides from the held-out fails only, so failures the guide cites can't calibrate an item, and keeps every run's count in the report", () => {
            const report = reportOf([
                ...Array.from({ length: 10 }, (_, index) => compare('structure', 'pass', judged('pass', 'pass', 'pass'), { run: `pass${ index }` })),
                compare('structure', 'fail', judged('pass', 'pass', 'pass'), { run: 'missed' }),
                compare('structure', 'fail', judged('fail', 'fail', 'fail'), { run: 'cited1', heldOut: false }),
                compare('structure', 'fail', judged('fail', 'fail', 'fail'), { run: 'cited2', heldOut: false }),
            ]);

            expect(report.items[0]).toMatchObject({
                heldOut: Share.of(10, 11),
                failsCaught: Share.of(2, 3),
                heldOutFailsCaught: Share.of(0, 1),
                status: 'calibrated against false alarms only',
            });
            expect(renderCalibration(report, protocol)).toContain('| 2 of 3 (67%) | 0 of 1 (0%) |');
        });

        it('reports each round, and every disagreement with the sessions\' reasons', () => {
            const report = reportOf([
                compare('structure', 'fail', judged('pass', 'pass', 'fail'), { run: 'aaaaaaaa' }),
                compare('grouping', 'pass', judged('pass', 'pass', 'pass'), { run: 'aaaaaaaa' }),
                compare('structure', 'pass', judged('pass', 'pass', 'pass'), { round: 'regression', run: 'bbbbbbbb', heldOut: false }),
            ]);

            expect(JSON.parse(JSON.stringify(report.rounds))).toEqual([
                { round: 'focus', agreement: { count: 1, of: 2 }, heldOut: { count: 1, of: 2 } },
                { round: 'regression', agreement: { count: 1, of: 1 }, heldOut: { count: 0, of: 0 } },
            ]);
            expect(report.disagreements).toEqual([ { round: 'focus', run: 'aaaaaaaa', item: 'structure', reviewer: 'fail', judge: 'pass', heldOut: true, reasons: [ "pass: it's pass", "pass: it's pass", "fail: it's fail" ] } ]);

            const markdown = renderCalibration(report, protocol);
            expect(markdown).toContain('| structure | 1 / 1 / 0 | 1 of 2 (50%) | 0 of 1 (0%) | 0 of 1 (0%) | 0 of 1 (0%) | 1 of 2 (50%) | too few held-out verdicts: 1 held-out verdict, of the 10 it needs |');
            expect(markdown).toContain('| regression | 1 of 1 (100%) | 0 of 0 (n/a) |');
            expect(markdown).toContain('### structure\n\n- **focus aaaaaaaa**: the reviewer says fail, the judge pass\n  - pass: it\'s pass\n');
            expect(markdown).toContain('6 sessions, 2 of them retried, 1 left no verdicts the harness could use. They used 4.5 credits, and took 6 minutes.');
        });

        it('places each comparison in one column of where the judge differs, or none when it agrees', () => {
            expect(compare('structure', 'pass', judged('fail', 'fail', 'pass')).difference()).toBe('reviewerPassJudgeFail');
            expect(compare('structure', 'fail', judged('pass', 'pass', 'pass')).difference()).toBe('reviewerFailJudgePass');
            expect(compare('structure', 'n/a', judged('pass', 'pass', 'pass')).difference()).toBe('otherNa');
            expect(compare('structure', 'fail', judged('n/a', 'n/a', 'pass')).difference()).toBe('otherNa');
            expect(compare('structure', 'pass', judged('pass', 'pass', 'fail')).difference()).toBeUndefined();
            expect(compare('structure', 'pass', judged(undefined, undefined, undefined)).isJudged()).toBe(false);
        });
    });

    describe('Calibration', () => {

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
        function fakeJudge(model = 'claude-sonnet-5.5') {
            const seen: string[] = [];
            const prompts: string[] = [];
            const spawn: Spawn = async (command, args, options) => {
                const after = join(options.cwd, 'after', 'README.md');
                seen.push(existsSync(after) ? readFileSync(after, 'utf8') : '(no project)');
                prompts.push(args.at(-1)!);
                writeFileSync(options.stdout, readFileSync(join(import.meta.dirname, 'fixtures', 'kiro-v3.judge.synthetic.jsonl'), 'utf8').replaceAll('claude-sonnet-5.5', model));
                writeFileSync(options.stderr, '');
                writeFileSync(join(options.cwd, 'verdicts.json'), JSON.stringify({ verdicts: CHECKLIST.map(item => item.id === 'structure'
                    ? { rule: item.id, verdict: 'pass', evidence: [ 'after/README.md:1: Node.js 22 or later' ], reason: 'It changes only the README.' }
                    : { rule: item.id, verdict: 'n/a', evidence: [], reason: 'Nothing it applies to.' }) }));
                return { exitCode: 0, durationMs: 1000, timedOut: false } satisfies Finished;
            };
            return { spawn, seen, prompts };
        }

        const calibration = (spawn: Spawn, { version = 'kiro-cli 3.5.0', model = 'claude-sonnet-5.5' } = {}) => calibrationOf(
            { template, out: join(root, 'out'), work: join(root, 'work') },
            { config: { ...config, judge: { agent: 'kiro', model } }, env: { PATH: '/usr/bin', KIRO_API_KEY: 'k' }, spawn, version, protocol: new CalibrationProtocol({ sessionsPerRun: 2 }), log: () => {} },
        );

        it("judges each reviewed run as many times as the protocol says, and compares the judge's verdicts with the reviewer's", async () => {
            const { spawn, seen } = fakeJudge();

            const report = await calibration(spawn).run([ round ]);

            expect(seen.slice(0, 2)).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n' ]);
            expect(report.items.map(item => [ item.item, item.agreement.toJSON() ])).toEqual([ [ 'structure', { count: 1, of: 2 } ], [ 'timeout', { count: 1, of: 1 } ] ]);
            expect(report.sessions).toMatchObject({ sessions: 4, withoutVerdicts: 0, credits: 0.9536 });
            const files = new CalibrationFiles(join(root, 'out'));
            expect(readFileSync(files.markdown, 'utf8')).toContain('# Calibrating the judge');
            expect(JSON.parse(readFileSync(files.json, 'utf8')).entries).toHaveLength(3);
            expect(existsSync(join(files.sessions.output({ round: 'regression', run: 'aaaaaaaa', repeat: 2 }), 'verdicts.json'))).toBe(true);
        });

        it("judges a run whose diff applies to no version of its project from its diff alone, as the reviewer's packet had it, and says so", async () => {
            const { spawn, prompts, seen } = fakeJudge();

            const report = await calibration(spawn).run([ round ]);

            expect(seen).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n', '(no project)', '(no project)' ]);
            expect(prompts.slice(2)).toEqual([ JudgePrompt.forDiffAlone().text, JudgePrompt.forDiffAlone().text ]);
            expect(report.withoutProject).toEqual([ { round: 'regression', run: 'bbbbbbbb', reason: expect.stringContaining("its diff doesn't apply") } ]);
            expect(readFileSync(new CalibrationFiles(join(root, 'out')).markdown, 'utf8')).toContain('- regression bbbbbbbb: its diff doesn\'t apply');
        });

        it('resumes, judging again only the sessions whose prompt or inputs changed', async () => {
            await calibration(fakeJudge().spawn).run([ round ]);

            const again = fakeJudge();
            await calibration(again.spawn).run([ round ]);
            expect(again.seen).toHaveLength(0);

            write(join(round, 'runs', 'aaaaaaaa', 'reply.md'), 'I updated the README.\n');
            const changed = fakeJudge();
            await calibration(changed.spawn).run([ round ]);
            expect(changed.seen).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n' ]);
        });

        it("judges again when the judge's agent, model or version changes, rather than reporting the old judge's verdicts as the new one's", async () => {
            await calibration(fakeJudge().spawn).run([ round ]);

            const newVersion = fakeJudge();
            await calibration(newVersion.spawn, { version: 'kiro-cli 3.6.0' }).run([ round ]);
            expect(newVersion.seen.slice(0, 2)).toEqual([ 'Node.js 22 or later\n', 'Node.js 22 or later\n' ]);

            const newModel = fakeJudge('claude-opus-5.5');
            const report = await calibration(newModel.spawn, { version: 'kiro-cli 3.6.0', model: 'claude-opus-5.5' }).run([ round ]);
            expect(newModel.seen).toHaveLength(4);
            expect(report.judge.toJSON()).toEqual({ agent: 'kiro', model: 'claude-opus-5.5', version: 'kiro-cli 3.6.0' });
            expect(JSON.parse(readFileSync(join(new CalibrationFiles(join(root, 'out')).sessions.output({ round: 'regression', run: 'aaaaaaaa', repeat: 1 }), 'session.json'), 'utf8')).judge)
                .toEqual({ agent: 'kiro', model: 'claude-opus-5.5', version: 'kiro-cli 3.6.0' });
        });

        // a shell expands ~ only at the start of a word, so a second round named with ~ would be looked for under the current directory
        it("shows a command in the README whose every round is named with $HOME or an absolute path, which a shell passes on as they are", () => {
            const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
            const commands = [ ...readme.matchAll(/```bash\n([\s\S]*?)```/g) ].map(block => block[1].replaceAll('\\\n', ' '));
            const rounds = commands.flatMap(command => [ ...command.matchAll(/--rounds\s+("[^"]*"|\S+)/g) ].map(match => match[1].replaceAll('"', '')));

            expect(rounds).not.toHaveLength(0);
            for (const listed of rounds.flatMap(list => list.split(','))) {
                expect(listed).toMatch(/^(\$HOME\/|\/)/);
            }
        });

        it('refuses two rounds of the same name', async () => {
            await expect(calibration(fakeJudge().spawn).run([ round, join(root, 'other', 'regression') ]))
                .rejects.toThrow('two rounds are named regression');
        });
    });
});
