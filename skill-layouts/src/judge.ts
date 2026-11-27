// The judge: an agent, in a session of its own, that scores a run's change against every item of the checklist, as
// the reviewer does, from a directory that holds the request, the change, the project before and after it, the rules
// and a reference solution. It's never told the layout, the agent or the run: the diff and the reply are blinded, and
// its directory has a random name. Its verdicts don't count anywhere until calibrate.ts has compared them with the
// reviewer's; see the README.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { adapterOf } from './agents/index.ts';
import { spawnWithTimeout } from './child-processes.ts';
import type { Verdict } from './conventions.ts';
import type { AgentHomes } from './agents/index.ts';
import { blinded } from './review.ts';
import { agentEnvironment, type Config, modelProblem } from './runs.ts';

/** The file the judge writes its verdicts to, in its directory. */
export const VERDICTS_FILE = 'verdicts.json';

/** What the judge decides about one rule. */
export interface JudgeVerdict {
    rule: string;
    verdict: Verdict;
    /** The lines the verdict rests on, as `after/<path>:<line>: <code>`, or `reply.md`; none only for n/a */
    evidence: string[];
    reason: string;
}

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

const NO_REPLY = '(none: the agent said nothing after its last tool call)';

export const JUDGE_PROMPT = [
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
    `Don't change any file except \`${ VERDICTS_FILE }\`. Don't run the project's tests.`,
    `Write \`${ VERDICTS_FILE }\` as { "verdicts": [ { "rule", "verdict", "evidence", "reason" } ] }, with one entry for every rule:`,
    '',
    '- verdict: "pass", "fail" or "n/a"',
    '- evidence: the lines your verdict rests on, each as `after/<path>:<line>: <code>`, or `reply.md` for a rule about what the agent said. Leave it empty only for n/a',
    '- reason: one or two sentences',
].join('\n');

/** The prompt for a change whose project isn't there, only its diff. */
export const JUDGE_PROMPT_WITHOUT_PROJECT = [
    JUDGE_PROMPT,
    '',
    "This change's project isn't available: there's no `before/` or `after/`. Score it from `change.diff`, whose context lines show the code around each change,",
    'and give the evidence as `change.diff:<line>: <code>`.',
].join('\n');

/** The prompt of a second session, when the first left no verdicts the harness can use. */
export function retryPrompt(problems: string[], prompt: string = JUDGE_PROMPT): string {
    return [
        prompt,
        '',
        `An earlier review of this change left a \`${ VERDICTS_FILE }\` with these problems. Score the change again, and write \`${ VERDICTS_FILE }\` without them:`,
        '',
        ...problems.map(problem => `- ${ problem }`),
    ].join('\n');
}

const writeFile = (file: string, content: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
};

/** The project's files, without anything the harness or git put there. */
const isProjectFile = (source: string) => ! source.split(/[/\\]/).some(part => part === '.git' || part === 'node_modules');

/** Writes what the judge is given into its empty directory. */
export function prepareJudgeDirectory(directory: string, input: JudgeInput): void {
    mkdirSync(directory, { recursive: true });
    writeFile(join(directory, 'request.md'), `${ input.request.trim() }\n`);
    writeFile(join(directory, 'change.diff'), blinded(input.diff));
    writeFile(join(directory, 'reply.md'), `${ blinded(input.reply).trim() || NO_REPLY }\n`);
    for (const [ side, source ] of [ [ 'before', input.before ], [ 'after', input.after ] ] as const) {
        if (source !== undefined) {
            cpSync(source, join(directory, side), { recursive: true, filter: isProjectFile });
        }
    }
    for (const rule of input.rules) {
        writeFile(join(directory, 'rules', rule.id, 'README.md'), `${ rule.readme.trim() }\n`);
    }
    const listed = (rules: JudgeRule[]) => rules.map(rule => `- [${ rule.id }](rules/${ rule.id }/README.md)`);
    writeFile(join(directory, 'rules.md'), [
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
        writeFile(join(directory, 'reference', file), content);
    }
}

const VERDICTS: readonly string[] = [ 'pass', 'fail', 'n/a' ];

/** The judge's verdicts, when its verdicts.json has one valid verdict for every rule, or what's wrong with it. */
export function verdictsOf(json: string | undefined, rules: string[]): { verdicts: JudgeVerdict[] | undefined, problems: string[] } {
    if (json === undefined) {
        return { verdicts: undefined, problems: [ `there's no ${ VERDICTS_FILE }` ] };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    }
    catch (error) {
        return { verdicts: undefined, problems: [ `${ VERDICTS_FILE } isn't JSON: ${ (error as Error).message }` ] };
    }
    const list = (parsed as { verdicts?: unknown } | null)?.verdicts;
    if (! Array.isArray(list)) {
        return { verdicts: undefined, problems: [ `${ VERDICTS_FILE } has no "verdicts" list` ] };
    }
    const problems: string[] = [];
    const seen = new Map<string, JudgeVerdict>();
    list.forEach((entry: Partial<JudgeVerdict>, index) => {
        const name = typeof entry?.rule === 'string' ? entry.rule : `entry ${ index + 1 }`;
        if (typeof entry?.rule !== 'string' || ! rules.includes(entry.rule)) {
            problems.push(`${ name } isn't one of the rules`);
            return;
        }
        if (seen.has(entry.rule)) {
            problems.push(`${ entry.rule } is scored more than once`);
            return;
        }
        if (! VERDICTS.includes(entry.verdict as string)) {
            problems.push(`${ entry.rule }'s verdict is ${ JSON.stringify(entry.verdict) }, not "pass", "fail" or "n/a"`);
        }
        const evidence = entry.evidence;
        if (! Array.isArray(evidence) || ! evidence.every(line => typeof line === 'string')) {
            problems.push(`${ entry.rule }'s evidence isn't a list of lines`);
        }
        else if (evidence.length === 0 && entry.verdict !== 'n/a') {
            problems.push(`${ entry.rule } is ${ entry.verdict as string }, but names no evidence`);
        }
        if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
            problems.push(`${ entry.rule } gives no reason`);
        }
        seen.set(entry.rule, { rule: entry.rule, verdict: entry.verdict as Verdict, evidence: (evidence ?? []) as string[], reason: String(entry.reason ?? '') });
    });
    const missing = rules.filter(rule => ! seen.has(rule));
    if (missing.length > 0) {
        problems.push(`no verdict for ${ missing.join(', ') }`);
    }
    return problems.length > 0
        ? { verdicts: undefined, problems }
        : { verdicts: rules.map(rule => seen.get(rule)!), problems: [] };
}

