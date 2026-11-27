// One run: a copy of the layout's project, the agent working on one request in it, and the scoring of what it did.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ApiServer, type ApiServerUrls, localServerDown, serverRequestsOf, withApiServer } from './api-server.ts';
import { complete, type Finished, run, runBuffer, spawnWithTimeout } from './child-processes.ts';
import { checkConventions, type Check, type ProjectFiles, type SourceFile } from './conventions.ts';
import { adapterOf, type AgentHomes, credentialProblems, otherProblems, prepareAgentHomes } from './agents/index.ts';
import { evalRoot, type Layout, LAYOUTS } from './layouts.ts';
import { scoreLoading, type LoadingScore } from './loading.ts';
import { agentFailureOf, type CommandResult, type Outcome, outcomeOf, probesFor, rescore, testWithRetries, unreachable } from './outcome.ts';
import { addedLinesOf, withLocalApi } from './project.ts';
import { readConfig } from './records.ts';
import { Results, type RunFiles, runFiles, writeJson } from './results.ts';
import { promptFor, type Request, type Requests } from './requests.ts';
import { type Agent, AGENTS, type PlannedRun, reviewPacket, type RunKey } from './review.ts';
import { checksSandboxFor, SANDBOX_EXEC, sandboxPathsOf } from './sandbox.ts';
import type { AutoMode, SkillRead, Tokens } from './streams.ts';
import { Work } from './work.ts';

export type Mode =
    | { mode: 'full' }
    /** A pilot's layouts and requests, by number, default to PILOT's, and it runs each once unless it repeats them */
    | { mode: 'pilot', layouts?: Layout[], requests?: string[], repeats?: number }
    | { mode: 'smoke' }
    | { mode: 'held-back', layout: Layout };

export const REPEATS = 3;


/** The agents to run: the one --agent names, or every agent of the mode's plan. */
export function agentsToRun(keys: RunKey[], only: Agent | undefined): Agent[] {
    return AGENTS.filter(agent => (only === undefined || agent === only) && keys.some(key => key.agent === agent));
}

/**
 * The pilot's layouts and requests, unless --layouts and --requests say otherwise: the regression check of the skills'
 * content, run after each change to them. Layout B, the one chosen, against None, on the requests whose fixtures are
 * typical projects, 5 and 9, and those with poor abstractions, 6 and 11.
 */
export const PILOT = { layouts: [ 'none', 'b' ] as Layout[], requests: [ '5', '6', '9', '11' ] };

/** The IDs of the main requests with the given numbers, e.g. `9-new-interface` for 9. */
function requestsNumbered(requests: Requests, numbers: string[]): string[] {
    return numbers.map(number => {
        const request = requests.requests.find(({ id }) => id.startsWith(`${ number }-`));
        if (! request) {
            throw new Error(`--requests takes the numbers of main requests, 1 to ${ requests.requests.length }, not ${ number }`);
        }
        return request.id;
    });
}

/** The runs of a mode, in a fixed order; planRuns shuffles them. */
export function runsFor(mode: Mode, requests: Requests): RunKey[] {
    const plan = (layouts: readonly Layout[], agents: readonly Agent[], ids: string[], repeats: number) =>
        agents.flatMap(agent => layouts.flatMap(layout => ids.flatMap(request =>
            Array.from({ length: repeats }, (_, index) => ({ agent, layout, request, repeat: index + 1 })))));

    switch (mode.mode) {
        case 'pilot':
            return plan(mode.layouts ?? PILOT.layouts, AGENTS, requestsNumbered(requests, mode.requests ?? PILOT.requests), mode.repeats ?? 1);
        case 'smoke':
            // one run per agent, of the smoke request, which isn't in requests.json
            return plan([ 'b' ], AGENTS, [ 'smoke' ], 1);
        case 'held-back':
            return plan([ mode.layout ], AGENTS, requests.heldBack.map(request => request.id), REPEATS);
        case 'full':
            return plan(LAYOUTS, AGENTS, requests.requests.map(request => request.id), REPEATS);
    }
}

/** The command that runs an agent on a request, as its adapter, in agents/, says. */
export function agentCommand(agent: Agent, model: string, prompt: string): { command: string, args: string[] } {
    return adapterOf(agent).command(model, prompt);
}

