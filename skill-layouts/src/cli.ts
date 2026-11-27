// pnpm run eval:skill-layouts -- [--pilot [--layouts <list>] [--requests <list>] [--repeats <n>] | --smoke | --held-back <layout>]
//                                  [--agent <kiro|copilot>] [--prepare-only | --summarise | --compare | --rescore | --reparse | --rescore-checks]
//                                  --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>] [--unsandboxed]
// pnpm run eval:skill-layouts -- --check-references --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>] [--unsandboxed]
//
// Evaluates how a package's skills should be laid out: packs the Serenity/JS packages, gives them each layout's
// skills, installs them into copies of the Mocha template, runs Kiro and GitHub Copilot on each request, and scores the
// runs. See the README next to this directory's src/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ensurePortFree, withApiServer } from './api-server.ts';
import { type AgentConditions, checkConditions, fixtureHashes, hashOf, lockfileHashes, recordAgentConditions, recordLockfiles } from './conditions.ts';
import { type Check, CHECKLIST, conventionsScore } from './conventions.ts';
import { evalRoot, isLayout, type Layout, LAYOUTS } from './layouts.ts';
import { checkExamples, checkTemplateCommit, layoutTarballs, packPackages, prepareProject } from './project.ts';
import { compareResults } from './compare.ts';
import { checkReference, type ReferenceCheck, renderReferenceCheck } from './references.ts';
import { loadRequests, type Request } from './requests.ts';
import { type Agent, AGENTS, combineVerdicts, disagreements, type PlannedRun, planRuns, type RunKey, scoresTemplate } from './review.ts';
import { Results } from './results.ts';
import { renderSmoke, SMOKE_REQUEST, smokeChecks, smokeProblem } from './smoke.ts';
import { type CheckOptions, checksOf, checksSandbox, type Config, loadConfig, type Mode, modelsOf, performRun, agentsToRun, preflightProblems, rebuildWorkingCopy, reparseRecord, rescoreNetworkFailures, resultOf, runsFor, sandboxProblems, scoreRun, startRun, writeReviewPacket } from './runs.ts';
import { decideWhenComplete, renderSummary, type RunResult, summarise } from './summary.ts';
import { Work } from './work.ts';

export interface Arguments {
    mode: Mode;
    serenityJs: string;
    template: string;
    /** Where the results go: one directory per mode, e.g. `<out>/pilot` */
    out: string;
    /** Where the projects and the runs' working copies go, outside any repository, so agents find no other configuration */
    work: string;
    prepareOnly: boolean;
    /** Only summarise the results, which only reads them */
    summariseOnly: boolean;
    /** Score the network failures again, then summarise */
    rescoreOnly: boolean;
    /** Parse each saved stream again, and rewrite what comes from it in result.json, then summarise */
    reparseOnly: boolean;
    /** Only compare the layouts' runs, request by request, in compare.md, which only reads the results */
    compareOnly: boolean;
    /** Compute each run's checks again, from its saved diff and its working copy, then summarise */
    rescoreChecksOnly: boolean;
    /** The one agent to run, or rescore; every agent of the mode's plan without it */
    agent: Agent | undefined;
    /** Only check that every request's reference solution passes, and fails with its expected value made wrong */
    checkReferencesOnly: boolean;
    /** Run tsc and npm test without a sandbox where sandbox-exec isn't available, rather than refuse to */
    unsandboxed: boolean;
}

const USAGE = 'usage: eval:skill-layouts [--pilot [--layouts <list>] [--requests <list>] [--repeats <n>] | --smoke | --held-back <layout>] [--agent <kiro|copilot>] [--prepare-only | --summarise | --compare | --rescore | --reparse | --rescore-checks] --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>] [--unsandboxed]\n'
    + '       eval:skill-layouts --check-references --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>] [--unsandboxed]';

