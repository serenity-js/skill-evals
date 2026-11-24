// pnpm run eval:skill-layouts -- [--pilot [--layouts <list>] [--requests <list>] [--repeats <n>] | --smoke | --held-back <layout>]
//                                  [--agent <kiro|copilot>] [--prepare-only | --summarise | --compare | --rescore | --reparse | --rescore-checks]
//                                  --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>]
// pnpm run eval:skill-layouts -- --check-references --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>]
//
// Evaluates how a package's skills should be laid out: packs the Serenity/JS packages, gives them each layout's
// skills, installs them into copies of the Mocha template, runs Kiro and GitHub Copilot on each request, and scores the
// runs. See the README next to this directory's src/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ensurePortFree, withApiServer } from './api-server.ts';
import { type AgentConditions, checkConditions, type Conditions, fixtureHashes, hashOf, lockfileHashes, recordAgentConditions, recordLockfiles, savedLockfileOf } from './conditions.ts';
import { type Check, CHECKLIST, conventionsScore } from './conventions.ts';
import { evalRoot, isLayout, type Layout, LAYOUTS } from './layouts.ts';
import { checkExamples, checkTemplateCommit, layoutTarballs, packPackages, prepareProject } from './project.ts';
import { compareResults } from './compare.ts';
import { readPlan, readRecord, readScores } from './records.ts';
import { checkReference, type ReferenceCheck, renderReferenceCheck } from './references.ts';
import { loadRequests, type Request } from './requests.ts';
import { type Agent, AGENTS, combineVerdicts, disagreements, type PlannedRun, planRuns, type RunKey, scoresTemplate } from './review.ts';
import { renderSmoke, SMOKE_REQUEST, smokeChecks, smokeProblem } from './smoke.ts';
import { checksOf, type Config, loadConfig, type Mode, modelsOf, performRun, agentsToRun, preflightProblems, rebuildWorkingCopy, reparseRecord, rescoreNetworkFailures, runsFor, sandboxProblems, scoreRun, startRun, writeReviewPacket } from './runs.ts';
import { decideWhenComplete, renderSummary, type RunResult, summarise } from './summary.ts';

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
}

const USAGE = 'usage: eval:skill-layouts [--pilot [--layouts <list>] [--requests <list>] [--repeats <n>] | --smoke | --held-back <layout>] [--agent <kiro|copilot>] [--prepare-only | --summarise | --compare | --rescore | --reparse | --rescore-checks] --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>]\n'
    + '       eval:skill-layouts --check-references --serenity-js <clone> --out <dir> [--template <dir>] [--work <dir>]';

