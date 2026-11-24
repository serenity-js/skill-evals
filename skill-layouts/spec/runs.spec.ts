import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments } from '../src/cli.ts';
import { LAYOUTS } from '../src/layouts.ts';
import { RUNS_PER_LAYOUT_FOR_A_DECISION } from '../src/summary.ts';
import { agentCommand, agentEnvironment, agentsToRun, environmentNames, loadConfig, modelProblem, preflightProblems, runsFor, sandboxed, sandboxProblems, sandboxProfile, spawnWithTimeout, testEnvironment } from '../src/runs.ts';

describe('loadConfig', () => {
    it('sets one port for the local API server, for the whole evaluation, so every run gets the same prompts and URLs', () => {
        expect(loadConfig().apiServer).toEqual({ port: 4170 });
    });

    it("pins Copilot to \"auto\", since the licence only includes Copilot Fusion, which has no model ID of its own", () => {
        expect(loadConfig().models.copilot).toBe('auto');
    });
});

describe('agentCommand', () => {

    it('runs Kiro headless, in its sandbox, with every tool trusted, the model pinned and the events streamed', () => {
        expect(agentCommand('kiro', 'claude-opus-5.5', 'Add a scenario.')).toEqual({
            command: 'kiro-cli',
            args: [ 'chat', '--v3', '--no-interactive', '--sandbox', '--trust-all-tools', '--output-format', 'stream-json', '--model', 'claude-opus-5.5', 'Add a scenario.' ],
        });
    });

    it('runs Copilot headless, with the model pinned, its events as JSONL, every tool allowed, its shell commands in the OS sandbox, and the local API server reachable', () => {
        expect(agentCommand('copilot', 'claude-opus-5.5', 'Add a scenario.')).toEqual({
            command: 'copilot',
            args: [
                '-p', 'Add a scenario.', '--output-format', 'json', '--model', 'claude-opus-5.5', '--no-ask-user',
                '--allow-all-tools', '--allow-url=127.0.0.1,localhost', '--sandbox', '--disable-builtin-mcps',
            ],
        });
    });
});