export function parseArguments(argv: string[], cwd: string): Arguments {
    const options = new Map<string, string>();
    const flags = new Set<string>();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if ([ '--pilot', '--smoke', '--prepare-only', '--summarise', '--rescore', '--reparse', '--rescore-checks', '--check-references', '--compare', '--unsandboxed' ].includes(argument)) {
            flags.add(argument);
        }
        else if ([ '--serenity-js', '--template', '--out', '--work', '--held-back', '--agent', '--layouts', '--requests', '--repeats' ].includes(argument) && argv[index + 1] && ! argv[index + 1].startsWith('--')) {
            options.set(argument, argv[++index]);
        }
        else if (argument !== '--') {
            throw new Error(USAGE);
        }
    }

    const heldBack = options.get('--held-back');
    if (heldBack !== undefined && ! isLayout(heldBack)) {
        throw new Error(`--held-back takes the layout the evaluation chose: none, a, b or c, not ${ heldBack }`);
    }
    if ([ heldBack !== undefined, flags.has('--pilot'), flags.has('--smoke') ].filter(Boolean).length > 1) {
        throw new Error(USAGE);
    }
    // a pilot of other layouts or requests, e.g. --layouts a,c --requests 9,11
    // each combination runs once, so a list names something at least once, and nothing twice
    const listOf = (option: string, what: string) => {
        const list = options.get(option)?.split(',').map(item => item.trim()).filter(Boolean);
        if (list?.length === 0) {
            throw new Error(`${ option } takes at least one ${ what }`);
        }
        const repeated = list?.find((item, index) => list.indexOf(item) !== index);
        if (repeated !== undefined) {
            throw new Error(`${ option } names ${ repeated } more than once`);
        }
        return list;
    };
    const layouts = listOf('--layouts', 'layout');
    const pilotRequests = listOf('--requests', 'request');
    const repeatsOption = options.get('--repeats');
    if ((layouts || pilotRequests || repeatsOption !== undefined) && ! flags.has('--pilot')) {
        throw new Error('--layouts, --requests and --repeats only go with --pilot');
    }
    if (repeatsOption !== undefined && ! /^[1-9]\d*$/.test(repeatsOption)) {
        throw new Error(`--repeats takes a whole number of times, 1 or more, not ${ repeatsOption }`);
    }
    const unknownLayout = layouts?.find(layout => ! isLayout(layout));
    if (unknownLayout !== undefined) {
        throw new Error(`--layouts takes layouts: none, a, b or c, not ${ unknownLayout }`);
    }
    const mode: Mode = heldBack ? { mode: 'held-back', layout: heldBack as Layout }
        : (flags.has('--pilot')
            ? { mode: 'pilot', ...(layouts ? { layouts: layouts as Layout[] } : {}), ...(pilotRequests ? { requests: pilotRequests } : {}), ...(repeatsOption ? { repeats: Number(repeatsOption) } : {}) }
            : (flags.has('--smoke') ? { mode: 'smoke' } : { mode: 'full' }));

    const agent = options.get('--agent');
    if (agent !== undefined && ! (AGENTS as readonly string[]).includes(agent)) {
        throw new Error(`--agent takes the agent to run: kiro or copilot, not ${ agent }`);
    }
    const summariseOnly = flags.has('--summarise');
    const rescoreOnly = flags.has('--rescore');
    const reparseOnly = flags.has('--reparse');
    const compareOnly = flags.has('--compare');
    const rescoreChecksOnly = flags.has('--rescore-checks');
    if ([ '--prepare-only', '--summarise', '--rescore', '--reparse', '--compare', '--rescore-checks' ].filter(flag => flags.has(flag)).length > 1) {
        throw new Error(USAGE);
    }
    // it runs no agent, so it takes no mode, agent or other action
    const checkReferencesOnly = flags.has('--check-references');
    if (checkReferencesOnly && ([ ...flags ].filter(flag => flag !== '--unsandboxed').length > 1 || heldBack !== undefined || agent !== undefined)) {
        throw new Error(USAGE);
    }
    const serenityJs = options.get('--serenity-js');
    if (! serenityJs && ! summariseOnly && ! rescoreOnly && ! reparseOnly && ! compareOnly && ! rescoreChecksOnly) {
        throw new Error(`--serenity-js <clone> is required: a compiled clone of serenity-js/serenity-js on the branch with the skills\n${ USAGE }`);
    }
    const out = options.get('--out');
    if (! out) {
        throw new Error(`--out <dir> is required: where the results go, one directory per mode, e.g. --out ~/skill-layouts-results\n${ USAGE }`);
    }
    const clone = resolve(cwd, serenityJs ?? '.');

    return {
        mode,
        serenityJs: clone,
        template: resolve(cwd, options.get('--template') ?? join(dirname(clone), 'serenity-js-mocha-template')),
        out: resolve(cwd, out),
        work: resolve(cwd, options.get('--work') ?? join(tmpdir(), 'skill-layouts')),
        prepareOnly: flags.has('--prepare-only'),
        summariseOnly,
        rescoreOnly,
        reparseOnly,
        compareOnly,
        rescoreChecksOnly,
        agent: agent as Agent | undefined,
        checkReferencesOnly,
        unsandboxed: flags.has('--unsandboxed'),
    };
}