export function parseArguments(argv: string[], cwd: string): Arguments {
    const options = new Map<string, string>();
    const flags = new Set<string>();
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if ([ '--pilot', '--smoke', '--prepare-only', '--summarise', '--rescore', '--reparse', '--rescore-checks', '--check-references', '--compare' ].includes(argument)) {
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
    if (checkReferencesOnly && (flags.size > 1 || heldBack !== undefined || agent !== undefined)) {
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
    };
}

const modeName = (mode: Mode) => mode.mode === 'held-back' ? `held-back-${ mode.layout }` : mode.mode;
const log = (message: string) => console.log(`eval:skill-layouts: ${ message }`);

function versionOf(command: string): string {
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
    if (! existsSync(join(results, 'mapping.json'))) {
        return undefined;
    }
    const keys = runsFor(mode, loadRequests());
    const planned = readPlan(results);
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
    writeFileSync(join(results, 'mapping.json'), `${ JSON.stringify(planned, null, 2) }\n`);
    return planned;
}

async function evaluate(args: Arguments): Promise<void> {
    const results = join(args.out, modeName(args.mode));
    const review = join(results, 'review');
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

    if (! args.prepareOnly) {
        const problems = preflightProblems(agents, config, process.env, { home: homedir(), sandboxProblems: () => sandboxProblems(process.platform) });
        if (problems.length > 0) {
            throw new Error(problems.join('\n'));
        }
        // before packing and preparing anything, which takes minutes
        await ensurePortFree(config.apiServer.port);
    }
    checkTemplateCommit(args.template, config.template.commit);
    const conditionsFile = join(results, 'conditions.json');
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
        const project = prepareProject(layout, { directory: args.template, commit: config.template.commit }, layoutTarballs(layout, packed, args.work), args.work, savedLockfileOf(results, layout));
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
        const runResults = join(results, 'runs', run.id);
        if (! agents.includes(run.agent) || existsSync(join(runResults, 'result.json'))) {
            continue;
        }
        recordAgentConditions(conditionsFile, run.agent, agentConditions(run.agent));
        const request = requests.get(run.request)!;
        log(`run ${ index + 1 } of ${ planned.length }: ${ run.id }`);
        // a server of the run's own, from before the agent starts until the harness's npm test is done
        await withApiServer(join(runResults, 'server.jsonl'), config.apiServer.port, async server => {
            const directory = startRun(run, request, projects.get(run.layout)!, args.work, server.urls);
            // Kiro's stream reports no version, so the run records the one kiro-cli --version printed
            const performed = { ...await performRun(run, request, directory, runResults, args.work, config, server), agentVersion: versions.get(run.agent) };
            if (args.mode.mode !== 'smoke') {
                await scoreRun(run, request, directory, runResults, performed, config, server);
                writeReviewPacket(run, request, runResults, review);
                return;
            }
            // the smoke run reports what stopped its scoring, rather than stopping
            try {
                await scoreRun(run, request, directory, runResults, performed, config, server);
                writeReviewPacket(run, request, runResults, review);
            }
            catch (error) {
                errors.set(run.id, (error as Error).message);
            }
        });
    }

    if (args.mode.mode === 'smoke') {
        writeFixtures(results, fixtures);
        reportSmoke(planned.filter(run => agents.includes(run.agent)), results, review, config, errors);
        return;
    }

    writeFixtures(results, fixtures);
    const scores = join(review, 'scores.json');
    if (! existsSync(scores)) {
        writeFileSync(scores, `${ JSON.stringify(scoresTemplate(planned), null, 2) }\n`);
    }
    await rescoreResults(results, args.work, { agents });
    summariseResults(results, { agent: args.agent });
}