describe('runsFor', () => {

    const requests = {
        requests: Array.from({ length: 11 }, (_, index) => ({ id: `${ index + 1 }-request`, kind: '', prompt: '', needs: [], apis: [ 'mathjs' as const ] })),
        heldBack: [ { id: '12-request', kind: '', prompt: '', needs: [], apis: [ 'mathjs' as const ] }, { id: '13-request', kind: '', prompt: '', needs: [], apis: [ 'mathjs' as const ] } ],
    };

    it('plans every request, with every layout, in both agents, 3 times', () => {
        const runs = runsFor({ mode: 'full' }, requests);

        // the full evaluation plans the sample the decision rule needs, for each layout and agent
        for (const layout of LAYOUTS) {
            for (const agent of [ 'kiro', 'copilot' ] as const) {
                expect(runs.filter(run => run.layout === layout && run.agent === agent), `${ layout } with ${ agent }`).toHaveLength(RUNS_PER_LAYOUT_FOR_A_DECISION);
            }
        }

        expect(runs).toHaveLength(264);
        expect(new Set(runs.map(run => run.layout))).toEqual(new Set([ 'none', 'a', 'b', 'c' ]));
        expect(new Set(runs.map(run => run.agent))).toEqual(new Set([ 'kiro', 'copilot' ]));
        expect(runs.filter(run => run.layout === 'b' && run.agent === 'kiro')).toHaveLength(33);
    });

    it("plans the regression check by default: layouts None and B, once each, with requests 5, 6, 9 and 11, in both agents", () => {
        expect(runsFor({ mode: 'pilot' }, requests).map(run => `${ run.agent } ${ run.layout } ${ run.request } ${ run.repeat }`)).toEqual([
            'kiro none 5-request 1', 'kiro none 6-request 1', 'kiro none 9-request 1', 'kiro none 11-request 1',
            'kiro b 5-request 1', 'kiro b 6-request 1', 'kiro b 9-request 1', 'kiro b 11-request 1',
            'copilot none 5-request 1', 'copilot none 6-request 1', 'copilot none 9-request 1', 'copilot none 11-request 1',
            'copilot b 5-request 1', 'copilot b 6-request 1', 'copilot b 9-request 1', 'copilot b 11-request 1',
        ]);
    });

    it('plans a pilot of other layouts and requests, once each, in both agents, as --layouts and --requests ask', () => {
        expect(runsFor({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, requests).map(run => `${ run.agent } ${ run.layout } ${ run.request } ${ run.repeat }`)).toEqual([
            'kiro a 9-request 1', 'kiro a 11-request 1',
            'kiro c 9-request 1', 'kiro c 11-request 1',
            'copilot a 9-request 1', 'copilot a 11-request 1',
            'copilot c 9-request 1', 'copilot c 11-request 1',
        ]);
    });

    it("plans the pilot's own requests with other layouts, and its own layouts with other requests", () => {
        expect(new Set(runsFor({ mode: 'pilot', layouts: [ 'a' ] }, requests).map(run => run.request))).toEqual(new Set([ '5-request', '6-request', '9-request', '11-request' ]));
        expect(new Set(runsFor({ mode: 'pilot', requests: [ '9' ] }, requests).map(run => run.layout))).toEqual(new Set([ 'none', 'b' ]));
    });

    it('repeats each run of a pilot as --repeats asks, once by default', () => {
        const repeated = runsFor({ mode: 'pilot', layouts: [ 'a' ], requests: [ '9' ], repeats: 3 }, requests);

        expect(repeated.map(run => `${ run.agent } ${ run.layout } ${ run.request } ${ run.repeat }`)).toEqual([
            'kiro a 9-request 1', 'kiro a 9-request 2', 'kiro a 9-request 3',
            'copilot a 9-request 1', 'copilot a 9-request 2', 'copilot a 9-request 3',
        ]);
        expect(runsFor({ mode: 'pilot', layouts: [ 'a' ], requests: [ '9' ] }, requests)).toHaveLength(2);
    });

    it("refuses a request that isn't one of the main requests, such as a held-back one", () => {
        expect(() => runsFor({ mode: 'pilot', requests: [ '9', '12' ] }, requests)).toThrow('--requests takes the numbers of main requests, 1 to 11, not 12');
    });

    it('plans the held-back requests with the chosen layout, in both agents, 3 times', () => {
        const runs = runsFor({ mode: 'held-back', layout: 'b' }, requests);

        expect(runs).toHaveLength(12);
        expect(new Set(runs.map(run => run.request))).toEqual(new Set([ '12-request', '13-request' ]));
        expect(new Set(runs.map(run => run.layout))).toEqual(new Set([ 'b' ]));
    });
});

describe('parseArguments', () => {

    const out = [ '--out', '/out' ];

    it('takes the serenity-js clone, and the directory the results go to', () => {
        expect(parseArguments([ '--serenity-js', '/work/serenity-js', ...out ], '/cwd')).toEqual({
            mode: { mode: 'full' },
            serenityJs: '/work/serenity-js',
            template: '/work/serenity-js-mocha-template',
            out: '/out',
            work: expect.stringContaining('skill-layouts'),
            prepareOnly: false,
            summariseOnly: false,
            rescoreOnly: false,
            reparseOnly: false,
            compareOnly: false,
            rescoreChecksOnly: false,
            agent: undefined,
            checkReferencesOnly: false,
        });
    });

    it('takes the layouts and the requests of a pilot, as lists', () => {
        expect(parseArguments([ '--pilot', '--layouts', 'a,c', '--requests', '9,11', '--serenity-js', '/s', ...out ], '/cwd').mode)
            .toEqual({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] });
    });

    it("leaves a pilot's layouts and requests to their defaults when they aren't given", () => {
        expect(parseArguments([ '--pilot', '--serenity-js', '/s', ...out ], '/cwd').mode).toEqual({ mode: 'pilot' });
    });

    it('refuses --layouts or --requests without --pilot, since only a pilot takes them', () => {
        expect(() => parseArguments([ '--layouts', 'a,c', '--serenity-js', '/s', ...out ], '/cwd')).toThrow('--layouts, --requests and --repeats only go with --pilot');
        expect(() => parseArguments([ '--held-back', 'b', '--requests', '9', '--serenity-js', '/s', ...out ], '/cwd')).toThrow('--layouts, --requests and --repeats only go with --pilot');
    });

    it.each([
        [ 'an empty list of layouts',  [ '--layouts', ',' ],     '--layouts takes at least one layout' ],
        [ 'an empty list of requests', [ '--requests', ', ,' ],  '--requests takes at least one request' ],
        [ 'a layout named twice',      [ '--layouts', 'a,a' ],   '--layouts names a more than once' ],
        [ 'a request named twice',     [ '--requests', '9,9' ],  '--requests names 9 more than once' ],
    ])('refuses %s, since a pilot runs each combination once', (_, option, message) => {
        expect(() => parseArguments([ '--pilot', ...option, '--serenity-js', '/s', ...out ], '/cwd')).toThrow(message);
    });

    it('takes the number of times a pilot repeats each run', () => {
        expect(parseArguments([ '--pilot', '--repeats', '3', '--serenity-js', '/s', ...out ], '/cwd').mode).toEqual({ mode: 'pilot', repeats: 3 });
    });

    it.each([ '0', '-1', '1.5', 'three' ])('refuses --repeats %s, which is not a whole number of times', repeats => {
        expect(() => parseArguments([ '--pilot', '--repeats', repeats, '--serenity-js', '/s', ...out ], '/cwd')).toThrow(`--repeats takes a whole number of times, 1 or more, not ${ repeats }`);
    });

    it('refuses --repeats without --pilot, since the full evaluation and the held-back requests repeat their runs 3 times', () => {
        expect(() => parseArguments([ '--repeats', '2', '--serenity-js', '/s', ...out ], '/cwd')).toThrow('--layouts, --requests and --repeats only go with --pilot');
    });

    it("refuses a layout that isn't one", () => {
        expect(() => parseArguments([ '--pilot', '--layouts', 'a,d', '--serenity-js', '/s', ...out ], '/cwd')).toThrow('--layouts takes layouts: none, a, b or c, not d');
    });

    it('resolves the directories it is given against the working directory', () => {
        const parsed = parseArguments([ '--pilot', '--serenity-js', '../serenity-js', '--out', 'results', '--work', 'runs', '--template', 'template' ], '/cwd/here');

        expect(parsed).toMatchObject({ mode: { mode: 'pilot' }, serenityJs: '/cwd/serenity-js', out: '/cwd/here/results', work: '/cwd/here/runs', template: '/cwd/here/template' });
    });

    it('takes the layout to run the held-back requests with', () => {
        expect(parseArguments([ '--held-back', 'b', '--serenity-js', '/s', ...out ], '/cwd').mode).toEqual({ mode: 'held-back', layout: 'b' });
        expect(() => parseArguments([ '--held-back', 'd', '--serenity-js', '/s', ...out ], '/cwd')).toThrow(/none, a, b or c/);
    });

    it('needs to be told where the results go, in every mode', () => {
        expect(() => parseArguments([ '--serenity-js', '/s' ], '/cwd')).toThrow(/^--out <dir> is required/);
        expect(() => parseArguments([ '--pilot', '--summarise' ], '/cwd')).toThrow(/^--out <dir> is required/);
    });

    it('needs the serenity-js clone, except to summarise the results', () => {
        expect(() => parseArguments([ ...out ], '/cwd')).toThrow(/--serenity-js/);
        expect(parseArguments([ '--summarise', ...out ], '/cwd').summariseOnly).toBe(true);
    });

    it('rescores without the serenity-js clone, as it summarises', () => {
        expect(parseArguments([ '--rescore', ...out ], '/cwd')).toMatchObject({ rescoreOnly: true, summariseOnly: false });
        expect(() => parseArguments([ '--rescore', '--summarise', ...out ], '/cwd')).toThrow(/usage/);
    });

    it('reparses without the serenity-js clone, for one agent or every agent, and on its own', () => {
        expect(parseArguments([ '--pilot', '--reparse', '--agent', 'kiro', ...out ], '/cwd')).toMatchObject({ reparseOnly: true, agent: 'kiro' });
        expect(() => parseArguments([ '--reparse', '--rescore', ...out ], '/cwd')).toThrow(/usage/);
    });

    it('takes the one agent to run, or runs every agent without it', () => {
        expect(parseArguments([ '--pilot', '--agent', 'kiro', '--serenity-js', '/s', ...out ], '/cwd').agent).toBe('kiro');
        expect(parseArguments([ '--rescore', '--agent', 'copilot', ...out ], '/cwd').agent).toBe('copilot');
        expect(parseArguments([ '--pilot', '--serenity-js', '/s', ...out ], '/cwd').agent).toBeUndefined();
        expect(() => parseArguments([ '--agent', 'claude', '--serenity-js', '/s', ...out ], '/cwd')).toThrow(/kiro or copilot/);
    });

    it('refuses arguments it does not know', () => {
        expect(() => parseArguments([ '--serenity-js', '/s', '--fast', ...out ], '/cwd')).toThrow(/usage/);
    });
});

