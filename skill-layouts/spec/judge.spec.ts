import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareAgentHomes } from '../src/agents/index.ts';
import type { Finished } from '../src/child-processes.ts';
import { judge, JUDGE_PROMPT, type JudgeInput, type JudgeVerdict, prepareJudgeDirectory, type Spawn, verdictsOf } from '../src/judge.ts';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name);

const RULES = [ 'awaiting', 'no-console-log' ];
const verdicts: JudgeVerdict[] = [
    { rule: 'awaiting', verdict: 'fail', evidence: [ 'after/spec/sum.spec.ts:16: actorCalled(\'Ada\').attemptsTo(' ], reason: 'The new scenario doesn\'t await its attemptsTo.' },
    { rule: 'no-console-log', verdict: 'fail', evidence: [ 'after/spec/sum.spec.ts:15: console.log(\'multiplying\');' ], reason: 'The change adds a console.log.' },
];
const json = (value: unknown) => JSON.stringify(value);

describe('the judge', () => {

    describe('verdictsOf', () => {

        it('reads one verdict per rule, in the order of the rules', () => {
            expect(verdictsOf(json({ verdicts: [ ...verdicts ].reverse() }), RULES)).toEqual({ verdicts, problems: [] });
        });

        it('takes n/a without evidence', () => {
            const na = { rule: 'no-console-log', verdict: 'n/a', evidence: [], reason: 'Nothing is logged.' };
            expect(verdictsOf(json({ verdicts: [ verdicts[0], na ] }), RULES).problems).toEqual([]);
        });

        it.each([
            [ 'no file', undefined, "there's no verdicts.json" ],
            [ 'a file that isn\'t JSON', '{ "verdicts": [', "verdicts.json isn't JSON" ],
            [ 'no list of verdicts', json({ awaiting: 'pass' }), 'verdicts.json has no "verdicts" list' ],
            [ 'a rule that isn\'t one', json({ verdicts: [ ...verdicts, { ...verdicts[0], rule: 'structure' } ] }), "structure isn't one of the rules" ],
            [ 'a rule scored twice', json({ verdicts: [ ...verdicts, verdicts[0] ] }), 'awaiting is scored more than once' ],
            [ 'a verdict that isn\'t one', json({ verdicts: [ { ...verdicts[0], verdict: 'Pass' }, verdicts[1] ] }), 'awaiting\'s verdict is "Pass", not "pass", "fail" or "n/a"' ],
            [ 'a fail without evidence', json({ verdicts: [ { ...verdicts[0], evidence: [] }, verdicts[1] ] }), 'awaiting is fail, but names no evidence' ],
            [ 'evidence that isn\'t a list', json({ verdicts: [ { ...verdicts[0], evidence: 'line 16' }, verdicts[1] ] }), "awaiting's evidence isn't a list of lines" ],
            [ 'no reason', json({ verdicts: [ { ...verdicts[0], reason: ' ' }, verdicts[1] ] }), 'awaiting gives no reason' ],
            [ 'a rule left out', json({ verdicts: [ verdicts[0] ] }), 'no verdict for no-console-log' ],
        ])('refuses %s, and says why', (_, content, problem) => {
            const { verdicts: read, problems } = verdictsOf(content, RULES);
            expect(read).toBeUndefined();
            expect(problems.join('\n')).toContain(problem);
        });
    });

    describe('prepareJudgeDirectory', () => {

        let root: string;
        let input: JudgeInput;

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-judge-'));
            for (const side of [ 'before', 'after' ]) {
                mkdirSync(join(root, side, 'spec'), { recursive: true });
                mkdirSync(join(root, side, '.git'), { recursive: true });
                mkdirSync(join(root, side, 'node_modules', '@serenity-js', 'core', 'skills'), { recursive: true });
                writeFileSync(join(root, side, 'spec', 'sum.spec.ts'), `// ${ side }\n`);
            }
            input = {
                request: 'Add a scenario that checks that 2 times 3 is 6.',
                diff: 'diff --git a/.kiro/skills/serenity-js-screenplay/SKILL.md b/.kiro/skills/serenity-js-screenplay/SKILL.md\n+as the serenity-js-screenplay skill says\n',
                reply: 'I followed serenity-js-writing-tests.',
                before: join(root, 'before'),
                after: join(root, 'after'),
                rules: [ { id: 'no-console-log', readme: '# no-console-log\n\nno console.log added' }, { id: 'awaiting', readme: '# awaiting\n\nevery attemptsTo is awaited' } ],
                exercised: [ 'awaiting' ],
                reference: new Map([ [ 'spec/sum.spec.ts', '// the reference\n' ] ]),
            };
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        const read = (path: string) => readFileSync(join(root, 'judge', path), 'utf8');

        it('gives the judge the request, the change, the reply, the project before and after, the rules and the reference', () => {
            prepareJudgeDirectory(join(root, 'judge'), input);

            expect(read('request.md')).toBe('Add a scenario that checks that 2 times 3 is 6.\n');
            expect(read('before/spec/sum.spec.ts')).toBe('// before\n');
            expect(read('after/spec/sum.spec.ts')).toBe('// after\n');
            expect(read('rules/awaiting/README.md')).toBe('# awaiting\n\nevery attemptsTo is awaited\n');
            expect(read('reference/spec/sum.spec.ts')).toBe('// the reference\n');
        });

        it("hides the skills' names and paths in the change and the reply, as the review packets do", () => {
            prepareJudgeDirectory(join(root, 'judge'), input);

            expect(read('change.diff')).not.toMatch(/serenity-js-|\.kiro\/skills/);
            expect(read('change.diff')).toContain('[skill file]');
            expect(read('reply.md')).toBe('I followed [skill].\n');
        });

        it('leaves out git and node_modules, where the skills are installed', () => {
            prepareJudgeDirectory(join(root, 'judge'), input);

            for (const side of [ 'before', 'after' ]) {
                expect(existsSync(join(root, 'judge', side, '.git'))).toBe(false);
                expect(existsSync(join(root, 'judge', side, 'node_modules'))).toBe(false);
            }
        });

        it('lists the rules the request exercises first', () => {
            prepareJudgeDirectory(join(root, 'judge'), input);

            const rules = read('rules.md');
            expect(rules.indexOf('[awaiting]')).toBeLessThan(rules.indexOf('[no-console-log]'));
            expect(rules).toContain('## The rules the request exercises\n\n- [awaiting](rules/awaiting/README.md)\n');
        });

        it("says so when the agent didn't reply", () => {
            prepareJudgeDirectory(join(root, 'judge'), { ...input, reply: '' });

            expect(read('reply.md')).toBe('(none: the agent said nothing after its last tool call)\n');
        });

        it("gives the judge no project for a change whose project can't be rebuilt, only its diff", () => {
            prepareJudgeDirectory(join(root, 'judge'), { ...input, before: undefined, after: undefined });

            expect(existsSync(join(root, 'judge', 'before'))).toBe(false);
            expect(existsSync(join(root, 'judge', 'after'))).toBe(false);
            expect(read('change.diff')).toContain('[skill file]');
        });
    });

    describe('judge', () => {

        let root: string;
        let directory: string;
        let output: string;
        const config = { judge: { agent: 'kiro' as const, model: 'claude-sonnet-5.5' }, runTimeoutMinutes: 2 };
        const env = { PATH: '/usr/bin', KIRO_API_KEY: 'kiro-key', GH_TOKEN: 'github-token', AWS_SECRET_ACCESS_KEY: 'aws' };

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-judge-'));
            directory = join(root, 'judge');
            output = join(root, 'out');
            mkdirSync(directory, { recursive: true });
        });
        afterEach(() => rmSync(root, { recursive: true, force: true }));

        const homes = () => prepareAgentHomes(join(root, 'homes'), join(root, 'npm-cache'));

        /** A judge that replays a stream, and leaves the verdicts.json each attempt gets, if any. */
        function fakeJudge(attempts: Array<{ stream?: string, verdicts?: string }>) {
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
            return { spawn, calls };
        }

        it('runs the agent in its directory, with the prompt, and reads its verdicts and its cost from its stream', async () => {
            const { spawn, calls } = fakeJudge([ { verdicts: json({ verdicts }) } ]);

            const session = await judge(directory, RULES, { config, homes: homes(), output, env, spawn });

            expect(session).toEqual({ attempts: 1, exitCode: 0, timedOut: false, durationMs: 21_000, credits: 0.2384, models: [ 'claude-sonnet-5.5' ], problems: [], verdicts });
            expect(calls[0]).toMatchObject({ command: 'kiro-cli', cwd: directory, timeoutMs: 120_000 });
            expect(calls[0].args).toEqual(expect.arrayContaining([ '--sandbox', '--model', 'claude-sonnet-5.5', JUDGE_PROMPT ]));
            expect(existsSync(join(output, 'stream.jsonl'))).toBe(true);
        });

        it("gives the judge's agent only its own credential, as an agent's run gets", async () => {
            const { spawn, calls } = fakeJudge([ { verdicts: json({ verdicts }) } ]);

            await judge(directory, RULES, { config, homes: homes(), output, env, spawn });

            expect(calls[0].env).toMatchObject({ KIRO_API_KEY: 'kiro-key', HOME: join(root, 'homes', 'home') });
            expect(calls[0].env).not.toHaveProperty('GH_TOKEN');
            expect(calls[0].env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        });

        it('runs a second session when the first leaves no verdicts it can use, and tells it what was wrong', async () => {
            const { spawn, calls } = fakeJudge([ { verdicts: json({ verdicts: [ verdicts[0] ] }) }, { verdicts: json({ verdicts }) } ]);

            const session = await judge(directory, RULES, { config, homes: homes(), output, env, spawn });

            expect(session).toMatchObject({ attempts: 2, verdicts, problems: [], durationMs: 42_000, credits: 0.4768 });
            expect(calls[1].args.at(-1)).toContain('- no verdict for no-console-log');
            expect(existsSync(join(output, 'stream.2.jsonl'))).toBe(true);
            expect(existsSync(join(output, 'agent.2.log'))).toBe(true);
        });

        it("records the problems when the second session's verdicts can't be used either", async () => {
            const { spawn, calls } = fakeJudge([ {}, { verdicts: '{ "verdicts": [' } ]);

            const session = await judge(directory, RULES, { config, homes: homes(), output, env, spawn });

            expect(calls).toHaveLength(2);
            expect(session.verdicts).toBeUndefined();
            expect(session.problems[0]).toContain("verdicts.json isn't JSON");
        });

        it('stops when the stream reports a model other than the pinned one', async () => {
            const { spawn } = fakeJudge([ { verdicts: json({ verdicts }) } ]);

            await expect(judge(directory, RULES, { config: { ...config, judge: { agent: 'kiro', model: 'claude-opus-5.5' } }, homes: homes(), output, env, spawn }))
                .rejects.toThrow('the run used claude-sonnet-5.5, but config.json pins claude-opus-5.5');
        });

        // recorded when Kiro couldn't start its engine, inside another sandbox
        it("stops, rather than counting a session without verdicts, when the agent didn't start", async () => {
            const { spawn } = fakeJudge([ { stream: 'kiro-v3.judge-launch-error.jsonl' } ]);

            await expect(judge(directory, RULES, { config, homes: homes(), output, env, spawn }))
                .rejects.toThrow(/doesn't look like Kiro's ACP stream-json/);
        });
    });
});
