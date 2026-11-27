// The judge: an agent, in a session of its own, that scores a run's change against every rule of the checklist, as the
// reviewer does, from a directory that holds the request, the change, the project before and after it, the rules and
// a reference solution. It's never told the layout, the agent or the run: the diff and the reply are blinded, and its
// directory has a random name. Its verdicts don't count anywhere until a Calibration has compared them with the
// reviewer's; see the README.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AgentAdapter, AgentHomes } from '../agents/index.ts';
import type { Finished, spawnWithTimeout } from '../child-processes.ts';
import { hashOf } from '../conditions.ts';
import { blinded } from '../review.ts';
import { agentEnvironment, modelProblem } from '../runs.ts';
import type { Trace } from '../streams.ts';
import { JudgeVerdicts, RuleVerdict } from './rule-verdict.ts';

/** A rule, as the judge reads it: its id, and its README, which says what it asks for and how earlier decisions settled it. */
export interface JudgeRule {
    id: string;
    readme: string;
}

/** What the judge is given about one change. */
export interface JudgeInput {
    /** The request, with the local API server's URLs filled in */
    request: string;
    diff: string;
    reply: string;
    /**
     * Directories: the project as the agent found it, and as it left it. Without them, as for a recorded run whose
     * project can't be rebuilt any more, the judge scores the change from its diff, as the reviewer's packet had it
     */
    before?: string;
    after?: string;
    /** Every rule, in the order the judge scores them: those the request exercises first */
    rules: JudgeRule[];
    /** The ids of the rules the request exercises */
    exercised: string[];
    /** A reference solution's files, by their paths in the project, without the marker of their expected value */
    reference: Map<string, string>;
}

/** What the judge is asked to do: score every rule, and write its verdicts to the directory's verdicts file. */
export class JudgePrompt {

    /** For a change with its project before and after */
    static forProject(): JudgePrompt {
        return new JudgePrompt(JudgePrompt.lines(JudgeDirectory.verdictsFile).join('\n'));
    }

    /** For a change whose project isn't there, only its diff */
    static forDiffAlone(): JudgePrompt {
        return new JudgePrompt([
            JudgePrompt.forProject().text,
            '',
            "This change's project isn't available: there's no `before/` or `after/`. Score it from `change.diff`, whose context lines show the code around each change,",
            'and give the evidence as `change.diff:<line>: <code>`.',
        ].join('\n'));
    }

    private static lines(verdicts: string): string[] {
        return [
            'You are reviewing a change that a coding agent made to a project, in reply to the request in `request.md`.',
            '`before/` is the project as the agent found it, `after/` is the project as it left it, and `change.diff` is the difference.',
            '`reply.md` is what the agent said when it finished.',
            '',
            'Score the change against every rule in `rules/`, in the order `rules.md` lists them.',
            "Each rule's `README.md` says what it asks for, and how earlier decisions settled the cases it leaves open.",
            'Score only the code the change added or changed:',
            '',
            '- pass: the added code does what the rule asks, somewhere the rule applies',
            '- fail: the added code does what the rule forbids, anywhere',
            '- n/a: the added code has nothing the rule applies to',
            '',
            '`reference/` is one good answer to the same request. Use it to see what the rules look like when they\'re followed.',
            "Don't score how close the change is to it: a different answer that follows the rules passes.",
            '',
            `Don't change any file except \`${ verdicts }\`. Don't run the project's tests.`,
            `Write \`${ verdicts }\` as { "verdicts": [ { "rule", "verdict", "evidence", "reason" } ] }, with one entry for every rule:`,
            '',
            '- verdict: "pass", "fail" or "n/a"',
            '- evidence: the lines your verdict rests on, each as `after/<path>:<line>: <code>`, or `reply.md` for a rule about what the agent said. Leave it empty only for n/a',
            '- reason: one or two sentences',
        ];
    }

    readonly text: string;

    private constructor(text: string) {
        this.text = text;
    }

    /** The prompt of a second session, when the first left no verdicts the harness can use, telling it what was wrong */
    retry(problems: readonly string[]): string {
        const verdicts = JudgeDirectory.verdictsFile;
        return [
            this.text,
            '',
            `An earlier review of this change left a \`${ verdicts }\` with these problems. Score the change again, and write \`${ verdicts }\` without them:`,
            '',
            ...problems.map(problem => `- ${ problem }`),
        ].join('\n');
    }
}

const NO_REPLY = '(none: the agent said nothing after its last tool call)';

/** The project's files, without anything the harness or git put there. */
const isProjectFile = (source: string) => ! source.split(/[/\\]/).some(part => part === '.git' || part === 'node_modules');

/** The directory the judge works in, with what it's given, and the verdicts it leaves. */
export class JudgeDirectory {