describe('spawnWithTimeout', () => {

    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'skill-layouts-spawn-'));
    });
    afterEach(() => rmSync(directory, { recursive: true, force: true }));

    const isRunning = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    };

    const run = (script: string, timeoutMs: number) => spawnWithTimeout('sh', [ '-c', script ], {
        cwd: directory, env: process.env, stdout: join(directory, 'stdout'), stderr: join(directory, 'stderr'), timeoutMs,
    });

    it('reports an agent that finishes in time, with its exit code and output', async () => {
        const result = await run('echo started; exit 3', 10_000);

        expect(result).toMatchObject({ exitCode: 3, timedOut: false });
        expect(readFileSync(join(directory, 'stdout'), 'utf8')).toBe('started\n');
    });

    it("resolves only once the agent's output is in its files, however slowly they're written", async () => {
        const written: string[] = [];
        const slowly = () => new Writable({
            write(chunk: Buffer, _, done) {
                setTimeout(() => { written.push(chunk.toString()); done(); }, 200);
            },
        });

        const result = await spawnWithTimeout('sh', [ '-c', 'echo one; echo two >&2' ], {
            cwd: directory, env: process.env, stdout: join(directory, 'stdout'), stderr: join(directory, 'stderr'), timeoutMs: 10_000, openOutput: slowly,
        });

        expect(result.exitCode).toBe(0);
        expect(written.sort()).toEqual([ 'one\n', 'two\n' ]);
    });

    it('resolves after the deadline, with timedOut, though a process that left the group keeps the output open', async () => {
        // a detached sleep, in a process group of its own, inherits the output, and outlives its parent
        const script = [
            "const sleep = require('child_process').spawn('sleep', [ '60' ], { detached: true, stdio: [ 'ignore', 'inherit', 'inherit' ] })",
            "require('fs').writeFileSync('held.pid', String(sleep.pid))",
            'sleep.unref()',
            'setInterval(() => {}, 1000)',
        ].join('; ');
        const started = Date.now();
        try {
            const result = await spawnWithTimeout(process.execPath, [ '-e', script ], {
                cwd: directory, env: process.env, stdout: join(directory, 'stdout'), stderr: join(directory, 'stderr'), timeoutMs: 300, graceMs: 100,
            });

            expect(result.timedOut).toBe(true);
            expect(Date.now() - started).toBeLessThan(5_000);
        }
        finally {
            try {
                process.kill(Number(readFileSync(join(directory, 'held.pid'), 'utf8')), 'SIGKILL');
            }
            catch {
                // gone already
            }
        }
    });

    it('stops the agent, and every process it started, when it runs out of time, and says it timed out', async () => {
        const result = await run('sleep 60 & echo $! > child.pid; wait', 500);

        expect(result.timedOut).toBe(true);
        expect(existsSync(join(directory, 'child.pid'))).toBe(true);
        expect(isRunning(Number(readFileSync(join(directory, 'child.pid'), 'utf8')))).toBe(false);
    });
});