const log = (message: string) => console.log(`eval:skill-layouts: ${ message }`);

/** What `command --version` prints, trimmed, or `not installed` when it can't start or fails. */
export function versionOf(command: string): string {
    try {
        return execFileSync(command, [ '--version' ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] }).trim();
    }
    catch {
        return 'not installed';
    }
}

function requestsById(): Map<string, Request> {
    return new Map([ ...requestsOf(), [ SMOKE_REQUEST.id, SMOKE_REQUEST ] ]);
}

function requestsOf(): Map<string, Request> {
    const { requests, heldBack } = loadRequests();
    return new Map([ ...requests, ...heldBack ].map(request => [ request.id, request ]));
}

/** What a plan runs, as `layouts none, b and requests 5, 6, 9, 11`, for saying how two plans differ. */
function described(keys: RunKey[]): string {
    const layouts = LAYOUTS.filter(layout => keys.some(key => key.layout === layout));
    const numbers = [ ...new Set(keys.map(key => key.request.split('-')[0])) ].sort((one, other) => Number(one) - Number(other));
    const repeats = Math.max(...keys.map(key => key.repeat));
    return `layouts ${ layouts.join(', ') } and requests ${ numbers.join(', ') }${ repeats > 1 ? `, ${ repeats } times each` : '' }`;
}

const keyOf = ({ agent, layout, request, repeat }: RunKey) => `${ agent } ${ layout } ${ request } ${ repeat }`;

/**
 * The plan an --out already has, in its mapping.json, or `undefined` for one without; it refuses an --out planned
 * with other runs, such as a pilot of other layouts or requests. It writes nothing, so the evaluation checks it before
 * anything else.
 */
export function checkPlan(mode: Mode, results: string): PlannedRun[] | undefined {
    const store = new Results(results);
    if (! store.hasPlan()) {
        return undefined;
    }
    const keys = runsFor(mode, loadRequests());
    const planned = store.plan();
    if (planned.map(keyOf).sort().join('\n') !== keys.map(keyOf).sort().join('\n')) {
        throw new Error(`this --out was planned with ${ described(planned) }, not ${ described(keys) }: pass another --out`);
    }
    return planned;
}

/**
 * The plan of the mode's runs, kept in mapping.json, so that a stopped evaluation resumes with the same IDs. An --out
 * planned with other runs, such as a pilot of other layouts or requests, is a different plan, so it isn't resumed.
 */
export function planOf(mode: Mode, results: string): PlannedRun[] {
    const saved = checkPlan(mode, results);
    if (saved) {
        return saved;
    }
    const planned = planRuns(runsFor(mode, loadRequests()));
    new Results(results).savePlan(planned);
    return planned;
}

