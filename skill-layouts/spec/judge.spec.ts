import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adapterOf, prepareAgentHomes } from '../src/agents/index.ts';
import type { Finished } from '../src/child-processes.ts';
import { JudgeBrief } from '../src/judging/brief.ts';
import { Judge, JudgePrompt, type Spawn } from '../src/judging/judge.ts';
import { JudgeIdentity } from '../src/judging/session-store.ts';
import { StartingProject } from '../src/judging/starting-project.ts';
import { type JudgeDirectory, JudgeWorkspace, nodeFilesystem } from '../src/judging/workspace.ts';
import { JudgeVerdicts, RuleVerdict } from '../src/judging/rule-verdict.ts';
import { harnessBlinding, harnessSkillDirectories } from '../src/harness-skills.ts';
import { Verdict } from '../src/judging/verdict.ts';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);
const blinding = harnessBlinding();

const RULES = [ 'awaiting', 'no-console-log' ];
const verdicts = [
    { rule: 'awaiting', verdict: 'fail', evidence: [ 'after/spec/sum.spec.ts:16: actorCalled(\'Ada\').attemptsTo(' ], reason: 'The new scenario doesn\'t await its attemptsTo.' },
    { rule: 'no-console-log', verdict: 'fail', evidence: [ 'after/spec/sum.spec.ts:15: console.log(\'multiplying\');' ], reason: 'The change adds a console.log.' },
];
const json = (value: unknown) => JSON.stringify(value);
const read = (text: string | undefined) => JudgeVerdicts.read(text, RULES, 'verdicts.json');