describe('agentEnvironment', () => {

    const env = {
        PATH: '/usr/bin:/bin', HOME: '/home/user', USER: 'user', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'UTF-8',
        TERM: 'xterm-256color', TMPDIR: '/var/folders/x/T/', SHELL: '/bin/zsh',
        KIRO_API_KEY: 'kiro-key', COPILOT_GITHUB_TOKEN: 'github_pat_1', GH_TOKEN: 'gho_1',
        AWS_SECRET_ACCESS_KEY: 'aws-secret', NPM_TOKEN: 'npm-token', CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
    };
    const homes = { KIRO_HOME: '/work/homes/x/kiro', COPILOT_HOME: '/work/homes/x/copilot', COPILOT_AUTO_UPDATE: 'false' as const };
    const basics = {
        PATH: '/usr/bin:/bin', HOME: '/home/user', USER: 'user', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'UTF-8',
        TERM: 'xterm-256color', TMPDIR: '/var/folders/x/T/', SHELL: '/bin/zsh',
    };

    const local = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    // where request 9's calculation jobs pick up their job files, and write their results, inside the run's directory
    const directory = '/work/runs/3f9c2a1e';
    const results = { JOBS_DIR: '/work/runs/3f9c2a1e/jobs', RESULTS_DIR: '/work/runs/3f9c2a1e/job-results' };

    it("gives a Kiro run the basics, its homes, Kiro's credential, and no proxy for the local API server, and nothing of Copilot's or anyone else's", () => {
        expect(agentEnvironment('kiro', homes, env, directory)).toEqual({ ...basics, ...homes, ...local, ...results, KIRO_API_KEY: 'kiro-key' });
    });

    it("gives a Copilot run the basics, its homes and one GitHub token, and nothing of Kiro's or anyone else's", () => {
        expect(agentEnvironment('copilot', homes, env, directory)).toEqual({ ...basics, ...homes, ...local, ...results, COPILOT_GITHUB_TOKEN: 'github_pat_1' });
        expect(agentEnvironment('copilot', homes, { ...env, COPILOT_GITHUB_TOKEN: undefined }, directory)).toEqual({ ...basics, ...homes, ...local, ...results, GH_TOKEN: 'gho_1' });
    });

    it("records the names of the variables a run's environment holds, without their values", () => {
        const names = environmentNames(agentEnvironment('kiro', homes, env, directory));

        expect(names).toEqual([ 'COPILOT_AUTO_UPDATE', 'COPILOT_HOME', 'HOME', 'JOBS_DIR', 'KIRO_API_KEY', 'KIRO_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_PROXY', 'PATH', 'RESULTS_DIR', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'no_proxy' ]);
        expect(names.join()).not.toContain('kiro-key');
    });

    it("gives the harness's tsc and npm test the basics and the run's JOBS_DIR and RESULTS_DIR, without any credentials", () => {
        expect(testEnvironment(env, directory)).toEqual({ ...basics, ...local, ...results });
    });

    it("leaves out what the user's environment doesn't have", () => {
        expect(agentEnvironment('kiro', homes, { PATH: '/bin', KIRO_API_KEY: 'k' }, directory)).toEqual({ PATH: '/bin', ...homes, ...local, ...results, KIRO_API_KEY: 'k' });
    });
});

