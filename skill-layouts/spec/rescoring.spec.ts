import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reparseResults, rescoreResults, summariseResults } from '../src/cli.ts';
import { freePort, startApiServer, urlsOf } from '../src/api-server.ts';
import { unreachable } from '../src/outcome.ts';
import { agentVersionOf, commandDidNotStart, type Config, rescoreNetworkFailures, resultOf, type RunRecord, scoreRun, startRun } from '../src/runs.ts';
import { promptFor } from '../src/requests.ts';
import type { PlannedRun } from '../src/review.ts';

const config: Config = { models: { kiro: 'claude-sonnet-5.5', copilot: 'claude-sonnet-5.5' }, template: { commit: 'abc' }, apiServer: { port: 4170 }, runTimeoutMinutes: 1, testTimeoutMinutes: 1 };
const request = { id: '1-new-feature', kind: '', prompt: 'Add a scenario.', needs: [], apis: [ 'mathjs' as const ] };
const run: PlannedRun = { id: '3f9c2a1e', agent: 'kiro', layout: 'b', request: '1-new-feature', repeat: 1 };
const template = { name: 'template', scripts: { test: 'cross-env BASE_API_URL=http://api.mathjs.org/v4/ mocha' } };
const testScriptIn = (directory: string) => (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof template).scripts.test;

const networkFailure = {
    id: run.id, outcome: 'network-failure', tsc: { exitCode: 0 }, test: { exitCode: 1 }, loading: undefined, skillReads: [], checks: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, durationMs: 1, agentExitCode: 0, timedOut: false, testAttempts: 3,
    unreachable: [ 'https://api.mathjs.org/v4/?expr=1' ], costUsd: undefined, tokensReported: false, credits: undefined, models: [ 'claude-sonnet-5.5' ], modelAnswered: true, modelUnreported: false, agentVersion: '',
} satisfies RunRecord;