// ---------------------------------------------------------------------------------------------------------------------

export interface Config {
    models: Record<Agent, string>;
    /** The commit of serenity-js-mocha-template the projects are made from */
    template: { commit: string };
    /** The port of the local API server, on 127.0.0.1, the same for every run of the evaluation, so their prompts and URLs are */
    apiServer: { port: number };
    /** The agent and the model that judge the runs' code, in sessions of their own: see judging/judge.ts */
    judge: { agent: Agent, model: string };
    runTimeoutMinutes: number;
    testTimeoutMinutes: number;
}

export function loadConfig(root: string = evalRoot): Config {
    return readConfig(join(root, 'config.json'));
}

/** What scoring records about a run, without its layout, agent or request, which only mapping.json holds. */
export interface RunRecord {
    id: string;
    outcome: Outcome;
    tsc: { exitCode: number };
    test: { exitCode: number };
    loading: LoadingScore | undefined;
    skillReads: SkillRead[];
    checks: Check[];
    tokens: Tokens;
    durationMs: number;
    agentExitCode: number;
    timedOut: boolean;
    /** How many times npm test ran: again, while a probe of the scenarios' APIs failed after it failed */
    testAttempts: number;
    /** The APIs the harness couldn't reach after the last attempt at npm test failed */
    unreachable: string[];
    /** `undefined` when the agent doesn't report a cost */
    costUsd: number | undefined;
    /** Whether the stream reports tokens; Kiro's doesn't, so its tokens stay 0 */
    tokensReported: boolean;
    /** The credits the session used, as Kiro reports them, or `undefined` */
    credits: number | undefined;
    /** Copilot's premium requests, or `undefined` */
    premiumRequests?: number;
    /** Copilot's total nano AIUs, as its last usage checkpoint reports them, unconverted */
    totalNanoAiu?: number;
    /** What Copilot's auto mode chose, and the models it could choose from, when the pin is "auto" */
    autoMode?: AutoMode;
    /** How many tool calls completed, and the shell commands among them */
    completedToolCalls?: number;
    shellCommands?: string[];
    /** Both of the harness's checks ran under sandbox-exec */
    checksSandboxed?: boolean;
    /** The names of the variables the agent's environment held */
    agentEnvironment?: string[];
    /** The requests the local API server logged while the agent ran, and while the harness's tsc and npm test ran */
    serverRequests?: { agent: number, checks: number };
    /** Every model the stream says answered the run: with a pin of "auto", the ones the agent picked, which may be several */
    models: string[];
    /** Whether a model answered at all: for Copilot, the stream has an assistant.usage or assistant.message event. Results scored before this was recorded have none */
    modelAnswered?: boolean;
    /** The model of a result scored before runs recorded every model */
    model?: string;
    /** The stream didn't say which model the run used, so it couldn't be checked against the pin */
    modelUnreported: boolean;
    /** Why the agent didn't do the run's work, when the outcome is an agent failure */
    agentFailure?: string;
    agentVersion: string;
    /** When a network failure was scored again, after the evaluation's runs, and how that went */
    rescored?: { at: string, outcome: Outcome };
    /** When --rescore-checks computed the checks again, from the run's saved diff */
    checksRescored?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the agents and the harness's commands get to see

// what a command line needs to work, and nothing that would identify or authorise anything
export const ENVIRONMENT_BASICS = [ 'PATH', 'HOME', 'USER', 'LANG', 'TERM', 'TMPDIR', 'SHELL' ];

function basicsOf(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(Object.entries(env)
        .filter((entry): entry is [ string, string ] => entry[1] !== undefined && (ENVIRONMENT_BASICS.includes(entry[0]) || entry[0].startsWith('LC_'))));
}

/** The names of an environment's variables, sorted, without their values, for the record. */
export function environmentNames(env: Record<string, string>): string[] {
    return Object.keys(env).sort();
}

/** The environment of the harness's tsc and npm test in a run's directory: the basics, without any credentials. */
export function testEnvironment(env: NodeJS.ProcessEnv, directory: string): Record<string, string> {
    return { ...basicsOf(env), ...NO_PROXY, ...jobDirectoriesOf(directory) };
}

/**
 * Where request 9's calculation jobs pick up their job files, and write their results, side by side in the run's
 * directory. Every run gets them, so every run's environment is the same.
 */
export const JOBS_DIRECTORY = 'jobs';
export const RESULTS_DIRECTORY = 'job-results';

function jobDirectoriesOf(directory: string): { JOBS_DIR: string, RESULTS_DIR: string } {
    return { JOBS_DIR: join(directory, JOBS_DIRECTORY), RESULTS_DIR: join(directory, RESULTS_DIRECTORY) };
}

/**
 * Empties JOBS_DIR and RESULTS_DIR before the harness's own tsc and npm test, so that the files the agent's test runs
 * left can't make a scenario pass, e.g. one that names its job file the same way every time, and doesn't wait.
 */
export function emptyJobDirectories(directory: string): void {
    for (const jobDirectory of Object.values(jobDirectoriesOf(directory))) {
        rmSync(jobDirectory, { recursive: true, force: true });
    }
}

/** The local API server is reached directly, never through a proxy the environment, or a sandbox, may name. */
const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };

/**
 * The environment of an agent's run in `directory`: the basics, with the run's HOME instead of the user's, the run's
 * other homes and npm's shared cache, JOBS_DIR and RESULTS_DIR, and only that agent's credential: KIRO_API_KEY for
 * Kiro, COPILOT_GITHUB_TOKEN for Copilot. So neither agent sees the other's, or GH_TOKEN, or anything else the user's
 * environment holds, such as cloud credentials.
 */
export function agentEnvironment(agent: Agent, homes: AgentHomes, env: NodeJS.ProcessEnv, directory: string): Record<string, string> {
    const credential = adapterOf(agent).credentialOf(env);
    return { ...basicsOf(env), ...homes, ...NO_PROXY, ...jobDirectoriesOf(directory), ...credential };
}

/**
 * What keeps the runs from starting, for the agents about to run only: their pins and credentials, Copilot's personal
 * skills, and the sandbox of the harness's checks. So a Kiro-only pilot starts without anything of Copilot's.
 */
export function preflightProblems(
    agents: Agent[], config: Config, env: NodeJS.ProcessEnv,
    { home, sandboxProblems: sandbox }: { home: string, sandboxProblems: () => string[] },
): string[] {
    const unpinned = agents.filter(agent => ! config.models[agent]);
    return [
        ...(unpinned.length > 0 ? [ `pin the model of ${ unpinned.join(' and ') } in skill-layouts/config.json before the runs` ] : []),
        ...credentialProblems(agents, env),
        ...otherProblems(agents, home),
        ...sandbox(),
    ];
}

/** A pin that takes whichever model the agent picks, for a robustness check, rather than a model of its own. */
export const AUTO = 'auto';

/**
 * Whether the model a run's stream reports is the pinned one: another model stops the evaluation, none is flagged.
 * With a pin of "auto", any model the stream reports is fine; result.json records it, and the summary breaks it down.
 */
export function modelProblem(pinned: string, reported: string[]): { stop: string | undefined, unreported: boolean } {
    if (reported.length === 0) {
        return { stop: undefined, unreported: true };
    }
    const others = reported.filter(model => model !== pinned);
    if (pinned === AUTO || others.length === 0) {
        return { stop: undefined, unreported: false };
    }
    return { stop: `the run used ${ others.join(', ') }, but config.json pins ${ pinned }`, unreported: false };
}

/** The models a run's record names, whether it recorded every model, or only the one of a result scored before. */
export function modelsOf(record: { models?: string[], model?: string }): string[] {
    return record.models ?? (record.model ? [ record.model ] : []);
}

// ---------------------------------------------------------------------------------------------------------------------

const git = (cwd: string, args: string[]) =>
    run('git', [ '-c', 'user.name=skill-layouts', '-c', 'user.email=skill-layouts@localhost', '-c', 'commit.gpgsign=false', ...args ], { cwd, maxBuffer: 64 * 1024 * 1024 });

const isTypeScript = (path: string) => path.endsWith('.ts') && ! path.split('/').includes('node_modules');