async function evaluate(args: Arguments): Promise<void> {
    const store = Results.of(args.out, args.mode);
    const results = store.directory;
    // a smoke run is a check, not part of an evaluation, so each starts afresh, with conditions of its own
    if (args.mode.mode === 'smoke' && ! args.prepareOnly) {
        rmSync(results, { recursive: true, force: true });
    }
    mkdirSync(results, { recursive: true });
    // before the preflight checks, the conditions, and the preparation of the projects, which takes minutes
    checkPlan(args.mode, results);

    const config = loadConfig();
    const keys = runsFor(args.mode, loadRequests());
    // the plan is the mode's, whichever agents run, so a pilot always has the same run IDs
    const agents = agentsToRun(keys, args.agent);
    const layouts = [ ...new Set(keys.map(run => run.layout)) ];
    const sandbox = checksSandbox(process.platform, { unsandboxed: args.unsandboxed });

    if (! args.prepareOnly) {
        const problems = preflightProblems(agents, config, process.env, { home: homedir(), sandboxProblems: () => sandbox.problems });
        if (problems.length > 0) {
            throw new Error(problems.join('\n'));
        }
        // before packing and preparing anything, which takes minutes
        await ensurePortFree(config.apiServer.port);
    }
    checkTemplateCommit(args.template, config.template.commit);
    const conditionsFile = store.conditionsFile;
    const versions = new Map(agents.map(agent => [ agent, versionOf(agent === 'kiro' ? 'kiro-cli' : 'copilot') ]));
    const agentConditions = (agent: Agent): AgentConditions => ({ model: config.models[agent], version: versions.get(agent)! });
    if (! args.prepareOnly) {
        const requestOf = requestsById();
        checkConditions(conditionsFile, {
            template: { commit: config.template.commit },
            serenityJs: { commit: execFileSync('git', [ 'rev-parse', 'HEAD' ], { cwd: args.serenityJs, encoding: 'utf8' }).trim() },
            requests: hashOf(join(evalRoot, 'requests.json')),
            skills: Object.fromEntries(layouts.map(layout => [ layout, hashOf(join(evalRoot, 'layouts', layout)) ])),
            lockfiles: lockfileHashes(results, layouts),
            apiServer: config.apiServer,
            fixtures: fixtureHashes(keys.map(key => requestOf.get(key.request)?.fixture)),
        }, Object.fromEntries(agents.map(agent => [ agent, agentConditions(agent) ])), config.models);
    }

    log(`packing the packages in ${ args.serenityJs }`);
    const packed = packPackages(args.serenityJs, args.work);
    const projects = new Map<Layout, string>();
    const examples: string[] = [];
    for (const layout of layouts) {
        log(`installing layout ${ layout } into a copy of ${ args.template }`);
        const project = prepareProject(layout, { directory: args.template, commit: config.template.commit }, layoutTarballs(layout, packed, args.work), args.work, store.savedLockfile(layout));
        projects.set(layout, project);
        examples.push(...checkExamples(layout, project, args.serenityJs, args.work).map(line => `layout ${ layout }, ${ line }`));
    }
    if (! args.prepareOnly) {
        recordLockfiles(conditionsFile, lockfileHashes(results, layouts));
    }
    const fixtures = {
        serenityJs: { clone: args.serenityJs, commit: packed.commit },
        template: { directory: args.template, commit: config.template.commit },
        examples,
    };
    writeFixtures(results, fixtures);
    examples.forEach(line => log(line));
    if (args.prepareOnly) {
        log(`prepared ${ layouts.join(', ') } in ${ args.work }; nothing run`);
        return;
    }

    const requests = requestsById();
    const planned = planOf(args.mode, results);
    const errors = new Map<string, string>();
    for (const [ index, run ] of planned.entries()) {
        const files = store.run(run.id);
        if (! agents.includes(run.agent) || store.hasResult(run.id)) {
            continue;
        }
        recordAgentConditions(conditionsFile, run.agent, agentConditions(run.agent));
        const request = requests.get(run.request)!;
        log(`run ${ index + 1 } of ${ planned.length }: ${ run.id }`);
        // a server of the run's own, from before the agent starts until the harness's npm test is done
        await withApiServer(files.serverLog, config.apiServer.port, async server => {
            const directory = startRun(run, request, projects.get(run.layout)!, args.work, server.urls);
            // Kiro's stream reports no version, so the run records the one kiro-cli --version printed
            const performed = { ...await performRun(run, request, directory, files.directory, args.work, config, server), agentVersion: versions.get(run.agent) };
            if (args.mode.mode !== 'smoke') {
                await scoreRun(run, request, directory, files.directory, performed, config, server, sandbox.checks);
                writeReviewPacket(run, request, store);
                return;
            }
            // the smoke run reports what stopped its scoring, rather than stopping
            try {
                await scoreRun(run, request, directory, files.directory, performed, config, server, sandbox.checks);
                writeReviewPacket(run, request, store);
            }
            catch (error) {
                errors.set(run.id, (error as Error).message);
            }
        });
    }

    if (args.mode.mode === 'smoke') {
        writeFixtures(results, fixtures);
        reportSmoke(planned.filter(run => agents.includes(run.agent)), store, config, errors);
        return;
    }

    writeFixtures(results, fixtures);
    await finishEvaluation(results, args.work, planned, { agents, agent: args.agent, sandbox, config });
}