describe('agentsToRun', () => {

    const pilot = runsFor({ mode: 'pilot', requests: [ '1', '4' ] }, { requests: [ '1-a', '4-b' ].map(id => ({ id, kind: '', prompt: '', needs: [], apis: [ 'mathjs' as const ] })), heldBack: [] });

    it("runs every agent of the mode's plan, without --agent", () => {
        expect(agentsToRun(pilot, undefined)).toEqual([ 'kiro', 'copilot' ]);
    });

    it('runs only the agent --agent names', () => {
        expect(agentsToRun(pilot, 'kiro')).toEqual([ 'kiro' ]);
    });
});

describe('preflightProblems', () => {

    const config = { models: { kiro: 'claude-sonnet-5.5', copilot: '' }, template: { commit: 'abc' }, apiServer: { port: 4170 }, runTimeoutMinutes: 1, testTimeoutMinutes: 1 };

    it("lets a Kiro-only pilot start without Copilot's pin, token or CLI, and checks only Kiro's", () => {
        expect(preflightProblems([ 'kiro' ], config, { KIRO_API_KEY: 'key' }, { home: '/nowhere', sandboxProblems: () => [] })).toEqual([]);
        expect(preflightProblems([ 'kiro' ], { ...config, models: { kiro: '', copilot: '' } }, {}, { home: '/nowhere', sandboxProblems: () => [] })).toEqual([
            'pin the model of kiro in skill-layouts/config.json before the runs',
            'Kiro needs KIRO_API_KEY: each run has its own KIRO_HOME, without your login',
        ]);
    });

    it("checks Copilot's pin and token when it runs", () => {
        expect(preflightProblems([ 'copilot' ], config, { KIRO_API_KEY: 'key' }, { home: '/nowhere', sandboxProblems: () => [] })).toEqual([
            'pin the model of copilot in skill-layouts/config.json before the runs',
            'Copilot needs COPILOT_GITHUB_TOKEN, or GH_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME, without your login',
        ]);
    });

    it("refuses to start where the harness's checks can't run sandboxed", () => {
        expect(preflightProblems([ 'kiro' ], config, { KIRO_API_KEY: 'key' }, { home: '/nowhere', sandboxProblems: () => [ "sandbox-exec can't start here" ] }))
            .toEqual([ "sandbox-exec can't start here" ]);
    });
});