describe('rescoring and summarising', () => {

    let root: string;
    let results: string;
    let work: string;
    // the evaluation's config, with the local API server on a port that's free here
    let evaluation: Config;
    const resultFile = () => join(results, 'runs', run.id, 'result.json');

    beforeEach(async () => {
        evaluation = { ...config, apiServer: { port: await freePort() } };
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-rescore-'));
        results = join(root, 'results');
        work = join(root, 'work');
        mkdirSync(join(results, 'runs', run.id), { recursive: true });
        mkdirSync(join(work, 'runs', run.id), { recursive: true });
        writeFileSync(join(work, 'runs', run.id, 'package.json'), JSON.stringify(template));
        writeFileSync(join(results, 'mapping.json'), JSON.stringify([ run ]));
        writeFileSync(resultFile(), JSON.stringify(networkFailure, null, 2));
        writeFileSync(join(results, 'runs', run.id, 'tsc.log'), 'the run\'s tsc');
        writeFileSync(join(results, 'runs', run.id, 'test.log'), 'the run\'s npm test');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('--summarise never writes result.json, though a network failure could be rescored', () => {
        // the CLI's own process, with the results in <out>/full and the run's directory in --work, as after an evaluation
        const out = join(root, 'out');
        mkdirSync(out);
        execFileSync('mv', [ results, join(out, 'full') ]);
        const file = join(out, 'full', 'runs', run.id, 'result.json');
        const before = readFileSync(file, 'utf8');
        const modified = statSync(file).mtimeMs;

        execFileSync(process.execPath, [ join(import.meta.dirname, '..', 'src', 'cli.ts'), '--summarise', '--out', out, '--work', work ], { stdio: 'pipe' });

        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(statSync(file).mtimeMs).toBe(modified);
        expect(existsSync(join(out, 'full', 'summary.md'))).toBe(true);
    });

    it('--summarise reports the runs that are done, and withholds the decision while a run of the other agent has none', () => {
        const copilotRun: PlannedRun = { ...run, id: 'b7c8d9e0', agent: 'copilot' };
        writeFileSync(join(results, 'mapping.json'), JSON.stringify([ run, copilotRun ]));
        writeFileSync(resultFile(), JSON.stringify({ ...networkFailure, outcome: 'correct' }, null, 2));

        summariseResults(results);

        const summary = JSON.parse(readFileSync(join(results, 'summary.json'), 'utf8'));
        expect(summary).toMatchObject({ runs: 1, planned: 2, decision: { outcome: 'incomplete' } });
        expect(summary.decision.reasons).toEqual([ "1 of the 2 planned runs have no result yet, so there's no decision." ]);
        expect(summary.summary.b.kiro.runs).toBe(1);
    });

    describe('with --agent, when the plan has runs of both agents and only one of them ran', () => {

        const copilotRun: PlannedRun = { ...run, id: 'b7c8d9e0', agent: 'copilot' };

        beforeEach(() => {
            writeFileSync(join(results, 'mapping.json'), JSON.stringify([ run, copilotRun ]));
            writeFileSync(resultFile(), JSON.stringify({ ...networkFailure, outcome: 'correct' }, null, 2));
        });

        it("counts and decides on that agent's planned runs only, and says which agent it covers", () => {
            // the reviewer has scored the other agent's run, from an earlier round in the same --out
            mkdirSync(join(results, 'review'));
            writeFileSync(join(results, 'review', 'scores.json'), JSON.stringify({ [copilotRun.id]: { 'structure': 'pass' } }));

            summariseResults(results, { agent: 'kiro' });

            const summary = JSON.parse(readFileSync(join(results, 'summary.json'), 'utf8'));
            expect(summary).toMatchObject({ agent: 'kiro', runs: 1, planned: 1, reviewed: 0 });
            expect(summary.summary.b).toEqual({ kiro: expect.any(Object) });
            expect(summary.decision.reasons.join('\n')).not.toMatch(/planned runs have no result/);

            const markdown = readFileSync(join(results, 'summary.md'), 'utf8');
            expect(markdown).toContain("kiro's runs only: 1 of its 1 planned runs scored; 0 reviewed.");
            expect(markdown).not.toContain('No decision yet');
        });

        it("still waits for that agent's own runs that have no result", () => {
            const secondKiroRun: PlannedRun = { ...run, id: 'c1d2e3f4', repeat: 2 };
            writeFileSync(join(results, 'mapping.json'), JSON.stringify([ run, copilotRun, secondKiroRun ]));

            summariseResults(results, { agent: 'kiro' });

            const summary = JSON.parse(readFileSync(join(results, 'summary.json'), 'utf8'));
            expect(summary).toMatchObject({ agent: 'kiro', runs: 1, planned: 2, decision: { outcome: 'incomplete' } });
            expect(summary.decision.reasons).toEqual([ "1 of the 2 planned runs of kiro have no result yet, so there's no decision." ]);
        });

        it('covers every agent without --agent, and says so', () => {
            summariseResults(results);

            const summary = JSON.parse(readFileSync(join(results, 'summary.json'), 'utf8'));
            expect(summary.agent).toBeUndefined();
            expect(readFileSync(join(results, 'summary.md'), 'utf8')).toContain('Every agent\'s runs: 1 of 2 planned runs scored; 0 reviewed.');
        });

        it('--summarise --agent kiro covers kiro only, from the command line', () => {
            const out = join(root, 'out');
            mkdirSync(out);
            execFileSync('mv', [ results, join(out, 'full') ]);

            execFileSync(process.execPath, [ join(import.meta.dirname, '..', 'src', 'cli.ts'), '--summarise', '--agent', 'kiro', '--out', out, '--work', work ], { stdio: 'pipe' });

            expect(JSON.parse(readFileSync(join(out, 'full', 'summary.json'), 'utf8'))).toMatchObject({ agent: 'kiro', runs: 1, planned: 1 });
        });
    });

    it("--rescore refuses to rescore anything when sandbox-exec can't start, says why, and changes no result.json", async () => {
        const before = readFileSync(resultFile(), 'utf8');

        await expect(rescoreResults(results, work, { sandboxProblems: () => [ "sandbox-exec can't start here" ], config }))
            .rejects.toThrow(/nothing rescored: sandbox-exec can't start here/);
        expect(readFileSync(resultFile(), 'utf8')).toBe(before);
    });

    it("keeps the run's own logs, and writes the rescore's next to them", async () => {
        const commands: string[] = [];
        await rescoreNetworkFailures([ run ], new Map([ [ request.id, request ] ]), results, work, evaluation, {
            runCommand: (command, args, _, logFile) => {
                commands.push(`${ command } ${ args.join(' ') } > ${ logFile.split('/').pop() }`);
                writeFileSync(logFile, 'rescored');
                return { exitCode: 0, log: 'rescored' };
            },
        });

        expect(commands).toEqual([ 'npx tsc --noEmit > tsc.rescored.log', 'npm test > test.rescored.log' ]);
        expect(readFileSync(join(results, 'runs', run.id, 'tsc.log'), 'utf8')).toBe('the run\'s tsc');
        expect(readFileSync(join(results, 'runs', run.id, 'test.log'), 'utf8')).toBe('the run\'s npm test');
        expect(JSON.parse(readFileSync(resultFile(), 'utf8')).outcome).toBe('correct');
    });

    it("starts the local API server on the evaluation's port, so the URLs the run's code calls, from its prompt, still answer", async () => {
        const request4 = { ...request, prompt: 'Add a scenario that gets the latest rate at {{frankfurter}}/latest?base=EUR&symbols=USD.', apis: [ 'mathjs' as const, 'frankfurter' as const ] };
        // the URL the agent wrote into its scenario, from the prompt of the run
        const scenarioUrl = /http\S+/.exec(promptFor(request4, urlsOf(evaluation.apiServer.port)))![0].replace(/\.$/, '');
        const scenario = `require('node:http').get(${ JSON.stringify(scenarioUrl) }, { agent: new (require('node:http').Agent)() }, response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))`;

        await rescoreNetworkFailures([ run ], new Map([ [ request.id, request4 ] ]), results, work, evaluation, {
            runCommand: (command, _, __, logFile) => {
                const exitCode = command === 'npm' ? spawnSync(process.execPath, [ '-e', scenario ]).status ?? 1 : 0;
                writeFileSync(logFile, `exited with ${ exitCode }`);
                return { exitCode, log: `exited with ${ exitCode }` };
            },
        });

        expect(JSON.parse(readFileSync(resultFile(), 'utf8')).outcome).toBe('correct');
        expect(testScriptIn(join(work, 'runs', run.id))).toBe(template.scripts.test);
        expect(existsSync(join(results, 'runs', run.id, 'server.rescored.jsonl'))).toBe(true);
        expect(await unreachable([ scenarioUrl ], 1000)).toHaveLength(1);
    });

    it("stops the rescore, with the server's output, and changes nothing, when the local API server doesn't answer", async () => {
        const before = readFileSync(resultFile(), 'utf8');

        await expect(rescoreNetworkFailures([ run ], new Map([ [ request.id, request ] ]), results, work, evaluation, {
            probe: async urls => urls,
            runCommand: () => ({ exitCode: 1, log: '' }),
        })).rejects.toThrow(/run 3f9c2a1e: the local API server didn't answer http:\/\/127\.0\.0\.1:\d+\/v4\/\?expr=1, which is the harness's failure, not the run's\.\nIts output:\n[\s\S]*listening on \d+[\s\S]*Its last requests:/);
        expect(readFileSync(resultFile(), 'utf8')).toBe(before);
    });

    it('--rescore refuses results made before the local API server, says why, and changes no result.json', async () => {
        // conditions.json as the second pilot left it, with the public APIs
        writeFileSync(join(results, 'conditions.json'), JSON.stringify({ shared: { template: { commit: 'abc' }, requests: 'sha256:aaaa' }, agents: {} }));
        const before = readFileSync(resultFile(), 'utf8');

        await expect(rescoreResults(results, work, { sandboxProblems: () => [], config: evaluation }))
            .rejects.toThrow("nothing rescored: these results come from before the local API server, so their runs' code calls the public APIs, and can't be rescored against it");
        expect(readFileSync(resultFile(), 'utf8')).toBe(before);
    });

    it("--rescore refuses when config.json's port of the local API server isn't the one the runs were made with", async () => {
        writeFileSync(join(results, 'conditions.json'), JSON.stringify({ shared: { apiServer: { port: 4170 } }, agents: {} }));
        const before = readFileSync(resultFile(), 'utf8');

        await expect(rescoreResults(results, work, { sandboxProblems: () => [], config: { ...config, apiServer: { port: 4171 } } }))
            .rejects.toThrow("nothing rescored: the runs were made with the local API server on port 4170, but config.json sets 4171, so the URLs in their code wouldn't answer: put the port back");
        expect(readFileSync(resultFile(), 'utf8')).toBe(before);
    });

    it('empties JOBS_DIR and RESULTS_DIR before it reruns tsc and npm test', async () => {
        const directory = join(work, 'runs', run.id);
        for (const leftover of [ join(directory, 'jobs'), join(directory, 'job-results') ]) {
            mkdirSync(leftover);
            writeFileSync(join(leftover, 'job-1'), '7');
        }
        const leftovers: boolean[] = [];

        await rescoreNetworkFailures([ run ], new Map([ [ request.id, request ] ]), results, work, evaluation, {
            runCommand: (_, __, ___, logFile) => {
                leftovers.push(existsSync(join(directory, 'jobs', 'job-1')) || existsSync(join(directory, 'job-results', 'job-1')));
                writeFileSync(logFile, 'rescored');
                return { exitCode: 0, log: 'rescored' };
            },
        });

        expect(leftovers).toEqual([ false, false ]);
    });

    it("records in result.json whether the rescore's tsc and npm test ran under sandbox-exec", async () => {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        await rescoreNetworkFailures([ run ], new Map([ [ request.id, request ] ]), results, work, evaluation, {
            checks: { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true },
        });

        expect(JSON.parse(readFileSync(resultFile(), 'utf8'))).toMatchObject({ outcome: 'correct', checksSandboxed: false });
    });

    it("stops the rescore, and changes nothing, when a command couldn't start", async () => {
        const before = readFileSync(resultFile(), 'utf8');

        await expect(rescoreNetworkFailures([ run ], new Map([ [ request.id, request ] ]), results, work, evaluation, {
            runCommand: () => { throw commandDidNotStart('npx', 'spawn npx ENOENT'); },
        })).rejects.toThrow(/couldn't start npx: spawn npx ENOENT/);
        expect(readFileSync(resultFile(), 'utf8')).toBe(before);
    });
});

describe('startRun', () => {

    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-start-'));
        mkdirSync(join(root, 'project'));
        writeFileSync(join(root, 'project', 'package.json'), JSON.stringify(template));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("points the run's test script at its local API server before the run, so the change isn't in the agent's diff", () => {
        const urls = urlsOf(4567);

        const directory = startRun(run, request, join(root, 'project'), join(root, 'work'), urls);

        expect(testScriptIn(directory)).toBe('cross-env BASE_API_URL=http://127.0.0.1:4567/v4/ mocha');
        expect(execFileSync('git', [ 'status', '--porcelain' ], { cwd: directory, encoding: 'utf8' })).toBe('');
        expect(testScriptIn(join(root, 'project'))).toBe(template.scripts.test);
    });

    it("leaves the calculation jobs' job files, in JOBS_DIR, and results, in RESULTS_DIR, out of the agent's diff", () => {
        const directory = startRun(run, request, join(root, 'project'), join(root, 'work'), urlsOf(4567));
        mkdirSync(join(directory, 'jobs'));
        writeFileSync(join(directory, 'jobs', 'job-1'), '2 + 2');
        mkdirSync(join(directory, 'job-results'));
        writeFileSync(join(directory, 'job-results', 'job-1'), '4');

        expect(execFileSync('git', [ 'status', '--porcelain' ], { cwd: directory, encoding: 'utf8' })).toBe('');
    });
});

describe('scoreRun', () => {

    let directory: string;
    let results: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-score-'));
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-score-results-'));
        writeFileSync(join(directory, 'package.json'), '{}');
        const git = (...args: string[]) => execFileSync('git', [ '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args ], { cwd: directory, stdio: 'ignore' });
        git('init', '--quiet');
        git('add', '--all');
        git('commit', '--quiet', '--message', 'before the run');
        writeFileSync(join(results, 'stream.jsonl'), readFileSync(join(import.meta.dirname, 'fixtures', 'kiro-v3.pilot-8e3a4613.jsonl')));
    });
    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
        rmSync(results, { recursive: true, force: true });
    });

    it("empties JOBS_DIR and RESULTS_DIR before its tsc and npm test, so the files the agent's own test runs left can't make a scenario pass", async () => {
        // npm test fails while a result file the agent's run left is still there
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\ntest ! -e "$JOBS_DIR/job-1" && test ! -e "$RESULTS_DIR/job-1"\n', { mode: 0o755 });
        for (const leftover of [ join(directory, 'jobs'), join(directory, 'job-results') ]) {
            mkdirSync(leftover);
            writeFileSync(join(leftover, 'job-1'), '7');
        }

        const record = await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(record.outcome).toBe('correct');
        // given --unsandboxed, where sandbox-exec isn't available
        expect(JSON.parse(readFileSync(join(results, 'result.json'), 'utf8')).checksSandboxed).toBe(false);
    });

    describe('when the agent failed', () => {

        const passingChecks = () => {
            const bin = join(directory, 'bin');
            mkdirSync(bin);
            writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
            return { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true };
        };
        const server = { urls: urlsOf(4567), requests: () => [], output: () => '' };

        it("scores a run whose agent exited with an error as an agent failure, though the project's tsc and npm test pass", async () => {
            const record = await scoreRun(run, request, directory, results, { exitCode: 1, durationMs: 1, timedOut: false }, config, server, passingChecks());

            expect(record).toMatchObject({ outcome: 'agent-failure', agentFailure: expect.stringMatching(/exited with 1/), tsc: { exitCode: 0 }, test: { exitCode: 0 } });
            expect(JSON.parse(readFileSync(join(results, 'result.json'), 'utf8')).outcome).toBe('agent-failure');
        });

        it('scores a run without tool calls as an agent failure, whatever the agent exited with', async () => {
            const noTools = [ { type: 'runStarted', data: { payloadSchema: 'acp' } }, { type: 'sessionUpdate', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I cannot.' } } } }, { type: 'runFinished', data: {} } ];
            writeFileSync(join(results, 'stream.jsonl'), noTools.map(event => JSON.stringify(event)).join('\n'));

            const record = await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, server, passingChecks());

            expect(record).toMatchObject({ outcome: 'agent-failure', agentFailure: expect.stringMatching(/no tool calls/) });
        });

        it('scores a run that timed out, after tool calls, as it goes', async () => {
            const record = await scoreRun(run, request, directory, results, { exitCode: 1, durationMs: 1, timedOut: true }, config, server, passingChecks());

            expect(record).toMatchObject({ outcome: 'correct', agentFailure: undefined });
        });
    });

    it('records every model the Copilot run used, and that a model answered, in result.json', async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(results, 'stream.jsonl'), readFileSync(join(import.meta.dirname, 'fixtures', 'copilot-cli.synthetic.jsonl')));

        const record = await scoreRun({ ...run, agent: 'copilot' }, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, { ...config, models: { ...config.models, copilot: 'auto' } }, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(record).toMatchObject({ models: [ 'claude-opus-5.5', 'gpt-5.4' ], modelAnswered: true, modelUnreported: false });
        expect(JSON.parse(readFileSync(join(results, 'result.json'), 'utf8'))).toMatchObject({ models: [ 'claude-opus-5.5', 'gpt-5.4' ] });
    });

    it("records what Copilot's auto mode chose and could choose from, and its nano AIUs, from a recorded stream with tool calls", async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(results, 'stream.jsonl'), readFileSync(join(import.meta.dirname, 'fixtures', 'copilot-cli.smoke-e3c01675.jsonl')));

        const record = await scoreRun({ ...run, agent: 'copilot' }, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, { ...config, models: { ...config.models, copilot: 'auto' } }, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(JSON.parse(readFileSync(join(results, 'result.json'), 'utf8'))).toMatchObject({
            models: [ 'gpt-6-luna' ], modelUnreported: false, tokensReported: false, premiumRequests: 1, totalNanoAiu: 523_059_500,
            autoMode: { chosenModel: 'gpt-6-luna', availableModels: [ 'gpt-6-luna' ] },
        });
        expect(record.outcome).toBe('correct');
    });

    it("saves the agent's final reply next to the run's diff, for the review packet", async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const reply = { type: 'sessionUpdate', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Added the scenario. Suggestions: replace PostAndCheck.' } } } };
        writeFileSync(join(results, 'stream.jsonl'), `${ readFileSync(join(results, 'stream.jsonl'), 'utf8').trimEnd() }\n${ JSON.stringify(reply) }\n`);

        await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(readFileSync(join(results, 'reply.md'), 'utf8')).toBe('Added the scenario. Suggestions: replace PostAndCheck.\n');
    });

    it("scores every checklist item that applies to the code the run added, whatever its request exercises, in result.json", async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(directory, 'spec'));
        // request 1 exercises actor-names, but not names-without-the, which still applies to CheckTheResult
        writeFileSync(join(directory, 'spec', 'units.spec.ts'), "const CheckTheResult = () => Task.where(the`#actor checks the result`)\nactorCalled('Apisitt').attemptsTo(CheckTheResult())\n");

        const record = await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(Object.fromEntries(record.checks.filter(check => [ 'actor-names', 'names-without-the' ].includes(check.item)).map(check => [ check.item, check.verdict ])))
            .toEqual({ 'actor-names': 'fail', 'names-without-the': 'fail' });
    });

    it("scores the actors' names a run adds against the specs the project had before the run", async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        mkdirSync(join(directory, 'spec'));
        writeFileSync(join(directory, 'spec', 'math-js_api.spec.ts'), "it('adds', () => actorCalled('Apisitt').attemptsTo(Add(2, 2)))\n");
        execFileSync('git', [ 'add', 'spec' ], { cwd: directory, stdio: 'ignore' });
        execFileSync('git', [ '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'the project' ], { cwd: directory, stdio: 'ignore' });
        // the run adds a spec of its own, with a Role enum of its own, next to the project's 'Apisitt'
        writeFileSync(join(directory, 'spec', 'units.spec.ts'), "enum Role { Analyst = 'Apisitt, the analyst' }\nit('converts', () => actorCalled(Role.Analyst).attemptsTo(Convert('5 inch to cm')))\n");

        const record = await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(record.checks.find(check => check.item === 'consistent-actor-names')).toMatchObject({ verdict: 'fail', evidence: [ 'spec/units.spec.ts:2: actorCalled(Role.Analyst)' ] });
    });

    it("records the agent's version from kiro-cli --version, which the run recorded, since Kiro's stream has none", async () => {
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

        const record = await scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false, agentVersion: 'kiro-cli 3.3.0' }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true });

        expect(record.agentVersion).toBe('kiro-cli 3.3.0');
    });

    it("records the version the agent's stream reports over the installed one, as Copilot's session.start does", () => {
        expect(agentVersionOf({ agentVersion: '1.0.91' }, 'copilot 1.0.90')).toBe('1.0.91');
        expect(agentVersionOf({ agentVersion: '' }, 'kiro-cli 3.3.0')).toBe('kiro-cli 3.3.0');
        expect(agentVersionOf({ agentVersion: '' }, undefined)).toBe('');
    });

    it("stops scoring, with the reason, and saves no result.json, when npx can't start, rather than scoring the run as incorrect", async () => {
        await expect(scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, { urls: urlsOf(4567), requests: () => [], output: () => '' }, { env: { PATH: '/nonexistent' }, unsandboxed: true }))
            .rejects.toThrow(/couldn't start npx: .*ENOENT/);
        expect(existsSync(join(results, 'result.json'))).toBe(false);
    });

    it("stops scoring, with the server's output, and saves no result.json, when the local API server crashed during the run", async () => {
        // npx tsc passes, and npm test fails, as it would without the server
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "Error: connect ECONNREFUSED"\nexit 1\n', { mode: 0o755 });
        const server = await startApiServer({ port: await freePort(), log: join(results, 'server.jsonl') });
        await server.stop();

        await expect(scoreRun(run, request, directory, results, { exitCode: 0, durationMs: 1, timedOut: false }, config, server, { env: { PATH: `${ bin }:/usr/bin:/bin` }, unsandboxed: true }))
            .rejects.toThrow(/^run 3f9c2a1e: the local API server didn't answer http:\/\/127\.0\.0\.1:\d+\/v4\/\?expr=1, which is the harness's failure, not the run's\.\nIts output:\n[\s\S]*listening on \d+[\s\S]*Its last requests:/);
        expect(existsSync(join(results, 'result.json'))).toBe(false);
    });
});