/**
 * The end of an evaluation, once its runs are done: a blank scores.json for the reviewer, the network failures scored
 * again, with the checks sandboxed as the runs' were, or not, given --unsandboxed, and the summary.
 */
export async function finishEvaluation(
    results: string, work: string, planned: PlannedRun[],
    { agents, agent, sandbox, config }: { agents: readonly Agent[], agent?: Agent, sandbox: { problems: string[], checks: CheckOptions }, config: Config },
): Promise<void> {
    const store = new Results(results);
    if (! store.hasScores()) {
        store.saveScores(scoresTemplate(planned));
    }
    await rescoreResults(results, work, { agents, sandboxProblems: () => sandbox.problems, checks: sandbox.checks, config });
    summariseResults(results, { agent });
}

/** Prints the smoke run's checks, one line each, and fails, naming the failed checks, when any failed. */
function reportSmoke(runs: PlannedRun[], store: Results, config: Config, errors: Map<string, string>): void {
    const problems = runs.flatMap(run => {
        const files = store.run(run.id);
        const record = store.hasResult(run.id) ? store.result(run.id) : undefined;
        const packetFile = store.reviewPacket(run.id);
        const checks = smokeChecks({
            agent: run.agent,
            pin: config.models[run.agent],
            error: errors.get(run.id),
            record: record && {
                completedToolCalls: record.completedToolCalls ?? 0,
                skillReads: record.skillReads,
                shellCommands: record.shellCommands ?? [],
                models: modelsOf(record),
                modelAnswered: record.modelAnswered ?? modelsOf(record).length > 0,
                credits: record.credits,
                premiumRequests: record.premiumRequests,
                checksSandboxed: record.checksSandboxed ?? false,
                agentEnvironment: record.agentEnvironment ?? [],
                serverRequests: record.serverRequests ?? { agent: 0, checks: 0 },
            },
            logs: { tsc: existsSync(files.tscLog), test: existsSync(files.testLog) },
            resultSaved: record !== undefined,
            packet: existsSync(packetFile) ? readFileSync(packetFile, 'utf8') : undefined,
        });
        console.log(renderSmoke(run.agent, checks));
        const problem = smokeProblem(checks);
        return problem ? [ `${ run.agent }: ${ problem }` ] : [];
    });
    if (problems.length > 0) {
        throw new Error(problems.join('\n'));
    }
    log(`smoke run passed for ${ runs.map(run => run.agent).join(' and ') }`);
}

/**
 * Parses each saved stream.jsonl again, of the given agents' runs, and rewrites what comes from it in result.json,
 * keeping the outcome, the checks and the logs. It runs no agent and no check. A stream that reports a model other
 * than the pin rewrites nothing, since that run should have stopped the evaluation.
 */
export function reparseResults(results: string, { config = loadConfig(), agents = AGENTS }: { config?: Config, agents?: readonly Agent[] } = {}): void {
    const store = new Results(results);
    const planned = store.plan(agents);
    const requests = requestsById();
    const reparsed = planned
        .filter(run => store.hasResult(run.id) && existsSync(store.run(run.id).stream))
        .map(run => ({ id: run.id, ...reparseRecord(run, requests.get(run.request)!, store.result(run.id), readFileSync(store.run(run.id).stream, 'utf8'), config) }));
    const problems = reparsed.flatMap(({ problem }) => problem ?? []);
    if (problems.length > 0) {
        throw new Error(`nothing reparsed: ${ problems.join('; ') }`);
    }
    for (const { id, record } of reparsed) {
        store.saveResult(id, record);
    }
    log(`${ reparsed.length } run(s) reparsed`);
}

