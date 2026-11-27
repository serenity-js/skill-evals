import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments, versionOf } from '../src/cli.ts';
import { LAYOUTS } from '../src/layouts.ts';
import { RUNS_PER_LAYOUT_FOR_A_DECISION } from '../src/summary.ts';
import { spawnWithTimeout } from '../src/child-processes.ts';
import { agentCommand, agentEnvironment, agentsToRun, environmentNames, loadConfig, modelProblem, preflightProblems, resultOf, runsFor, testEnvironment } from '../src/runs.ts';
import { checksSandbox, checksSandboxFor, SANDBOX_EXEC, sandboxed, sandboxPathsOf, sandboxProblems, sandboxProfile } from '../src/sandbox.ts';

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
            unsandboxed: false,
        });
    });

    it("takes --unsandboxed, for the checks where sandbox-exec isn't available, also with --check-references or --rescore", () => {
        expect(parseArguments([ '--pilot', '--unsandboxed', '--serenity-js', '/s', ...out ], '/cwd').unsandboxed).toBe(true);
        expect(parseArguments([ '--check-references', '--unsandboxed', '--serenity-js', '/s', ...out ], '/cwd')).toMatchObject({ checkReferencesOnly: true, unsandboxed: true });
        expect(parseArguments([ '--rescore', '--unsandboxed', ...out ], '/cwd')).toMatchObject({ rescoreOnly: true, unsandboxed: true });
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
    const homes = {
        HOME: '/work/homes/x/home', KIRO_HOME: '/work/homes/x/kiro', COPILOT_HOME: '/work/homes/x/copilot', COPILOT_AUTO_UPDATE: 'false' as const,
        npm_config_cache: '/work/npm-cache',
    };
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

    it("gives a Copilot run the basics, its homes and COPILOT_GITHUB_TOKEN, and nothing of Kiro's or anyone else's", () => {
        expect(agentEnvironment('copilot', homes, env, directory)).toEqual({ ...basics, ...homes, ...local, ...results, COPILOT_GITHUB_TOKEN: 'github_pat_1' });
    });

    it("gives neither agent a HOME outside <work>, or GH_TOKEN, even when COPILOT_GITHUB_TOKEN isn't set", () => {
        for (const agent of [ 'kiro', 'copilot' ] as const) {
            for (const user of [ env, { ...env, COPILOT_GITHUB_TOKEN: undefined } ]) {
                const run = agentEnvironment(agent, homes, user, directory);

                expect(run.HOME).toBe('/work/homes/x/home');
                expect(run.npm_config_cache).toBe('/work/npm-cache');
                expect(Object.keys(run)).not.toContain('GH_TOKEN');
                expect(Object.values(run).filter(value => value.startsWith('/home/user'))).toEqual([]);
            }
        }
        expect(Object.keys(agentEnvironment('copilot', homes, { ...env, COPILOT_GITHUB_TOKEN: undefined }, directory))).not.toContain('COPILOT_GITHUB_TOKEN');
    });

    it("records the names of the variables a run's environment holds, without their values", () => {
        const names = environmentNames(agentEnvironment('kiro', homes, env, directory));

        expect(names).toEqual([ 'COPILOT_AUTO_UPDATE', 'COPILOT_HOME', 'HOME', 'JOBS_DIR', 'KIRO_API_KEY', 'KIRO_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_PROXY', 'PATH', 'RESULTS_DIR', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'no_proxy', 'npm_config_cache' ]);
        expect(names.join()).not.toContain('kiro-key');
    });

    it("gives the harness's tsc and npm test the basics and the run's JOBS_DIR and RESULTS_DIR, without any credentials", () => {
        expect(testEnvironment(env, directory)).toEqual({ ...basics, ...local, ...results });
    });

    it("leaves out what the user's environment doesn't have", () => {
        expect(agentEnvironment('kiro', homes, { PATH: '/bin', KIRO_API_KEY: 'k' }, directory)).toEqual({ PATH: '/bin', ...homes, ...local, ...results, KIRO_API_KEY: 'k' });
    });
});