describe('resultOf under sandbox-exec', () => {
    it('says whether the command ran under sandbox-exec', () => {
        const directory = mkdtempSync(join(tmpdir(), 'skill-layouts-sandboxed-'));
        try {
            expect(resultOf('true', [], directory, join(directory, 'log'), 1, { unsandboxed: true }).sandboxed).toBe(false);
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('commandDidNotStart', () => {
    it('says which command, and why', () => {
        expect(commandDidNotStart('npm', 'sandbox-exec: sandbox_apply: Operation not permitted').message)
            .toBe("couldn't start npm: sandbox-exec: sandbox_apply: Operation not permitted");
    });
});

describe('resultOf', () => {

    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-result-'));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    it("scores a command that runs past its timeout without printing anything as failed, rather than as one that couldn't start", () => {
        const result = resultOf('sleep', [ '5' ], directory, join(directory, 'sleep.log'), 0.005, { unsandboxed: true });

        expect(result.exitCode).not.toBe(0);
        expect(result.log).toMatch(/timed out after 0\.3 s/);
        expect(readFileSync(join(directory, 'sleep.log'), 'utf8')).toBe(result.log);
    });

    it("still stops on a command that couldn't start", () => {
        expect(() => resultOf('no-such-command', [], directory, join(directory, 'log'), 1, { unsandboxed: true }))
            .toThrow(/couldn't start no-such-command: .*ENOENT/);
    });
});

describe('reparseResults', () => {

    let results: string;
    const pilotRun: PlannedRun = { id: '8e3a4613', agent: 'kiro', layout: 'b', request: '4-new-http-api', repeat: 1 };
    const file = () => join(results, 'runs', pilotRun.id, 'result.json');
    // the pilot's result, as the parser for the format Kiro doesn't write left it
    const scored = {
        ...networkFailure, id: pilotRun.id, outcome: 'correct', checks: [ { item: 'tasks', verdict: 'n/a', evidence: [] } ], models: [], modelAnswered: false, modelUnreported: true,
        loading: { needed: [ 'serenity-js-screenplay/questions.md' ], read: [], missing: [ 'serenity-js-screenplay/questions.md' ], right: false },
    };

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-reparse-'));
        mkdirSync(join(results, 'runs', pilotRun.id), { recursive: true });
        writeFileSync(join(results, 'mapping.json'), JSON.stringify([ pilotRun ]));
        writeFileSync(file(), JSON.stringify(scored, null, 2));
        writeFileSync(join(results, 'runs', pilotRun.id, 'stream.jsonl'), readFileSync(join(import.meta.dirname, 'fixtures', 'kiro-v3.pilot-8e3a4613.jsonl')));
        writeFileSync(join(results, 'runs', pilotRun.id, 'tsc.log'), 'the run\'s tsc');
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    it('recomputes what comes from the stream, and keeps the outcome, the checks and the logs', () => {
        reparseResults(results, { config });

        const record = JSON.parse(readFileSync(file(), 'utf8'));
        expect(record.loading.read).toEqual([ 'serenity-js-screenplay/SKILL.md', 'serenity-js-screenplay/questions.md', 'serenity-js-writing-tests/SKILL.md' ]);
        // the pilot ran layout B as it was then, with questions.md beside SKILL.md, and its stream keeps that path; scored
        // against layout B as #3616 ships it now, under references/, its read doesn't count as the one the request needs
        expect(record.loading).toMatchObject({ needed: [ 'serenity-js-screenplay/references/questions.md', 'serenity-js-writing-tests/SKILL.md' ], missing: [ 'serenity-js-screenplay/references/questions.md' ], right: false });
        expect(record.skillReads).toHaveLength(3);
        expect(record).toMatchObject({ models: [ 'claude-sonnet-5.5' ], modelAnswered: true, modelUnreported: false, tokensReported: false, outcome: 'correct', checks: scored.checks });
        expect(record.credits).toBeCloseTo(1.0746, 4);
        expect(readFileSync(join(results, 'runs', pilotRun.id, 'tsc.log'), 'utf8')).toBe('the run\'s tsc');
    });

    it("leaves the other agent's runs alone with --agent", () => {
        const before = readFileSync(file(), 'utf8');

        reparseResults(results, { config, agents: [ 'copilot' ] });

        expect(readFileSync(file(), 'utf8')).toBe(before);
    });

    it('rewrites nothing when a stream reports a model other than the pin, and says which', () => {
        const before = readFileSync(file(), 'utf8');

        expect(() => reparseResults(results, { config: { ...config, models: { ...config.models, kiro: 'claude-opus-5.5' } } }))
            .toThrow(/nothing reparsed: run 8e3a4613: the run used claude-sonnet-5.5, but config.json pins claude-opus-5.5/);
        expect(readFileSync(file(), 'utf8')).toBe(before);
    });
});