/** What changed between a run's saved checks and the new ones, an item the saved ones don't have being n/a there. */
function changesBetween(saved: Check[], checks: Check[]): string[] {
    const verdictIn = (list: Check[], item: string) => list.find(check => check.item === item)?.verdict ?? 'n/a';
    return [ ...new Set([ ...checks, ...saved ].map(check => check.item)) ]
        .filter(item => verdictIn(saved, item) !== verdictIn(checks, item))
        .map(item => `${ item }: ${ verdictIn(saved, item) } → ${ verdictIn(checks, item) }`);
}

/**
 * Computes the checks of the given agents' runs again, from each run's saved diff and its working copy, in
 * `<work>/runs/<id>`, or, where that's gone, one rebuilt from the template at the commit the runs started from, the
 * request's fixture and the diff, and removed again. It runs no agent and no check, and keeps the rest of each
 * result.json. It gives scores.json a blank for each item the reviewer hasn't got yet, keeping their verdicts, and
 * writes the review packets again, with the checklist as it is. A diff that doesn't apply rescores nothing.
 */
export function rescoreChecks(results: string, { work, template, agents = AGENTS }: { work: string, template: string, agents?: readonly Agent[] }): Array<{ id: string, changes: string[] }> {
    const store = new Results(results);
    const workDirectory = new Work(work);
    const planned = store.plan(agents)
        .filter(run => store.hasResult(run.id) && existsSync(store.run(run.id).diff));
    const requests = requestsById();
    const { commit } = templateOf(store);
    const problems: string[] = [];
    const rescored = planned.flatMap(run => {
        const diff = readFileSync(store.run(run.id).diff, 'utf8');
        const kept = workDirectory.run(run.id);
        const isKept = existsSync(join(kept, '.git'));
        const directory = isKept ? kept : workDirectory.rescoredChecks(run.id);
        try {
            if (! isKept) {
                rebuildWorkingCopy(directory, { template, commit, fixture: requests.get(run.request)!.fixture }, diff);
            }
            const record = store.result(run.id);
            const checks = checksOf(directory, diff);
            return [ { run, record: { ...record, checks, checksRescored: new Date().toISOString() }, changes: changesBetween(record.checks, checks) } ];
        }
        catch (error) {
            problems.push(`run ${ run.id }: ${ (error as Error).message }`);
            return [];
        }
        finally {
            if (! isKept) {
                rmSync(directory, { recursive: true, force: true });
            }
        }
    });
    if (problems.length > 0) {
        throw new Error(`nothing rescored: ${ problems.join('; ') }`);
    }
    for (const { run, record } of rescored) {
        store.saveResult(run.id, record);
    }

    const scores = store.scores();
    for (const { run } of rescored) {
        scores[run.id] = { ...Object.fromEntries(CHECKLIST.map(item => [ item.id, '' ])), ...scores[run.id] };
        writeReviewPacket(run, requests.get(run.request)!, store);
    }
    if (rescored.length > 0) {
        store.saveScores(Object.fromEntries(Object.entries(scores).sort(([ one ], [ other ]) => one.localeCompare(other))));
    }
    return rescored.map(({ run, changes }) => ({ id: run.id, changes }));
}

/**
 * Writes fixtures.json, with every agent that has run in this --out, and its model and version as conditions.json
 * recorded them, whichever agents this invocation runs.
 */
export function writeFixtures(results: string, fixtures: object): void {
    const store = new Results(results);
    const conditions = store.conditions();
    const agents = conditions ? conditions.agents : {};
    store.saveFixtures({ ...fixtures, agents });
}

/** The template commit the runs started from, as conditions.json recorded it. */
function templateOf(store: Results): { commit: string } {
    const template = store.conditions()?.shared?.template;
    if (template === undefined) {
        throw new Error(`${ store.conditionsFile }: ${ store.conditions() ? 'shared.template is missing' : "doesn't exist" }`);
    }
    return template;
}

/**
 * Scores the network failures again, where their run directories are still in `work`. It reruns the harness's checks,
 * so it refuses to rescore anything where they can't run sandboxed, as inside another sandbox, unless `checks` says
 * they run without, and leaves every result.json as it was: checks that can't start would turn each network failure
 * into a false failure.
 */