describe('modelProblem', () => {

    it('accepts the model the stream reports when it is the pinned one', () => {
        expect(modelProblem('claude-opus-5.5', [ 'claude-opus-5.5' ])).toEqual({ stop: undefined, unreported: false });
    });

    it('stops the evaluation when the stream reports another model, and names both', () => {
        expect(modelProblem('claude-opus-5.5', [ 'claude-sonnet-5' ])).toEqual({
            stop: 'the run used claude-sonnet-5, but config.json pins claude-opus-5.5',
            unreported: false,
        });
    });

    it('stops the evaluation when the stream reports the pinned model and another, naming every model that differs', () => {
        expect(modelProblem('claude-opus-5.5', [ 'claude-opus-5.5', 'gpt-5.4', 'gpt-6' ])).toEqual({
            stop: 'the run used gpt-5.4, gpt-6, but config.json pins claude-opus-5.5',
            unreported: false,
        });
    });

    it("flags a stream that doesn't report a model, without stopping", () => {
        expect(modelProblem('claude-opus-5.5', [])).toEqual({ stop: undefined, unreported: true });
    });

    it('takes any models the stream reports when the pin is "auto", for the robustness check', () => {
        expect(modelProblem('auto', [ 'claude-sonnet-5.5' ])).toEqual({ stop: undefined, unreported: false });
        expect(modelProblem('auto', [ 'claude-sonnet-5.5', 'gpt-5.4' ])).toEqual({ stop: undefined, unreported: false });
        expect(modelProblem('auto', [])).toEqual({ stop: undefined, unreported: true });
    });
});

describe('sandboxed', () => {

    it("runs the harness's commands under sandbox-exec on macOS, with writes allowed only in the run's directory and TMPDIR", () => {
        expect(sandboxed('npm', [ 'test' ], { directory: '/work/runs/x', tmpdir: '/var/folders/x/T', platform: 'darwin' })).toEqual({
            command: '/usr/bin/sandbox-exec',
            args: [ '-p', sandboxProfile([ '/work/runs/x', '/var/folders/x/T' ]), 'npm', 'test' ],
        });
    });

    it('allows reads and the network, but writes only under the given directories, and to the null and terminal devices', () => {
        const profile = sandboxProfile([ '/work/runs/x', '/var/folders/x/T' ]);

        expect(profile).toContain('(allow default)');
        expect(profile).toContain('(deny file-write*)');
        expect(profile).toContain('(allow file-write* (subpath "/work/runs/x") (subpath "/var/folders/x/T") (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))');
    });

    it('refuses a directory whose name would break out of the profile', () => {
        expect(() => sandboxProfile([ '/work/runs/x") (subpath "/' ])).toThrow(/can't be put in a sandbox profile/);
    });

    it('runs the commands as they are elsewhere', () => {
        expect(sandboxed('npm', [ 'test' ], { directory: '/work/runs/x', tmpdir: '/tmp', platform: 'linux' })).toEqual({ command: 'npm', args: [ 'test' ] });
    });

    it("refuses to start the runs when sandbox-exec can't start, as inside another sandbox, rather than failing every run", () => {
        const refused = () => { throw new Error('sandbox-exec: sandbox_apply: Operation not permitted'); };

        expect(sandboxProblems('darwin', refused)).toEqual([
            "the harness runs tsc and npm test under sandbox-exec, which can't start here (sandbox-exec: sandbox_apply: Operation not permitted): run the evaluation from your own terminal, outside any sandbox",
        ]);
        expect(sandboxProblems('darwin', () => undefined)).toEqual([]);
        expect(sandboxProblems('linux', refused)).toEqual([]);
    });

    const canSandbox = process.platform === 'darwin' && (() => {
        try {
            execFileSync('/usr/bin/sandbox-exec', [ '-p', '(version 1)(allow default)', '/usr/bin/true' ], { stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    })();

    // sandbox-exec can't start inside another sandbox, such as the one a coding agent runs its commands in
    it.runIf(canSandbox)('lets a command write in its directory, but not in the home directory', () => {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'skill-layouts-sandbox-')));
        const outside = join(homedir(), `.skill-layouts-sandbox-check-${ process.pid }`);
        try {
            const { command, args } = sandboxed('/bin/sh', [ '-c', `echo inside > ${ directory }/inside; echo outside > ${ outside } || true` ], { directory, tmpdir: realpathSync(tmpdir()), platform: 'darwin' });
            execFileSync(command, args, { stdio: 'ignore' });

            expect(readFileSync(join(directory, 'inside'), 'utf8')).toBe('inside\n');
            expect(existsSync(outside)).toBe(false);
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
            rmSync(outside, { force: true });
        }
    });
});