    /** The file the judge writes its verdicts to */
    static readonly verdictsFile = 'verdicts.json';

    /** Writes what the judge is given into the empty directory at `path`. */
    static prepare(path: string, input: JudgeInput): JudgeDirectory {
        const write = (file: string, content: string) => {
            mkdirSync(dirname(join(path, file)), { recursive: true });
            writeFileSync(join(path, file), content);
        };
        mkdirSync(path, { recursive: true });
        write('request.md', `${ input.request.trim() }\n`);
        write('change.diff', blinded(input.diff));
        write('reply.md', `${ blinded(input.reply).trim() || NO_REPLY }\n`);
        for (const [ side, source ] of [ [ 'before', input.before ], [ 'after', input.after ] ] as const) {
            if (source !== undefined) {
                cpSync(source, join(path, side), { recursive: true, filter: isProjectFile });
            }
        }
        for (const rule of input.rules) {
            write(join('rules', rule.id, 'README.md'), `${ rule.readme.trim() }\n`);
        }
        const listed = (rules: JudgeRule[]) => rules.map(rule => `- [${ rule.id }](rules/${ rule.id }/README.md)`);
        write('rules.md', [
            '# The rules',
            '',
            '## The rules the request exercises',
            '',
            ...listed(input.rules.filter(rule => input.exercised.includes(rule.id))),
            '',
            '## The other rules, which apply wherever the added code is about them',
            '',
            ...listed(input.rules.filter(rule => ! input.exercised.includes(rule.id))),
            '',
        ].join('\n'));
        for (const [ file, content ] of input.reference) {
            write(join('reference', file), content);
        }
        return new JudgeDirectory(path);
    }

    readonly path: string;

    private constructor(path: string) {
        this.path = path;
    }

    /** The verdicts the judge left on `rules`, or what's wrong with them */
    verdicts(rules: readonly string[]): JudgeVerdicts {
        const file = join(this.path, JudgeDirectory.verdictsFile);
        return JudgeVerdicts.read(existsSync(file) ? readFileSync(file, 'utf8') : undefined, rules, JudgeDirectory.verdictsFile);
    }

    /** The hash of everything in the directory, which is everything the judge is given */
    hash(): string {
        return hashOf(this.path);
    }

    remove(): void {
        rmSync(this.path, { recursive: true, force: true });
    }
}

/** One attempt of a judge's session: the agent's run, and the verdicts it left. */
export class JudgeAttempt {

    static of(finished: Finished, trace: Pick<Trace, 'credits' | 'models'>, verdicts: JudgeVerdicts): JudgeAttempt {
        return new JudgeAttempt(finished.exitCode, finished.timedOut, finished.durationMs, trace.credits, trace.models, verdicts.problems, verdicts.verdicts);
    }

    static fromJSON(json: ReturnType<JudgeAttempt['toJSON']>): JudgeAttempt {
        return new JudgeAttempt(json.exitCode, json.timedOut, json.durationMs, json.credits ?? undefined, json.models, json.problems, json.verdicts?.map(verdict => RuleVerdict.fromJSON(verdict)));
    }

    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly durationMs: number;
    readonly credits: number | undefined;
    readonly models: readonly string[];
    /** What was wrong with the attempt's verdicts; none when it left usable ones */
    readonly problems: readonly string[];
    readonly verdicts: readonly RuleVerdict[] | undefined;

    private constructor(
        exitCode: number,
        timedOut: boolean,
        durationMs: number,
        credits: number | undefined,
        models: readonly string[],
        problems: readonly string[],
        verdicts: readonly RuleVerdict[] | undefined,
    ) {
        this.exitCode = exitCode;
        this.timedOut = timedOut;
        this.durationMs = durationMs;
        this.credits = credits;
        this.models = models;
        this.problems = problems;
        this.verdicts = verdicts;
    }

    toJSON() {
        return {
            exitCode: this.exitCode,
            timedOut: this.timedOut,
            durationMs: this.durationMs,
            credits: this.credits,
            models: this.models,
            problems: this.problems,
            verdicts: this.verdicts?.map(verdict => verdict.toJSON()),
        };
    }
}

/** A judge's session: its attempts, a second one only when the first left no verdicts the harness could use. */
export class JudgeSession {

    static of(attempts: readonly JudgeAttempt[]): JudgeSession {
        return new JudgeSession(attempts);
    }

    static fromJSON(json: { attempts: Array<ReturnType<JudgeAttempt['toJSON']>> }): JudgeSession {
        return new JudgeSession(json.attempts.map(attempt => JudgeAttempt.fromJSON(attempt)));
    }

    readonly attempts: readonly JudgeAttempt[];