describe('the judge', () => {

    describe('Verdict', () => {

        it('is one of pass, fail and n/a, each a single value', () => {
            expect(Verdict.names).toEqual([ 'pass', 'fail', 'n/a' ]);
            expect(Verdict.of('fail')).toBe(Verdict.fail);
            expect(Verdict.notApplicable.isApplicable()).toBe(false);
            expect(JSON.stringify({ verdict: Verdict.pass })).toBe('{"verdict":"pass"}');
        });

        it("reads the reviewer's verdict, a blank as none, and refuses anything else", () => {
            expect(Verdict.fromReview('n/a', 'structure')).toBe(Verdict.notApplicable);
            expect(Verdict.fromReview('', 'structure')).toBeUndefined();
            expect(() => Verdict.fromReview('Pass', 'structure')).toThrow('the review of structure says "Pass", but a verdict is pass, fail or n/a');
        });
    });

    describe('JudgeVerdicts', () => {

        it('reads one verdict per rule, in the order of the rules', () => {
            const read_ = read(json({ verdicts: [ ...verdicts ].reverse() }));

            expect(read_.problems).toEqual([]);
            expect(read_.verdicts?.map(verdict => verdict.toJSON())).toEqual(verdicts);
            expect(read_.verdicts?.[0].verdict).toBe(Verdict.fail);
        });

        it('takes n/a without evidence', () => {
            const na = { rule: 'no-console-log', verdict: 'n/a', evidence: [], reason: 'Nothing is logged.' };
            expect(read(json({ verdicts: [ verdicts[0], na ] })).problems).toEqual([]);
        });

        it.each([
            [ 'no file', undefined, "there's no verdicts.json" ],
            [ 'a file that isn\'t JSON', '{ "verdicts": [', "verdicts.json isn't JSON" ],
            [ 'no list of verdicts', json({ awaiting: 'pass' }), 'verdicts.json: verdicts is missing' ],
            [ 'a rule that isn\'t one', json({ verdicts: [ ...verdicts, { ...verdicts[0], rule: 'structure' } ] }), 'verdicts.json: verdicts[2].rule is "structure", not one of awaiting, no-console-log' ],
            [ 'a rule scored twice', json({ verdicts: [ ...verdicts, verdicts[0] ] }), 'verdicts.json: verdicts[2].rule is "awaiting", which verdicts[0] scored already' ],
            [ 'a verdict that isn\'t one', json({ verdicts: [ { ...verdicts[0], verdict: 'Pass' }, verdicts[1] ] }), 'verdicts.json: verdicts[0].verdict is "Pass", not one of pass, fail, n/a' ],
            [ 'a fail without evidence', json({ verdicts: [ { ...verdicts[0], evidence: [] }, verdicts[1] ] }), 'verdicts.json: verdicts[0].evidence is empty, but a fail needs the lines it rests on' ],
            [ 'evidence that isn\'t a list', json({ verdicts: [ { ...verdicts[0], evidence: 'line 16' }, verdicts[1] ] }), 'verdicts.json: verdicts[0].evidence is "line 16", not a list' ],
            [ 'no reason', json({ verdicts: [ { ...verdicts[0], reason: ' ' }, verdicts[1] ] }), 'verdicts.json: verdicts[0].reason is " ", not a reason that isn\'t blank' ],
            [ 'a rule left out', json({ verdicts: [ verdicts[0] ] }), 'verdicts.json: verdicts has no verdict for no-console-log' ],
        ])('refuses %s, and says why, naming the field as records.ts does', (_, content, problem) => {
            const read_ = read(content);

            expect(read_.isUsable()).toBe(false);
            expect(read_.verdicts).toBeUndefined();
            expect(read_.problems.join('\n')).toContain(problem);
        });
    });

    describe('JudgePrompt', () => {

        it('asks for the verdicts file, and, for a change without its project, says to score its diff', () => {
            expect(JudgePrompt.forProject().text).toContain('Write `verdicts.json` as { "verdicts": [ { "rule", "verdict", "evidence", "reason" } ] }');
            expect(JudgePrompt.forDiffAlone().text).toBe(`${ JudgePrompt.forProject().text }\n\nThis change's project isn't available: there's no \`before/\` or \`after/\`. Score it from \`change.diff\`, whose context lines show the code around each change,\nand give the evidence as \`change.diff:<line>: <code>\`.`);
        });

        it('tells a second session what was wrong with the first one\'s verdicts', () => {
            expect(JudgePrompt.forDiffAlone().retry([ 'one', 'two' ])).toBe(`${ JudgePrompt.forDiffAlone().text }\n\nAn earlier review of this change left a \`verdicts.json\` with these problems. Score the change again, and write \`verdicts.json\` without them:\n\n- one\n- two`);
        });
    });

    describe('JudgeBrief', () => {

        const brief = (overrides: Partial<Parameters<typeof JudgeBrief.of>[0]> = {}) => JudgeBrief.of({
            request: 'Add a scenario that checks that 2 times 3 is 6.',
            diff: 'diff --git a/.kiro/skills/serenity-js-screenplay/SKILL.md b/.kiro/skills/serenity-js-screenplay/SKILL.md\n+as the serenity-js-screenplay skill says\n',
            reply: 'I followed serenity-js-writing-tests.',
            rules: [ { id: 'no-console-log', readme: '# no-console-log\n\nno console.log added' }, { id: 'awaiting', readme: '# awaiting\n\nevery attemptsTo is awaited' } ],
            exercised: [ 'awaiting' ],
            reference: new Map([ [ 'spec/sum.spec.ts', '// the reference\n' ] ]),
            project: StartingProject.of('/work/project', 'the fixture as it is', { before: 'sha256:b', after: 'sha256:a' }),
            ...overrides,
        }, blinding);
        const content = (of: JudgeBrief, path: string) => of.files().find(file => file.path === path)?.content;

        it('gives the judge the request, the change, the reply, the rules and the reference, as files, and the project before and after, as directories', () => {
            expect(brief().files().map(file => file.path)).toEqual([
                'request.md', 'change.diff', 'reply.md', 'rules/no-console-log/README.md', 'rules/awaiting/README.md', 'rules.md', 'reference/spec/sum.spec.ts',
            ]);
            expect(content(brief(), 'request.md')).toBe('Add a scenario that checks that 2 times 3 is 6.\n');
            expect(content(brief(), 'rules/awaiting/README.md')).toBe('# awaiting\n\nevery attemptsTo is awaited\n');
            expect(content(brief(), 'reference/spec/sum.spec.ts')).toBe('// the reference\n');
            expect({ before: brief().before, after: brief().after }).toEqual({ before: '/work/project/before', after: '/work/project/after' });
        });

        it("hides the skills' names and paths in the change and the reply, as the review packets do", () => {
            expect(content(brief(), 'change.diff')).not.toMatch(/serenity-js-|\.kiro\/skills/);
            expect(content(brief(), 'change.diff')).toContain('[skill file]');
            expect(content(brief(), 'reply.md')).toBe('I followed [skill].\n');
        });

        it('lists the rules the request exercises first', () => {
            const rules = content(brief(), 'rules.md')!;

            expect(rules.indexOf('[awaiting]')).toBeLessThan(rules.indexOf('[no-console-log]'));
            expect(rules).toContain('## The rules the request exercises\n\n- [awaiting](rules/awaiting/README.md)\n');
        });

        it("says so when the agent didn't reply", () => {
            expect(content(brief({ reply: '' }), 'reply.md')).toBe('(none: the agent said nothing after its last tool call)\n');
        });

        it("has no project for a change whose project can't be rebuilt, only its diff", () => {
            const withoutProject = brief({ project: undefined });

            expect(withoutProject.hasProject()).toBe(false);
            expect(withoutProject.before).toBeUndefined();
            expect(withoutProject.after).toBeUndefined();
        });

        it("is fingerprinted by what's in it, the projects' hashes, the judge and the prompt, and nothing else", () => {
            const judge = JudgeIdentity.of('kiro', 'claude-sonnet-5.5', 'kiro-cli 3.5.0');
            const prompt = JudgePrompt.forProject();
            const fingerprint = brief().fingerprint(judge, prompt);

            expect(brief().fingerprint(judge, prompt).equals(fingerprint)).toBe(true);
            expect(brief({ project: StartingProject.of('/elsewhere', 'another label', { before: 'sha256:b', after: 'sha256:a' }) }).fingerprint(judge, prompt).equals(fingerprint)).toBe(true);
            for (const other of [
                brief({ reply: 'Something else.' }).fingerprint(judge, prompt),
                brief({ reference: new Map() }).fingerprint(judge, prompt),
                brief({ project: StartingProject.of('/work/project', 'the fixture as it is', { before: 'sha256:b', after: 'sha256:other' }) }).fingerprint(judge, prompt),
                brief({ project: undefined }).fingerprint(judge, prompt),
                brief().fingerprint(JudgeIdentity.of('kiro', 'claude-sonnet-5.5', 'kiro-cli 3.6.0'), prompt),
                brief().fingerprint(judge, JudgePrompt.forDiffAlone()),
            ]) {
                expect(other.equals(fingerprint)).toBe(false);
            }
        });
    });

    describe('JudgeWorkspace', () => {

        let root: string;
        let brief: JudgeBrief;
        const names = (...given: string[]) => () => given.shift()!;

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-judge-'));
            for (const side of [ 'before', 'after' ]) {
                mkdirSync(join(root, 'project', side, 'spec'), { recursive: true });
                mkdirSync(join(root, 'project', side, '.git'), { recursive: true });
                mkdirSync(join(root, 'project', side, 'node_modules', '@serenity-js', 'core', 'skills'), { recursive: true });
                writeFileSync(join(root, 'project', side, 'spec', 'sum.spec.ts'), `// ${ side }\n`);
            }
            brief = JudgeBrief.of({
                request: 'Add a scenario.', diff: '', reply: 'Done.', rules: [ { id: 'awaiting', readme: '# awaiting' } ], exercised: [], reference: new Map([ [ 'spec/sum.spec.ts', '// the reference\n' ] ]),
                project: StartingProject.of(join(root, 'project'), 'the fixture as it is', { before: 'b', after: 'a' }),
            }, blinding);
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        const workspace = (randomName: () => string) => new JudgeWorkspace({ root: join(root, 'judge'), filesystem: nodeFilesystem(), randomName });

        it("writes the brief's files into a directory of a new random name, and its projects as before/ and after/", () => {
            const directory = workspace(names('3f2a1b9c')).prepare(brief);

            expect(directory.path).toBe(join(root, 'judge', '3f2a1b9c'));
            expect(readFileSync(join(directory.path, 'request.md'), 'utf8')).toBe('Add a scenario.\n');
            expect(readFileSync(join(directory.path, 'reference', 'spec', 'sum.spec.ts'), 'utf8')).toBe('// the reference\n');
            expect(readFileSync(join(directory.path, 'before', 'spec', 'sum.spec.ts'), 'utf8')).toBe('// before\n');
            expect(readFileSync(join(directory.path, 'after', 'spec', 'sum.spec.ts'), 'utf8')).toBe('// after\n');
        });

        it('leaves out git and node_modules, where the skills are installed', () => {
            const directory = workspace(names('one')).prepare(brief);

            for (const side of [ 'before', 'after' ]) {
                expect(existsSync(join(directory.path, side, '.git'))).toBe(false);
                expect(existsSync(join(directory.path, side, 'node_modules'))).toBe(false);
            }
        });

        it("gives the judge no project for a brief without one, only its diff", () => {
            const directory = workspace(names('one')).prepare(JudgeBrief.of({ request: 'r', diff: 'd', reply: '', rules: [], exercised: [], reference: new Map() }, blinding));

            expect(existsSync(join(directory.path, 'before'))).toBe(false);
            expect(existsSync(join(directory.path, 'after'))).toBe(false);
            expect(readFileSync(join(directory.path, 'change.diff'), 'utf8')).toBe('d');
        });

        it('reads the verdicts the judge left in its directory, and removes it', () => {
            const one = workspace(names('one', 'other')).prepare(brief);
            writeFileSync(join(one.path, 'verdicts.json'), json({ verdicts: [ { ...verdicts[0], rule: 'awaiting' } ] }));

            expect(one.verdicts([ 'awaiting' ]).isUsable()).toBe(true);
            expect(workspace(names('other')).prepare(brief).verdicts([ 'awaiting' ]).problems).toEqual([ "there's no verdicts.json" ]);
            one.remove();
            expect(existsSync(one.path)).toBe(false);
        });

        it('writes through the filesystem operations it was given, and nothing else', () => {
            const written: string[] = [];
            const copied: string[] = [];
            const recording = new JudgeWorkspace({
                root: '/judge',
                filesystem: { writeFile: path => written.push(path), copyProject: (from, to) => copied.push(`${ from } -> ${ to }`), readFile: () => undefined, remove: () => {} },
                randomName: () => 'x',
            });

            recording.prepare(brief);

            expect(written).toEqual(brief.files().map(file => `/judge/x/${ file.path }`));
            expect(copied).toEqual([ `${ join(root, 'project', 'before') } -> /judge/x/before`, `${ join(root, 'project', 'after') } -> /judge/x/after` ]);
        });
    });

    describe('Judge', () => {

        let root: string;
        let directory: JudgeDirectory;
        let output: string;
        const env = { PATH: '/usr/bin', KIRO_API_KEY: 'kiro-key', GH_TOKEN: 'github-token', AWS_SECRET_ACCESS_KEY: 'aws' };

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-judge-'));
            mkdirSync(join(root, 'before'));
            mkdirSync(join(root, 'after'));
            directory = new JudgeWorkspace({ root, filesystem: nodeFilesystem(), randomName: () => 'judge' })
                .prepare(JudgeBrief.of({ request: 'r', diff: '', reply: '', rules: [], exercised: [], reference: new Map(), project: StartingProject.of(root, 'v', { before: 'b', after: 'a' }) }, blinding));
            output = join(root, 'out');
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        /** A judge that replays a stream, and leaves the verdicts.json each attempt gets, if any. */
        function fakeJudge(attempts: Array<{ stream?: string, verdicts?: string }>, model = 'claude-sonnet-5.5') {
            const calls: Array<{ command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number }> = [];
            const spawn: Spawn = async (command, args, options) => {
                const attempt = attempts[calls.length];
                calls.push({ command, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
                cpSync(fixture(attempt.stream ?? 'kiro-v3.judge.synthetic.jsonl'), options.stdout);
                writeFileSync(options.stderr, '');
                if (attempt.verdicts !== undefined) {
                    writeFileSync(join(options.cwd, 'verdicts.json'), attempt.verdicts);
                }
                return { exitCode: 0, durationMs: 21_000, timedOut: false } satisfies Finished;
            };
            const judge = new Judge({ adapter: adapterOf('kiro'), model, homes: prepareAgentHomes(join(root, 'homes'), join(root, 'npm-cache')), spawn, env, timeoutMs: 120_000, prompt: JudgePrompt.forProject(), skills: harnessSkillDirectories() });
            return { judge, calls };
        }

        it('runs the agent in its directory, with the prompt, and reads its verdicts and its cost from its stream', async () => {
            const { judge, calls } = fakeJudge([ { verdicts: json({ verdicts }) } ]);

            const session = await judge.judge(directory, RULES, output);

            expect(session.attempts).toHaveLength(1);
            expect({ exitCode: session.exitCode, timedOut: session.timedOut, durationMs: session.durationMs, credits: session.credits, models: session.models, problems: session.problems })
                .toEqual({ exitCode: 0, timedOut: false, durationMs: 21_000, credits: 0.2384, models: [ 'claude-sonnet-5.5' ], problems: [] });
            expect(session.verdicts?.map(verdict => verdict.toJSON())).toEqual(verdicts);
            expect(session.verdictOn('no-console-log')?.reason).toBe('The change adds a console.log.');
            expect(calls[0]).toMatchObject({ command: 'kiro-cli', cwd: directory.path, timeoutMs: 120_000 });
            expect(calls[0].args).toEqual(expect.arrayContaining([ '--sandbox', '--model', 'claude-sonnet-5.5', JudgePrompt.forProject().text ]));
            expect(existsSync(join(output, 'stream.jsonl'))).toBe(true);
        });

        it("gives the judge's agent only its own credential, as an agent's run gets, and a fresh home for each session", async () => {
            const { judge, calls } = fakeJudge([ { verdicts: json({ verdicts }) } ]);
            writeFileSync(join(root, 'homes', 'kiro', 'left-by-an-earlier-session'), '');

            await judge.judge(directory, RULES, output);

            expect(calls[0].env).toMatchObject({ KIRO_API_KEY: 'kiro-key', HOME: join(root, 'homes', 'home') });
            expect(calls[0].env).not.toHaveProperty('GH_TOKEN');
            expect(calls[0].env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
            expect(existsSync(join(root, 'homes', 'kiro', 'left-by-an-earlier-session'))).toBe(false);
            expect(existsSync(join(root, 'homes', 'kiro', 'settings', 'sandbox.json'))).toBe(true);
        });

        it('runs a second attempt when the first leaves no verdicts it can use, tells it what was wrong, and adds up their cost', async () => {
            const { judge, calls } = fakeJudge([ { verdicts: json({ verdicts: [ verdicts[0] ] }) }, { verdicts: json({ verdicts }) } ]);

            const session = await judge.judge(directory, RULES, output);

            expect(session.attempts).toHaveLength(2);
            expect(session.wasRetried()).toBe(true);
            expect({ problems: session.problems, durationMs: session.durationMs, credits: session.credits }).toEqual({ problems: [], durationMs: 42_000, credits: 0.4768 });
            expect(session.verdicts).toHaveLength(2);
            expect(calls[1].args.at(-1)).toContain('- verdicts.json: verdicts has no verdict for no-console-log');
            expect(existsSync(join(output, 'stream.2.jsonl'))).toBe(true);
            expect(existsSync(join(output, 'agent.2.log'))).toBe(true);
        });

        it("records the problems when the second attempt's verdicts can't be used either", async () => {
            const { judge, calls } = fakeJudge([ {}, { verdicts: '{ "verdicts": [' } ]);

            const session = await judge.judge(directory, RULES, output);

            expect(calls).toHaveLength(2);
            expect(session.verdicts).toBeUndefined();
            expect(session.problems[0]).toContain("verdicts.json isn't JSON");
        });

        it('judges with the prompt it was given', async () => {
            const { judge, calls } = fakeJudge([ { verdicts: json({ verdicts }) } ]);

            await judge.withPrompt(JudgePrompt.forDiffAlone()).judge(directory, RULES, output);

            expect(calls[0].args.at(-1)).toBe(JudgePrompt.forDiffAlone().text);
        });

        it('stops when the stream reports a model other than the pinned one', async () => {
            const { judge } = fakeJudge([ { verdicts: json({ verdicts }) } ], 'claude-opus-5.5');

            await expect(judge.judge(directory, RULES, output)).rejects.toThrow('the run used claude-sonnet-5.5, but config.json pins claude-opus-5.5');
        });

        // recorded when Kiro couldn't start its engine, inside another sandbox
        it("stops, rather than counting a session without verdicts, when the agent didn't start", async () => {
            const { judge } = fakeJudge([ { stream: 'kiro-v3.judge-launch-error.jsonl' } ]);

            await expect(judge.judge(directory, RULES, output)).rejects.toThrow(/doesn't look like Kiro's ACP stream-json/);
        });
    });

    describe('RuleVerdict', () => {

        it('says its verdict and reason, as the reports list them', () => {
            expect(RuleVerdict.of('awaiting', Verdict.fail, [ 'a.ts:1: a' ], 'Not awaited.').toString()).toBe('fail: Not awaited.');
        });
    });
});