/** A working copy's TypeScript files, as the commit before the run has them, and as they are now. */
export function projectFilesOf(directory: string): ProjectFiles {
    const before = git(directory, [ 'ls-tree', '-r', '--name-only', 'HEAD' ]).split('\n').filter(isTypeScript);
    const after = git(directory, [ 'ls-files', '--cached', '--others', '--exclude-standard' ]).split('\n').filter(isTypeScript)
        .filter(path => existsSync(join(directory, path)));
    return {
        before: before.map((path): SourceFile => ({ path, content: git(directory, [ 'show', `HEAD:${ path }` ]) })),
        after: after.map((path): SourceFile => ({ path, content: readFileSync(join(directory, path), 'utf8') })),
    };
}

/**
 * What the patterns decide about a run's code: in the lines its diff added, as they are in its working copy, with the
 * project's files before and after the run.
 */
export function checksOf(directory: string, diff: string): Check[] {
    const changedFiles = [ ...addedLinesOf(diff) ]
        .filter(([ path ]) => existsSync(join(directory, path)))
        .map(([ path, addedLines ]) => ({ path, content: readFileSync(join(directory, path), 'utf8'), addedLines }));
    return checkConventions(changedFiles, projectFilesOf(directory));
}

// what the harness installed, or the tests wrote, rather than what the agent changed; skills-lock.json and the skill
// directories would give the layout away to the reviewer
const NOT_THE_AGENTS_CHANGES = [ 'node_modules/', '.agents/', '.claude/', '.kiro/', '.github/skills/', 'skills-lock.json', 'package-lock.json', 'reports/', 'target/', `${ JOBS_DIRECTORY }/`, `${ RESULTS_DIRECTORY }/` ];

/** Points the test script in a run's package.json at a local API server, keeping the file's formatting. */
export function pointAtLocalApi(directory: string, urls: ApiServerUrls): void {
    const manifest = join(directory, 'package.json');
    writeFileSync(manifest, `${ JSON.stringify(withLocalApi(JSON.parse(readFileSync(manifest, 'utf8')), urls.mathjs), null, 2) }\n`);
}

/**
 * A copy of the layout's project, with the request's fixture and its test script pointed at the run's local API server,
 * committed, so the run's changes are a diff.
 */
export function startRun(run: PlannedRun, request: Request, project: string, work: string, urls: ApiServerUrls): string {
    const directory = new Work(work).run(run.id);
    rmSync(directory, { recursive: true, force: true });
    cpSync(project, directory, { recursive: true, verbatimSymlinks: true });
    if (request.fixture) {
        cpSync(join(evalRoot, 'fixtures', request.fixture), directory, { recursive: true });
    }
    pointAtLocalApi(directory, urls);
    git(directory, [ 'init', '--quiet' ]);
    writeFileSync(join(directory, '.git', 'info', 'exclude'), `${ NOT_THE_AGENTS_CHANGES.join('\n') }\n`);
    git(directory, [ 'add', '--all' ]);
    git(directory, [ 'commit', '--quiet', '--message', 'before the run' ]);
    return directory;
}

/**
 * Rebuilds a run's working copy where it's gone: the template at the commit the run started from, with the request's
 * fixture, committed, as startRun commits them, and the TypeScript files of the run's saved diff applied. The patterns
 * only read TypeScript files, and the harness's own changes, such as the test script's URL, are in package.json.
 */
export function rebuildWorkingCopy(directory: string, { template, commit, fixture }: { template: string, commit: string, fixture: string | undefined }, diff: string): void {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    runBuffer('tar', [ '-x', '-C', directory ], { input: runBuffer('git', [ 'archive', commit ], { cwd: template, maxBuffer: 256 * 1024 * 1024 }) });
    if (fixture) {
        cpSync(join(evalRoot, 'fixtures', fixture), directory, { recursive: true });
    }
    git(directory, [ 'init', '--quiet' ]);
    git(directory, [ 'add', '--all' ]);
    git(directory, [ 'commit', '--quiet', '--message', 'before the run' ]);
    // a run that changed nothing saved an empty diff, which git apply refuses, and which leaves the project as it was
    if (diff.trim() === '') {
        return;
    }
    const patch = join(directory, '.git', 'run.patch');
    writeFileSync(patch, diff);
    try {
        runBuffer('git', [ 'apply', '--include=*.ts', patch ], { cwd: directory, stdio: 'pipe' });
    }
    catch (error) {
        const reason = String((error as { stderr?: Buffer }).stderr ?? '').trim().split('\n')[0];
        throw new Error(`its diff doesn't apply to the template at ${ commit }${ fixture ? ` with the ${ fixture } fixture` : '' }: ${ reason }`);
    }
}