export async function rescoreResults(
    results: string, work: string,
    { sandboxProblems: problems = () => sandboxProblems(process.platform), checks = {}, config = loadConfig(), agents = AGENTS }:
        { sandboxProblems?: () => string[], checks?: CheckOptions, config?: Config, agents?: readonly Agent[] } = {},
): Promise<void> {
    const refusals = problems();
    if (refusals.length > 0) {
        throw new Error(`nothing rescored: ${ refusals.join('; ') }`);
    }
    // the runs' test scripts, and the URLs in their code, name the port they were made with; results from before the
    // local API server have none, and call the public APIs, so rescoring them against the local server would score
    // the public APIs' latency, not their code
    const made = new Results(results).conditions()?.shared.apiServer;
    if (made === undefined) {
        throw new Error("nothing rescored: these results come from before the local API server, so their runs' code calls the public APIs, and can't be rescored against it");
    }
    if (made.port !== config.apiServer.port) {
        throw new Error(`nothing rescored: the runs were made with the local API server on port ${ made.port }, but config.json sets ${ config.apiServer.port }, so the URLs in their code wouldn't answer: put the port back`);
    }
    const planned = new Results(results).plan(agents);
    const { rescored, remaining, missing } = await rescoreNetworkFailures(planned, requestsById(), results, work, config, { checks });
    log(`${ rescored } network failure(s) scored again; ${ remaining } not rescored${ missing.length > 0 ? `, ${ missing.length } of them without a run directory in ${ work }` : '' }`);
}

/**
 * The summary of a mode's results, with the reviewer's scores where there are any, in summary.md and summary.json.
 * With an agent, it counts and decides on that agent's planned runs only, since a plan has runs of every agent, and a
 * round run with --agent leaves the other agent's runs without results for good. Without one, it covers every agent,
 * and the decision waits for all of their runs.
 */
export function summariseResults(results: string, { agent }: { agent?: Agent } = {}): void {
    const store = new Results(results);
    const planned = store.plan(agent ? [ agent ] : AGENTS);
    const scores = store.scores();
    const scored = store.scored(planned);

    const runResults: RunResult[] = scored.map(({ run, record }) => ({
        ...run,
        outcome: record.outcome,
        loadingRight: record.loading?.right,
        timedOut: record.timedOut,
        conventions: conventionsScore(combineVerdicts(record.checks, scores[run.id])),
        tokens: record.tokens,
        durationMs: record.durationMs,
        costUsd: record.costUsd,
        // results scored before credits were recorded have neither field
        tokensReported: record.tokensReported ?? false,
        credits: record.credits,
        modelUnreported: record.modelUnreported,
        models: modelsOf(record),
    }));

    // the reviewer's scores of the runs summarised; with an agent, not of the other agent's runs
    const reviewed = planned.filter(run => Object.values(scores[run.id] ?? {}).some(verdict => verdict)).length;
    const review = scored.map(({ run, record }) => disagreements(record.checks, scores[run.id]))
        .reduce((total, { scored: items, disagreed }) => ({ scored: total.scored + items, disagreed: total.disagreed + disagreed }), { scored: 0, disagreed: 0 });
    const summary = summarise(runResults);
    const decision = decideWhenComplete(summary, { planned: planned.length, scored: runResults.length, agent });
    store.saveSummary({ ...(agent ? { agent } : {}), runs: runResults.length, planned: planned.length, reviewed, review, summary, decision }, [
        renderSummary(summary, decision),
        agent
            ? `${ agent }'s runs only: ${ runResults.length } of its ${ planned.length } planned runs scored; ${ reviewed } reviewed.`
            : `Every agent's runs: ${ runResults.length } of ${ planned.length } planned runs scored; ${ reviewed } reviewed.`,
        `The reviewer's verdict replaces the AST patterns' for every item they scored. They disagreed with the patterns on ${ review.disagreed } of the ${ review.scored } items they scored.`,
        '',
    ].join('\n'));
    log(`${ runResults.length } of ${ planned.length } runs${ agent ? ` of ${ agent }` : '' } scored, ${ reviewed } reviewed: ${ store.summaryMarkdown }`);
}