describe('versionOf', () => {

    let bin: string;

    beforeEach(() => {
        bin = mkdtempSync(join(tmpdir(), 'skill-layouts-version-'));
    });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));

    it("records what the agent's --version prints, trimmed, and nothing it prints on standard error", () => {
        writeFileSync(join(bin, 'agent'), '#!/bin/sh\n[ "$1" = --version ] && echo "  kiro-cli 3.5.0" && echo "a warning" >&2\n', { mode: 0o755 });

        expect(versionOf(join(bin, 'agent'))).toBe('kiro-cli 3.5.0');
    });

    it("keeps every line of a version that's more than one, as Copilot's is", () => {
        writeFileSync(join(bin, 'agent'), "#!/bin/sh\nprintf 'GitHub Copilot CLI 1.0.114.\\nRun copilot update to check for updates.\\n'\n", { mode: 0o755 });

        expect(versionOf(join(bin, 'agent'))).toBe('GitHub Copilot CLI 1.0.114.\nRun copilot update to check for updates.');
    });

    it("says 'not installed' when the agent can't start, or --version fails", () => {
        writeFileSync(join(bin, 'failing'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

        expect(versionOf(join(bin, 'no-such-agent'))).toBe('not installed');
        expect(versionOf(join(bin, 'failing'))).toBe('not installed');
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
            'Copilot needs COPILOT_GITHUB_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME and HOME, without your login, and gets no GH_TOKEN',
        ]);
    });

    it("lists the pins in the order of the agents it's given, then Kiro's credential before Copilot's, then Copilot's personal skills, then the sandbox", () => {
        const home = mkdtempSync(join(tmpdir(), 'skill-layouts-preflight-'));
        try {
            mkdirSync(join(home, '.agents', 'skills'), { recursive: true });

            expect(preflightProblems([ 'copilot', 'kiro' ], { ...config, models: { kiro: '', copilot: '' } }, {}, { home, sandboxProblems: () => [ "sandbox-exec can't start here" ] })).toEqual([
                'pin the model of copilot and kiro in skill-layouts/config.json before the runs',
                'Kiro needs KIRO_API_KEY: each run has its own KIRO_HOME, without your login',
                'Copilot needs COPILOT_GITHUB_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME and HOME, without your login, and gets no GH_TOKEN',
                `Copilot reads personal skills from ${ join(home, '.agents', 'skills') }, which COPILOT_HOME doesn't cover: move it aside for the evaluation`,
                "sandbox-exec can't start here",
            ]);
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
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

    const paths = { writable: [ '/work/runs/x', '/var/folders/x/T' ], readable: [ '/Users/me/.npm', '/Users/me/.nvm/versions/node/v24.15.0' ], home: '/Users/me' };

    it("runs the harness's commands under sandbox-exec, with the profile of the run's paths", () => {
        expect(sandboxed('npm', [ 'test' ], paths)).toEqual({
            command: '/usr/bin/sandbox-exec',
            args: [ '-p', sandboxProfile(paths), 'npm', 'test' ],
        });
    });

    it("writes only in the run's directory and TMPDIR, reads nothing in HOME outside them, npm's cache and Node.js, and reaches only localhost", () => {
        expect(sandboxProfile(paths)).toBe([
            '(version 1)',
            '(allow default)',
            '(deny file-write*)',
            '(allow file-write* (subpath "/work/runs/x") (subpath "/var/folders/x/T") (literal "/dev/null") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
            '(deny file-read* (subpath "/Users/me"))',
            '(allow file-read-metadata (subpath "/Users/me"))',
            '(allow file-read* (subpath "/work/runs/x") (subpath "/var/folders/x/T") (subpath "/Users/me/.npm") (subpath "/Users/me/.nvm/versions/node/v24.15.0"))',
            '(deny network*)',
            '(allow network-outbound (remote ip "localhost:*"))',
            '(allow network-bind network-inbound (local ip "localhost:*"))',
            '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
        ].join('\n'));
    });

    it('refuses a path whose name would break out of the profile', () => {
        expect(() => sandboxProfile({ ...paths, writable: [ '/work/runs/x") (subpath "/' ] })).toThrow(/can't be put in a sandbox profile/);
        expect(() => sandboxProfile({ ...paths, readable: [ '/Users/me/.npm")' ] })).toThrow(/can't be put in a sandbox profile/);
        expect(() => sandboxProfile({ ...paths, home: '/Users/"me' })).toThrow(/can't be put in a sandbox profile/);
    });

    it("lets the checks read npm's cache and wherever Node.js is installed, which may be in HOME, as with nvm", () => {
        const nvm = '/Users/me/.nvm/versions/node/v24.15.0/bin/node';

        expect(sandboxPathsOf({ HOME: '/Users/me', TMPDIR: '/var/folders/x/T/' }, '/work/runs/x', nvm)).toEqual(paths);
        expect(sandboxPathsOf({ HOME: '/Users/me', TMPDIR: '/var/folders/x/T/', npm_config_cache: '/work/npm-cache' }, '/work/runs/x', nvm).readable)
            .toEqual([ '/work/npm-cache', '/Users/me/.nvm/versions/node/v24.15.0' ]);
    });

    it("lets the checks read the npm cache they use, ~/.npm, since they don't get the agents' shared cache in <work>", () => {
        const harness = { HOME: '/Users/me', TMPDIR: '/var/folders/x/T/', npm_config_cache: '/work/npm-cache' };
        const checks = testEnvironment(harness, '/work/runs/x');

        expect(checks.npm_config_cache).toBeUndefined();
        expect(checks.HOME).toBe('/Users/me');
        expect(sandboxPathsOf(checks, '/work/runs/x', '/Users/me/.nvm/versions/node/v24.15.0/bin/node').readable)
            .toEqual([ '/Users/me/.npm', '/Users/me/.nvm/versions/node/v24.15.0' ]);
    });

    describe('checksSandboxFor', () => {

        it("is sandbox-exec, which wraps the command with the profile of the run's paths", () => {
            expect(checksSandboxFor('darwin').wrap('npm', [ 'test' ], paths)).toEqual({ command: SANDBOX_EXEC, args: [ '-p', sandboxProfile(paths), 'npm', 'test' ] });
            expect(checksSandboxFor('darwin', { executable: '/tmp/sandbox-exec' }).wrap('npm', [ 'test' ], paths).command).toBe('/tmp/sandbox-exec');
        });

        it('is sandbox-exec on every platform so far, which says where it is not there', () => {
            expect(checksSandboxFor('linux', { start: () => undefined }).problems()).toEqual(sandboxProblems('linux'));
            expect(checksSandboxFor('darwin', { start: () => undefined }).problems()).toEqual([]);
        });

        it("tells sandbox-exec's refusal, an exit with 71 and its reason on standard error, from a command that failed", () => {
            const { refusalOf } = checksSandboxFor('darwin');

            expect(refusalOf(71, 'sandbox-exec: sandbox_apply: Operation not permitted\n')).toBe('sandbox-exec: sandbox_apply: Operation not permitted');
            expect(refusalOf(71, 'npm ERR! something else\n')).toBeUndefined();
            expect(refusalOf(1, 'sandbox-exec: sandbox_apply: Operation not permitted\n')).toBeUndefined();
            expect(refusalOf(null, '')).toBeUndefined();
        });
    });

    it("refuses to start the runs when sandbox-exec can't start, as inside another sandbox, unless it's given --unsandboxed", () => {
        const refused = () => { throw new Error('sandbox-exec: sandbox_apply: Operation not permitted'); };

        expect(sandboxProblems('darwin', refused)).toEqual([
            "the harness runs tsc and npm test under sandbox-exec, which can't start here (sandbox-exec: sandbox_apply: Operation not permitted): run the evaluation from your own terminal, outside any sandbox, or pass --unsandboxed to run them without one",
        ]);
        expect(sandboxProblems('darwin', () => undefined)).toEqual([]);
    });

    it("refuses to run the checks where there's no sandbox-exec, unless it's given --unsandboxed", () => {
        expect(sandboxProblems('linux', () => undefined)).toEqual([
            'the harness runs tsc and npm test under sandbox-exec, which linux doesn\'t have: pass --unsandboxed to run them without a sandbox',
        ]);
    });

    it('runs the checks without a sandbox, given --unsandboxed, only where sandbox-exec is not available', () => {
        const refused = () => { throw new Error('sandbox-exec: sandbox_apply: Operation not permitted'); };

        expect(checksSandbox('linux', { unsandboxed: true })).toEqual({ problems: [], checks: { unsandboxed: true } });
        expect(checksSandbox('darwin', { unsandboxed: true, start: refused })).toEqual({ problems: [], checks: { unsandboxed: true } });
        expect(checksSandbox('darwin', { unsandboxed: true, start: () => undefined })).toEqual({ problems: [], checks: { unsandboxed: false } });
        expect(checksSandbox('linux', { unsandboxed: false })).toEqual({ problems: sandboxProblems('linux'), checks: { unsandboxed: false } });
    });

    const canSandbox = process.platform === 'darwin' && (() => {
        try {
            execFileSync(SANDBOX_EXEC, [ '-p', '(version 1)(allow default)', '/usr/bin/true' ], { stdio: 'ignore' });
            return true;
        }
        catch {
            return false;
        }
    })();

    // sandbox-exec can't start inside another sandbox, such as the one a coding agent runs its commands in
    describe.runIf(canSandbox)('under sandbox-exec', () => {

        let directory: string;
        const outside = join(homedir(), `.skill-layouts-sandbox-check-${ process.pid }`);

        beforeEach(() => {
            directory = realpathSync(mkdtempSync(join(tmpdir(), 'skill-layouts-sandbox-')));
            writeFileSync(join(directory, 'inside'), 'inside\n');
        });
        afterEach(() => {
            rmSync(directory, { recursive: true, force: true });
            rmSync(outside, { force: true });
        });

        const check = (command: string, args: string[]) => resultOf(command, args, directory, join(directory, 'check.log'), 1);

        it('lets a command write in its directory, but not in the home directory', () => {
            const { command, args } = sandboxed('/bin/sh', [ '-c', `echo inside > ${ directory }/written; echo outside > ${ outside } || true` ], sandboxPathsOf(process.env, directory));
            execFileSync(command, args, { stdio: 'ignore' });

            expect(readFileSync(join(directory, 'written'), 'utf8')).toBe('inside\n');
            expect(existsSync(outside)).toBe(false);
        });

        it('fails a check that reads a file in HOME outside the run, and lets it read the run\'s own files', () => {
            writeFileSync(outside, 'secret\n');

            const read = check('/bin/cat', [ outside ]);
            expect(read).toMatchObject({ sandboxed: true });
            expect(read.exitCode).not.toBe(0);
            expect(read.log).toMatch(/Operation not permitted/);
            expect(check('/bin/cat', [ join(directory, 'inside') ])).toMatchObject({ exitCode: 0, log: 'inside\n' });
        });

        it('fails a check that reaches a host other than localhost, and lets it reach a server on localhost and 127.0.0.1', () => {
            const script = [
                "const server = require('node:http').createServer((request, response) => response.end('ok'));",
                "server.listen(0, '127.0.0.1', async () => {",
                '    const { port } = server.address();',
                '    const reached = url => fetch(url).then(response => response.text(), () => undefined);',
                "    const local = [ await reached(`http://127.0.0.1:${ port }/`), await reached(`http://localhost:${ port }/`) ];",
                "    const remote = await reached('https://example.com/');",
                "    console.log(JSON.stringify({ local, remote: remote !== undefined }));",
                '    server.close();',
                '});',
            ].join('\n');

            const result = check(process.execPath, [ '-e', script ]);

            expect(result.exitCode).toBe(0);
            expect(JSON.parse(result.log)).toEqual({ local: [ 'ok', 'ok' ], remote: false });
        });

        it('starts npm, with HOME unreadable', () => {
            expect(check('npm', [ '--version' ])).toMatchObject({ exitCode: 0, sandboxed: true });
        });
    });
});