    private constructor(attempts: readonly JudgeAttempt[]) {
        this.attempts = attempts;
    }

    private get last(): JudgeAttempt {
        return this.attempts.at(-1)!;
    }

    /** The last attempt's verdicts, one per rule, if it left usable ones */
    get verdicts(): readonly RuleVerdict[] | undefined {
        return this.last.verdicts;
    }

    /** What was wrong with the last attempt's verdicts */
    get problems(): readonly string[] {
        return this.last.problems;
    }

    get exitCode(): number {
        return this.last.exitCode;
    }

    get timedOut(): boolean {
        return this.last.timedOut;
    }

    get durationMs(): number {
        return this.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
    }

    /** Every attempt's credits, added up, or undefined when no attempt reported any */
    get credits(): number | undefined {
        const reported = this.attempts.flatMap(attempt => attempt.credits === undefined ? [] : [ attempt.credits ]);
        return reported.length === 0 ? undefined : reported.reduce((total, credits) => total + credits, 0);
    }

    /** Every model the attempts used, in the order they first used them */
    get models(): string[] {
        return [ ...new Set(this.attempts.flatMap(attempt => attempt.models)) ];
    }

    wasRetried(): boolean {
        return this.attempts.length > 1;
    }

    /** The session's verdict on `rule`, if it left usable verdicts */
    verdictOn(rule: string): RuleVerdict | undefined {
        return this.verdicts?.find(verdict => verdict.rule === rule);
    }

    toJSON(): { attempts: Array<ReturnType<JudgeAttempt['toJSON']>> } {
        return { attempts: this.attempts.map(attempt => attempt.toJSON()) };
    }
}

export type Spawn = typeof spawnWithTimeout;

/** What a judge is: its agent and model, and what its sessions run with. */
export interface JudgeDependencies {
    adapter: AgentAdapter<'kiro' | 'copilot'>;
    model: string;
    /** The homes its sessions share, in which each session's agent gets a fresh home of its own */
    homes: AgentHomes;
    /** The process runner that starts its sessions */
    spawn: Spawn;
    /** The environment its agent's credential comes from */
    env: NodeJS.ProcessEnv;
    /** How long each attempt may take */
    timeoutMs: number;
    prompt: JudgePrompt;
}

/** An agent that judges changes. */
export class Judge {

    private readonly dependencies: JudgeDependencies;

    constructor(dependencies: JudgeDependencies) {
        this.dependencies = dependencies;
    }

    get prompt(): JudgePrompt {
        return this.dependencies.prompt;
    }

    /** The same judge, given another prompt */
    withPrompt(prompt: JudgePrompt): Judge {
        return new Judge({ ...this.dependencies, prompt });
    }

    /**
     * Runs a session in `directory` on `rules`, with a fresh home for the agent, writing each attempt's stream and log
     * to `output`. A second attempt runs only when the first left no verdicts the harness can use, and is told what was
     * wrong. A model other than the judge's stops the calibration, as it stops an evaluation.
     */
    async judge(directory: JudgeDirectory, rules: readonly string[], output: string): Promise<JudgeSession> {
        const { adapter, model, homes, spawn, env, timeoutMs, prompt } = this.dependencies;
        this.freshHome();
        mkdirSync(output, { recursive: true });
        const attempts: JudgeAttempt[] = [];
        while (attempts.length < 2 && ! attempts.at(-1)?.verdicts) {
            const number = attempts.length + 1;
            const file = (name: string, extension: string) => join(output, number === 1 ? `${ name }.${ extension }` : `${ name }.${ number }.${ extension }`);
            const { command, args } = adapter.command(model, number === 1 ? prompt.text : prompt.retry(attempts.at(-1)!.problems));
            const stream = file('stream', 'jsonl');
            const finished = await spawn(command, args, {
                cwd: directory.path,
                env: agentEnvironment(adapter.id, homes, env, directory.path),
                stdout: stream,
                stderr: file('agent', 'log'),
                timeoutMs,
            });
            const trace = adapter.parseStream(readFileSync(stream, 'utf8'), { timedOut: finished.timedOut });
            const reported = modelProblem(model, trace.models);
            if (reported.stop) {
                throw new Error(`the judge's session in ${ output }: ${ reported.stop }`);
            }
            attempts.push(JudgeAttempt.of(finished, trace, directory.verdicts(rules)));
        }
        return JudgeSession.of(attempts);
    }

    /** Every session's agent gets a home of its own, in the homes the sessions share, so no session sees another's */
    private freshHome(): void {
        const { adapter, homes } = this.dependencies;
        const home = homes[adapter.homeVariable];
        rmSync(home, { recursive: true, force: true });
        mkdirSync(home, { recursive: true });
        adapter.prepareHome(home);
    }
}