export interface Spawned extends Finished {
    /** The names of the variables the agent's environment held, without their values */
    environment?: string[];
    /** How many requests the local API server had logged when the agent finished */
    serverRequests?: number;
    /** What the agent's --version printed when the evaluation started, for a stream that doesn't report a version */
    agentVersion?: string;
}

/** The agent's version: the one its stream reports, as Copilot's does, or else the installed one, as for Kiro. */
export function agentVersionOf(trace: { agentVersion: string }, installed: string | undefined): string {
    return trace.agentVersion || installed || '';
}

/**
 * Starts the agent in the run's directory, with the request, naming the run's local API server, and homes of its own,
 * and waits for it to finish or time out.
 */
export function performRun(run: PlannedRun, request: Request, directory: string, results: string, work: string, config: Config, server: ApiServer): Promise<Spawned> {
    const { command, args } = agentCommand(run.agent, config.models[run.agent], promptFor(request, server.urls));
    const homes = prepareAgentHomes(new Work(work).homes(run.id), new Work(work).npmCache);
    const files = runFiles(results);
    mkdirSync(files.directory, { recursive: true });
    const env = agentEnvironment(run.agent, homes, process.env, directory);
    return spawnWithTimeout(command, args, {
        cwd: directory,
        env,
        stdout: files.stream,
        stderr: files.agentLog,
        timeoutMs: config.runTimeoutMinutes * 60_000,
    }).then(spawned => ({ ...spawned, environment: environmentNames(env), serverRequests: server.requests().length }));
}

export type RunCommand = (command: string, args: string[], cwd: string, logFile: string, timeoutMinutes: number) => CommandResult;

export interface CheckOptions {
    env?: NodeJS.ProcessEnv;
    /** Run without sandbox-exec: only given --unsandboxed, where sandbox-exec isn't available */
    unsandboxed?: boolean;
    /** The sandbox-exec to run the checks under; another only in the specs, to stand in for its refusal */
    sandboxExec?: string;
}

/**
 * One of the harness's commands, such as tsc or npm test, in a run's directory, sandboxed, without credentials.
 * Throws CommandDidNotStart when the command couldn't start: a spawn error, such as ENOENT or EACCES, or sandbox-exec's
 * refusal. A command its timeout stopped returns a failure, whose log says it timed out.
 */