/** Prints the smoke run's checks, one line each, and fails, naming the failed checks, when any failed. */
function reportSmoke(runs: PlannedRun[], results: string, review: string, config: Config, errors: Map<string, string>): void {
    const problems = runs.flatMap(run => {
        const directory = join(results, 'runs', run.id);
        const resultFile = join(directory, 'result.json');
        const record = existsSync(resultFile) ? readRecord(resultFile) : undefined;
        const packetFile = join(review, `${ run.id }.md`);
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
            logs: { tsc: existsSync(join(directory, 'tsc.log')), test: existsSync(join(directory, 'test.log')) },
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
    const planned = readPlan(results, agents);
    const requests = requestsById();
    const reparsed = planned
        .filter(run => existsSync(join(results, 'runs', run.id, 'result.json')) && existsSync(join(results, 'runs', run.id, 'stream.jsonl')))
        .map(run => {
            const directory = join(results, 'runs', run.id);
            return { file: join(directory, 'result.json'), ...reparseRecord(run, requests.get(run.request)!, readRecord(join(directory, 'result.json')), readFileSync(join(directory, 'stream.jsonl'), 'utf8'), config) };
        });
    const problems = reparsed.flatMap(({ problem }) => problem ?? []);
    if (problems.length > 0) {
        throw new Error(`nothing reparsed: ${ problems.join('; ') }`);
    }
    for (const { file, record } of reparsed) {
        writeFileSync(file, `${ JSON.stringify(record, null, 2) }\n`);
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
    const planned = readPlan(results, agents)
        .filter(run => existsSync(join(results, 'runs', run.id, 'result.json')) && existsSync(join(results, 'runs', run.id, 'diff.patch')));
    const requests = requestsById();
    const { commit } = (JSON.parse(readFileSync(join(results, 'conditions.json'), 'utf8')) as Conditions).shared.template;
    const problems: string[] = [];
    const rescored = planned.flatMap(run => {
        const file = join(results, 'runs', run.id, 'result.json');
        const diff = readFileSync(join(results, 'runs', run.id, 'diff.patch'), 'utf8');
        const kept = join(work, 'runs', run.id);
        const isKept = existsSync(join(kept, '.git'));
        const directory = isKept ? kept : join(work, 'rescore-checks', run.id);
        try {
            if (! isKept) {
                rebuildWorkingCopy(directory, { template, commit, fixture: requests.get(run.request)!.fixture }, diff);
            }
            const record = readRecord(file);
            const checks = checksOf(directory, diff);
            return [ { run, file, record: { ...record, checks, checksRescored: new Date().toISOString() }, changes: changesBetween(record.checks, checks) } ];
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
    for (const { file, record } of rescored) {
        writeFileSync(file, `${ JSON.stringify(record, null, 2) }\n`);
    }

    const review = join(results, 'review');
    const scoresFile = join(review, 'scores.json');
    const scores = readScores(scoresFile);
    for (const { run } of rescored) {
        scores[run.id] = { ...Object.fromEntries(CHECKLIST.map(item => [ item.id, '' ])), ...scores[run.id] };
        writeReviewPacket(run, requests.get(run.request)!, join(results, 'runs', run.id), review);
    }
    if (rescored.length > 0) {
        writeFileSync(scoresFile, `${ JSON.stringify(Object.fromEntries(Object.entries(scores).sort(([ one ], [ other ]) => one.localeCompare(other))), null, 2) }\n`);
    }
    return rescored.map(({ run, changes }) => ({ id: run.id, changes }));
}

/**
 * Writes fixtures.json, with every agent that has run in this --out, and its model and version as conditions.json
 * recorded them, whichever agents this invocation runs.
 */
export function writeFixtures(results: string, fixtures: object): void {
    const conditions = join(results, 'conditions.json');
    const agents = existsSync(conditions) ? (JSON.parse(readFileSync(conditions, 'utf8')) as Conditions).agents : {};
    writeFileSync(join(results, 'fixtures.json'), `${ JSON.stringify({ ...fixtures, agents }, null, 2) }\n`);
}

/**
 * Scores the network failures again, where their run directories are still in `work`. It reruns the harness's checks,
 * so it refuses to rescore anything where they can't run sandboxed, as inside another sandbox, and leaves every
 * result.json as it was: checks that can't start would turn each network failure into a false failure.
 */
export async function rescoreResults(
    results: string, work: string,
    { sandboxProblems: problems = () => sandboxProblems(process.platform), config = loadConfig(), agents = AGENTS }:
        { sandboxProblems?: () => string[], config?: Config, agents?: readonly Agent[] } = {},
): Promise<void> {
    const refusals = problems();
    if (refusals.length > 0) {
        throw new Error(`nothing rescored: ${ refusals.join('; ') }`);
    }
    // the runs' test scripts, and the URLs in their code, name the port they were made with; results from before the
    // local API server have none, and call the public APIs, so rescoring them against the local server would score
    // the public APIs' latency, not their code
    const conditions = join(results, 'conditions.json');
    const made = existsSync(conditions) ? (JSON.parse(readFileSync(conditions, 'utf8')) as { shared: Partial<Conditions['shared']> }).shared.apiServer : undefined;
    if (made === undefined) {
        throw new Error("nothing rescored: these results come from before the local API server, so their runs' code calls the public APIs, and can't be rescored against it");
    }
    if (made.port !== config.apiServer.port) {
        throw new Error(`nothing rescored: the runs were made with the local API server on port ${ made.port }, but config.json sets ${ config.apiServer.port }, so the URLs in their code wouldn't answer: put the port back`);
    }
    const planned = readPlan(results, agents);
    const { rescored, remaining, missing } = await rescoreNetworkFailures(planned, requestsById(), results, work, config);
    log(`${ rescored } network failure(s) scored again; ${ remaining } not rescored${ missing.length > 0 ? `, ${ missing.length } of them without a run directory in ${ work }` : '' }`);
}

/**
 * The summary of a mode's results, with the reviewer's scores where there are any, in summary.md and summary.json.
 * With an agent, it counts and decides on that agent's planned runs only, since a plan has runs of every agent, and a
 * round run with --agent leaves the other agent's runs without results for good. Without one, it covers every agent,
 * and the decision waits for all of their runs.
 */
export function summariseResults(results: string, { agent }: { agent?: Agent } = {}): void {
    const planned = readPlan(results, agent ? [ agent ] : AGENTS);
    const scores = readScores(join(results, 'review', 'scores.json'));
    const done = new Set(existsSync(join(results, 'runs')) ? readdirSync(join(results, 'runs')) : []);

    const scored = planned
        .filter(run => done.has(run.id) && existsSync(join(results, 'runs', run.id, 'result.json')))
        .map(run => ({ run, record: readRecord(join(results, 'runs', run.id, 'result.json')) }));

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
    writeFileSync(join(results, 'summary.json'), `${ JSON.stringify({ ...(agent ? { agent } : {}), runs: runResults.length, planned: planned.length, reviewed, review, summary, decision }, null, 2) }\n`);
    writeFileSync(join(results, 'summary.md'), [
        renderSummary(summary, decision),
        agent
            ? `${ agent }'s runs only: ${ runResults.length } of its ${ planned.length } planned runs scored; ${ reviewed } reviewed.`
            : `Every agent's runs: ${ runResults.length } of ${ planned.length } planned runs scored; ${ reviewed } reviewed.`,
        `The reviewer's verdict replaces the AST patterns' for every item they scored. They disagreed with the patterns on ${ review.disagreed } of the ${ review.scored } items they scored.`,
        '',
    ].join('\n'));
    log(`${ runResults.length } of ${ planned.length } runs${ agent ? ` of ${ agent }` : '' } scored, ${ reviewed } reviewed: ${ join(results, 'summary.md') }`);
}

/**
 * Checks every request's reference solution, held back or not, in layout None's project, with a local API server of
 * its own: each passes tsc and npm test, and fails npm test with its expected value made wrong. Prints one line per
 * request, and fails, naming them, when any reference failed. It runs tsc and npm test as the evaluation's checks run,
 * under sandbox-exec, so it refuses to check anything where sandbox-exec can't start.
 */
export async function checkReferences(
    args: Arguments,
    { sandboxProblems: problems = () => sandboxProblems(process.platform), config = loadConfig() }: { sandboxProblems?: () => string[], config?: Config } = {},
): Promise<void> {
    const refusals = problems();
    if (refusals.length > 0) {
        throw new Error(`nothing checked: ${ refusals.join('; ') }`);
    }
    await ensurePortFree(config.apiServer.port);
    checkTemplateCommit(args.template, config.template.commit);
    const results = join(args.out, 'check-references');
    mkdirSync(results, { recursive: true });

    log(`packing the packages in ${ args.serenityJs }`);
    const packed = packPackages(args.serenityJs, args.work);
    log(`installing layout none into a copy of ${ args.template }`);
    const project = prepareProject('none', { directory: args.template, commit: config.template.commit }, layoutTarballs('none', packed, args.work), args.work, savedLockfileOf(results, 'none'));

    const { requests, heldBack } = loadRequests();
    const checks: ReferenceCheck[] = [];
    for (const request of [ ...requests, ...heldBack ]) {
        const check = await withApiServer(join(results, request.id, 'server.jsonl'), config.apiServer.port, server =>
            checkReference(request, { project, work: args.work, results, urls: server.urls, testTimeoutMinutes: config.testTimeoutMinutes }));
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
        if (args.compareOnly) {
            const results = join(args.out, modeName(args.mode));
            writeFileSync(join(results, 'compare.md'), compareResults(results, { agent: args.agent }));
            log(`the layouts compared, request by request: ${ join(results, 'compare.md') }`);
        }
        else if (args.checkReferencesOnly) {
            await checkReferences(args);
        }
        else if (args.summariseOnly) {
            summariseResults(join(args.out, modeName(args.mode)), { agent: args.agent });
        }
        else if (args.reparseOnly) {
            reparseResults(join(args.out, modeName(args.mode)), { agents: args.agent ? [ args.agent ] : AGENTS });
            summariseResults(join(args.out, modeName(args.mode)), { agent: args.agent });
        }
        else if (args.rescoreChecksOnly) {
            const results = join(args.out, modeName(args.mode));
            const rescored = rescoreChecks(results, { work: args.work, template: args.template, agents: args.agent ? [ args.agent ] : AGENTS });
            for (const { id, changes } of rescored) {
                log(`run ${ id }: ${ changes.length > 0 ? changes.join(', ') : 'no change' }`);
            }
            log(`${ rescored.length } run(s)' checks computed again, ${ rescored.filter(({ changes }) => changes.length > 0).length } of them changed`);
            summariseResults(results, { agent: args.agent });
        }
        else if (args.rescoreOnly) {
            await rescoreResults(join(args.out, modeName(args.mode)), args.work, { agents: args.agent ? [ args.agent ] : AGENTS });
            summariseResults(join(args.out, modeName(args.mode)), { agent: args.agent });
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