/**
 * Checks every request's reference solution, held back or not, in layout None's project, with a local API server of
 * its own: each passes tsc and npm test, and fails npm test with its expected value made wrong. Prints one line per
 * request, and fails, naming them, when any reference failed. It runs tsc and npm test as the evaluation's checks run,
 * under sandbox-exec, so it refuses to check anything where sandbox-exec can't start, unless it's given --unsandboxed.
 */
export async function checkReferences(
    args: Arguments,
    { sandboxProblems: problems, config = loadConfig() }: { sandboxProblems?: () => string[], config?: Config } = {},
): Promise<void> {
    const sandbox = checksSandbox(process.platform, { unsandboxed: args.unsandboxed });
    const refusals = problems ? problems() : sandbox.problems;
    if (refusals.length > 0) {
        throw new Error(`nothing checked: ${ refusals.join('; ') }`);
    }
    await ensurePortFree(config.apiServer.port);
    checkTemplateCommit(args.template, config.template.commit);
    const store = Results.ofReferences(args.out);
    const results = store.directory;
    mkdirSync(results, { recursive: true });

    log(`packing the packages in ${ args.serenityJs }`);
    const packed = packPackages(args.serenityJs, args.work);
    log(`installing layout none into a copy of ${ args.template }`);
    const project = prepareProject('none', { directory: args.template, commit: config.template.commit }, layoutTarballs('none', packed, args.work), args.work, store.savedLockfile('none'));

    const { requests, heldBack } = loadRequests();
    const checks: ReferenceCheck[] = [];
    for (const request of [ ...requests, ...heldBack ]) {
        const check = await withApiServer(store.referenceServerLog(request.id), config.apiServer.port, server =>
            checkReference(request, {
                project, work: args.work, results, urls: server.urls, testTimeoutMinutes: config.testTimeoutMinutes,
                runCommand: (command, commandArgs, cwd, logFile, timeoutMinutes) => resultOf(command, commandArgs, cwd, logFile, timeoutMinutes, sandbox.checks),
            }));
        console.log(renderReferenceCheck(check));
        checks.push(check);
    }
    const failed = checks.filter(check => ! check.ok).map(check => check.request);
    if (failed.length > 0) {
        throw new Error(`${ failed.length } of ${ checks.length } reference solutions failed their check: ${ failed.join(', ') }`);
    }
    log(`all ${ checks.length } reference solutions pass, and fail with their expected values made wrong`);
}

if (import.meta.main) {
    try {
        const args = parseArguments(process.argv.slice(2), process.cwd());
        const store = Results.of(args.out, args.mode);
        if (args.compareOnly) {
            store.saveCompare(compareResults(store.directory, { agent: args.agent }));
            log(`the layouts compared, request by request: ${ store.compareMarkdown }`);
        }
        else if (args.checkReferencesOnly) {
            await checkReferences(args);
        }
        else if (args.summariseOnly) {
            summariseResults(store.directory, { agent: args.agent });
        }
        else if (args.reparseOnly) {
            reparseResults(store.directory, { agents: args.agent ? [ args.agent ] : AGENTS });
            summariseResults(store.directory, { agent: args.agent });
        }
        else if (args.rescoreChecksOnly) {
            const results = store.directory;
            const rescored = rescoreChecks(results, { work: args.work, template: args.template, agents: args.agent ? [ args.agent ] : AGENTS });
            for (const { id, changes } of rescored) {
                log(`run ${ id }: ${ changes.length > 0 ? changes.join(', ') : 'no change' }`);
            }
            log(`${ rescored.length } run(s)' checks computed again, ${ rescored.filter(({ changes }) => changes.length > 0).length } of them changed`);
            summariseResults(results, { agent: args.agent });
        }
        else if (args.rescoreOnly) {
            const sandbox = checksSandbox(process.platform, { unsandboxed: args.unsandboxed });
            await rescoreResults(store.directory, args.work, { sandboxProblems: () => sandbox.problems, checks: sandbox.checks, agents: args.agent ? [ args.agent ] : AGENTS });
            summariseResults(store.directory, { agent: args.agent });
        }
        else {
            await evaluate(args);
        }
    }
    catch (error) {
        console.error(`eval:skill-layouts: ${ (error as Error).message }`);
        process.exitCode = 1;
    }
}