/** How one judge session went: up to two attempts, the second told what was wrong with the first's verdicts. */
export interface JudgeSession {
    attempts: number;
    /** The last attempt's */
    exitCode: number;
    timedOut: boolean;
    /** Every attempt's, added up */
    durationMs: number;
    credits: number | undefined;
    models: string[];
    /** What was wrong with the last attempt's verdicts; none when there are verdicts */
    problems: string[];
    verdicts: JudgeVerdict[] | undefined;
}

export type Spawn = typeof spawnWithTimeout;

export interface JudgeOptions {
    config: Pick<Config, 'judge' | 'runTimeoutMinutes'>;
    homes: AgentHomes;
    /** Where each attempt's stream and log go: `stream.jsonl` and `agent.log`, then `stream.2.jsonl` and `agent.2.log` */
    output: string;
    env?: NodeJS.ProcessEnv;
    spawn?: Spawn;
    /** JUDGE_PROMPT, or JUDGE_PROMPT_WITHOUT_PROJECT for a change without its project */
    prompt?: string;
}

const attemptFile = (output: string, name: string, extension: string, attempt: number) =>
    join(output, attempt === 1 ? `${ name }.${ extension }` : `${ name }.${ attempt }.${ extension }`);

/**
 * Runs the judge in its directory, as prepared, on the given rules, and reads its verdicts. When they can't be used,
 * it runs a second session, told what was wrong. A model other than the pinned one stops the calibration, as it does
 * an evaluation.
 */
export async function judge(directory: string, rules: string[], { config, homes, output, env = process.env, spawn = spawnWithTimeout, prompt = JUDGE_PROMPT }: JudgeOptions): Promise<JudgeSession> {
    const adapter = adapterOf(config.judge.agent);
    mkdirSync(output, { recursive: true });
    const session: JudgeSession = { attempts: 0, exitCode: 0, timedOut: false, durationMs: 0, credits: undefined, models: [], problems: [], verdicts: undefined };
    for (let attempt = 1; attempt <= 2 && session.verdicts === undefined; attempt++) {
        const { command, args } = adapter.command(config.judge.model, attempt === 1 ? prompt : retryPrompt(session.problems, prompt));
        const stream = attemptFile(output, 'stream', 'jsonl', attempt);
        const finished = await spawn(command, args, {
            cwd: directory,
            env: agentEnvironment(config.judge.agent, homes, env, directory),
            stdout: stream,
            stderr: attemptFile(output, 'agent', 'log', attempt),
            timeoutMs: config.runTimeoutMinutes * 60_000,
        });
        const trace = adapter.parseStream(readFileSync(stream, 'utf8'), { timedOut: finished.timedOut });
        const model = modelProblem(config.judge.model, trace.models);
        if (model.stop) {
            throw new Error(`the judge's session in ${ output }: ${ model.stop }`);
        }
        const file = join(directory, VERDICTS_FILE);
        const { verdicts, problems } = verdictsOf(existsSync(file) ? readFileSync(file, 'utf8') : undefined, rules);
        Object.assign(session, {
            attempts: attempt,
            exitCode: finished.exitCode,
            timedOut: finished.timedOut,
            durationMs: session.durationMs + finished.durationMs,
            credits: trace.credits === undefined ? session.credits : (session.credits ?? 0) + trace.credits,
            models: [ ...new Set([ ...session.models, ...trace.models ]) ],
            problems,
            verdicts,
        });
    }
    return session;
}