export function resultOf(command: string, args: string[], cwd: string, logFile: string, timeoutMinutes: number, { env = process.env, unsandboxed = false, sandboxExec = SANDBOX_EXEC }: CheckOptions = {}): CommandResult {
    const environment = testEnvironment(env, cwd);
    const isSandboxed = ! unsandboxed;
    const done = complete(command, args, {
        cwd, env: environment, timeoutMs: timeoutMinutes * 60_000, maxBuffer: 64 * 1024 * 1024,
        ...(isSandboxed ? { sandbox: { checks: checksSandboxFor(process.platform, { executable: sandboxExec }), paths: sandboxPathsOf(environment, cwd) } } : {}),
    });
    // a command killed by its timeout ran, and failed; that's the run's to answer for
    if (done.timedOut) {
        const log = `${ done.stdout }${ done.stderr }\n${ command } ${ args.join(' ') } timed out after ${ timeoutMinutes * 60 } s${ done.signal ? `, and was stopped with ${ done.signal }` : '' }\n`;
        writeFileSync(logFile, log);
        return { exitCode: done.status ?? 124, log, sandboxed: isSandboxed };
    }
    const result: CommandResult = done.failed
        ? { exitCode: done.status ?? 1, log: `${ done.stdout }${ done.stderr }`, sandboxed: isSandboxed }
        : { exitCode: 0, log: done.stdout, sandboxed: isSandboxed };
    writeFileSync(logFile, result.log);
    return result;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * tsc, then npm test, with its log. When npm test fails, the harness probes the local API server, and when that doesn't
 * answer, the server failed, not the run's code, so scoring stops, rather than recording a network failure.
 */
async function runChecks(runId: string, directory: string, files: RunFiles, request: Request, config: Config, server: Pick<ApiServer, 'urls' | 'requests' | 'output'>, options: CheckOptions) {
    emptyJobDirectories(directory);
    const tsc = resultOf('npx', [ 'tsc', '--noEmit' ], directory, files.tscLog, config.testTimeoutMinutes, options);
    let attempt = 0;
    const tests = await testWithRetries({
        runTest: () => resultOf('npm', [ 'test' ], directory, files.testAttemptLog(++attempt), config.testTimeoutMinutes, options),
        probe: () => unreachable(probesFor(request.apis, server.urls)),
        wait,
        retries: 0,
    });
    if (tests.networkFailure) {
        throw localServerDown(runId, tests.unreachable, server);
    }
    writeFileSync(files.testLog, tests.test.log);
    return { tsc, ...tests };
}

/**
 * Scores the network failures again, once the evaluation's runs are done, and on --rescore: in each one's directory,
 * with the local API server on the evaluation's port, tsc and npm test run again, and the run is scored as usual. When
 * the server doesn't answer, the rescore stops, since that's the harness's failure, not the run's. Returns how many
 * were rescored, and how many remain, because their run directories are gone.
 */
export async function rescoreNetworkFailures(
    planned: PlannedRun[], requests: Map<string, Request>, results: string, work: string, config: Config,
    { probe = urls => unreachable(urls), checks = {}, runCommand = (command, args, cwd, logFile, timeoutMinutes) => resultOf(command, args, cwd, logFile, timeoutMinutes, checks) }:
        { probe?: (urls: string[]) => Promise<string[]>, checks?: CheckOptions, runCommand?: RunCommand } = {},
): Promise<{ rescored: number, remaining: number, missing: string[] }> {
    const counts = { rescored: 0, remaining: 0, missing: [] as string[] };
    const store = new Results(results);
    for (const run of planned) {
        const record = store.hasResult(run.id) ? store.result(run.id) : undefined;
        if (record?.outcome !== 'network-failure') {
            continue;
        }
        const directory = new Work(work).run(run.id);
        if (! existsSync(directory)) {
            counts.missing.push(run.id);
            counts.remaining++;
            continue;
        }
        const request = requests.get(run.request)!;
        const files = store.run(run.id);
        // on the evaluation's port, so the URLs in the run's test script and code, from its prompt, answer as they did
        const rescored = await withApiServer(files.rescored.serverLog, config.apiServer.port, async server => {
            emptyJobDirectories(directory);
            const result = await rescore({
                // next to the run's own logs, which stay as the run made them
                runTsc: () => runCommand('npx', [ 'tsc', '--noEmit' ], directory, files.rescored.tscLog, config.testTimeoutMinutes),
                runTest: () => runCommand('npm', [ 'test' ], directory, files.rescored.testLog, config.testTimeoutMinutes),
                probe: () => probe(probesFor(request.apis, server.urls)),
                wait,
            });
            if (! ('test' in result) || result.outcome === 'network-failure') {
                throw localServerDown(run.id, result.unreachable, server);
            }
            return result;
        });
        counts.rescored++;
        store.saveResult(run.id, {
            ...record,
            outcome: rescored.outcome,
            tsc: { exitCode: rescored.tsc.exitCode },
            test: { exitCode: rescored.test.exitCode },
            testAttempts: record.testAttempts + rescored.attempts,
            // the rescore's checks, given --unsandboxed, may not have run under sandbox-exec, as the run's did
            checksSandboxed: rescored.tsc.sandboxed === true && rescored.test.sandboxed === true,
            unreachable: rescored.unreachable,
            rescored: { at: new Date().toISOString(), outcome: rescored.outcome },
        });
    }
    return counts;
}

/** Scores a finished run: correctness, the skills it loaded, the conventions in its diff, and its cost. */
export async function scoreRun(run: PlannedRun, request: Request, directory: string, results: string, performed: Spawned, config: Config, server: Pick<ApiServer, 'urls' | 'requests' | 'output'>, options: CheckOptions = {}): Promise<RunRecord> {
    const files = runFiles(results);
    git(directory, [ 'add', '--all' ]);
    const diff = git(directory, [ 'diff', '--cached', 'HEAD' ]);
    writeFileSync(files.diff, diff);

    const checks = checksOf(directory, git(directory, [ 'diff', '--cached', '--unified=0', 'HEAD' ]));

    // the stream first: a format the parser doesn't recognise, or another model, stops the evaluation before anything else
    const stream = readFileSync(files.stream, 'utf8');
    const trace = adapterOf(run.agent).parseStream(stream, { timedOut: performed.timedOut });
    const model = modelProblem(config.models[run.agent], trace.models);
    if (model.stop) {
        throw new Error(`run ${ run.id }: ${ model.stop }`);
    }
    // the reviewer reads it in the review packet, for the suggestions the skills ask an agent to make in its report
    writeFileSync(files.reply, trace.reply ? `${ trace.reply }\n` : '');

    const { tsc, ...tests } = await runChecks(run.id, directory, files, request, config, server, options);
    const test = tests.test;
    const agentFailure = agentFailureOf({ exitCode: performed.exitCode, timedOut: performed.timedOut, completedToolCalls: trace.completedToolCalls });

    const record: RunRecord = {
        id: run.id,
        outcome: outcomeOf({ tsc, test, networkFailure: tests.networkFailure, agentFailure }),
        agentFailure,
        tsc: { exitCode: tsc.exitCode },
        test: { exitCode: test.exitCode },
        loading: scoreLoading(run.layout, request.needs, trace.skillReads),
        skillReads: trace.skillReads,
        checks,
        tokens: trace.tokens,
        durationMs: performed.durationMs,
        agentExitCode: performed.exitCode,
        timedOut: performed.timedOut,
        agentEnvironment: performed.environment ?? [],
        serverRequests: serverRequestsOf(server.requests(), performed.serverRequests ?? 0),
        checksSandboxed: tsc.sandboxed === true && tests.test.sandboxed === true,
        completedToolCalls: trace.completedToolCalls,
        shellCommands: trace.shellCommands,
        premiumRequests: trace.premiumRequests,
        totalNanoAiu: trace.totalNanoAiu,
        autoMode: trace.autoMode,
        testAttempts: tests.attempts,
        unreachable: tests.unreachable,
        costUsd: trace.costUsd,
        tokensReported: trace.tokensReported,
        credits: trace.credits,
        models: trace.models,
        modelAnswered: trace.modelAnswered,
        modelUnreported: model.unreported,
        agentVersion: agentVersionOf(trace, performed.agentVersion),
    };
    writeJson(files.result, record);
    return record;
}

/**
 * A run's record with what comes from its stream parsed again: the skill reads and the loading, the model, tokens,
 * credits and cost. The outcome, the checks and the logs stay as the run made them. `problem` is set when the stream
 * reports a model other than the pin, which would have stopped the run.
 */
export function reparseRecord(run: PlannedRun, request: Request, record: RunRecord, stream: string, config: Config): { record: RunRecord, problem: string | undefined } {
    const trace = adapterOf(run.agent).parseStream(stream, { timedOut: record.timedOut });
    const model = modelProblem(config.models[run.agent], trace.models);
    const { model: _legacy, ...current } = record;
    return {
        problem: model.stop && `run ${ run.id }: ${ model.stop }`,
        record: {
            ...current,
            loading: scoreLoading(run.layout, request.needs, trace.skillReads),
            skillReads: trace.skillReads,
            tokens: trace.tokens,
            tokensReported: trace.tokensReported,
            credits: trace.credits,
            costUsd: trace.costUsd,
            models: trace.models,
            modelAnswered: trace.modelAnswered,
            modelUnreported: model.unreported,
            agentVersion: trace.agentVersion || record.agentVersion,
            completedToolCalls: trace.completedToolCalls,
            shellCommands: trace.shellCommands,
            premiumRequests: trace.premiumRequests,
            totalNanoAiu: trace.totalNanoAiu,
            autoMode: trace.autoMode,
        },
    };
}

/** The run's review packet, from its diff, which it has to have, and its reply, where it has one. */
export function writeReviewPacket(run: PlannedRun, request: Request, results: Results): void {
    const files = results.run(run.id);
    mkdirSync(results.review, { recursive: true });
    writeFileSync(results.reviewPacket(run.id), reviewPacket({
        id: run.id, request: request.id, prompt: request.prompt,
        diff: readFileSync(files.diff, 'utf8'),
        reply: files.read('reply')?.trim() ?? '',
    }));
}
