import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { freePort, serverRequestsOf, withApiServer } from '../src/api-server.ts';
import { parseArguments } from '../src/cli.ts';
import { unreachable } from '../src/outcome.ts';
import { loadRequests } from '../src/requests.ts';
import { runsFor } from '../src/runs.ts';
import { renderSmoke, SMOKE_REQUEST, smokeChecks, type SmokeInput, smokeProblem } from '../src/smoke.ts';

/** What a smoke run of Kiro leaves when the harness and the agent both did their part. */
function passing(overrides: Partial<SmokeInput> = {}): SmokeInput {
    return {
        agent: 'kiro',
        pin: 'claude-sonnet-5.5',
        error: undefined,
        record: {
            completedToolCalls: 5,
            skillReads: [
                { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' },
                { file: 'serenity-js-screenplay/references/tasks.md', via: 'read' },
            ],
            shellCommands: [ 'cat .mocharc.yml', 'curl "http://127.0.0.1:4567/v4/?expr=1%2B1"', 'npm test' ],
            models: [ 'claude-sonnet-5.5' ],
            modelAnswered: true,
            credits: 0.4,
            premiumRequests: undefined,
            checksSandboxed: true,
            agentEnvironment: [ 'HOME', 'KIRO_API_KEY', 'KIRO_HOME', 'COPILOT_HOME', 'COPILOT_AUTO_UPDATE', 'LANG', 'LC_ALL', 'JOBS_DIR', 'NO_PROXY', 'PATH', 'RESULTS_DIR', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'no_proxy' ],
            serverRequests: { agent: 1, checks: 4 },
        },
        logs: { tsc: true, test: true },
        resultSaved: true,
        packet: '# Run 3f9c2a1e\n\nLoad the [skill] skill. Then read [skill file] …',
        ...overrides,
    };
}

const failed = (input: SmokeInput) => smokeChecks(input).filter(check => ! check.ok);

describe('the smoke run', () => {

    it('is one run per agent being tested, in layout B, with a request of its own', () => {
        expect(runsFor({ mode: 'smoke' }, loadRequests())).toEqual([
            { agent: 'kiro', layout: 'b', request: 'smoke', repeat: 1 },
            { agent: 'copilot', layout: 'b', request: 'smoke', repeat: 1 },
        ]);
    });

    it("keeps its request out of requests.json, so the evaluation's conditions don't change", () => {
        const { requests, heldBack } = loadRequests();

        expect([ ...requests, ...heldBack ].map(request => request.id)).not.toContain('smoke');
        expect(SMOKE_REQUEST.prompt).toBe('Load the serenity-js-writing-tests skill. Then read .kiro/skills/serenity-js-screenplay/references/tasks.md with your file-reading tool, not a shell command, or .agents/skills/serenity-js-screenplay/references/tasks.md the same way, if that\'s where the skills are. Run `cat .mocharc.yml`. Run `curl` against the math.js API URL in the test script in package.json, to calculate 1 + 1. Then add a scenario to spec/math-js_api.spec.ts that checks that 1 + 1 equals 2, and run the tests.');
    });

    it('has a mode of its own, which honours --agent, and goes in <out>/smoke', () => {
        expect(parseArguments([ '--smoke', '--agent', 'kiro', '--serenity-js', '/s', '--out', '/out' ], '/cwd')).toMatchObject({ mode: { mode: 'smoke' }, agent: 'kiro' });
        expect(() => parseArguments([ '--smoke', '--pilot', '--serenity-js', '/s' ], '/cwd')).toThrow(/usage/);
    });
});

describe('smokeChecks', () => {

    it('passes every check of a run where the harness and the agent did their part', () => {
        expect(smokeChecks(passing()).map(check => [ check.name, check.ok ])).toEqual([
            [ 'the stream', true ],
            [ 'the skill load', true ],
            [ 'the file read', true ],
            [ 'the shell command', true ],
            [ 'the model', true ],
            [ 'the usage', true ],
            [ 'the sandboxed checks', true ],
            [ 'the results', true ],
            [ 'the environment', true ],
            [ 'the agent and the local server', true ],
            [ "the harness's npm test and the local server", true ],
        ]);
        expect(smokeProblem(smokeChecks(passing()))).toBeUndefined();
    });

    it("says the parser found no tool calls, a harness failure, when the stream has none that completed", () => {
        const record = { ...passing().record!, completedToolCalls: 0, skillReads: [], shellCommands: [] };

        expect(failed(passing({ record }))[0]).toEqual({ name: 'the stream', ok: false, cause: 'harness', detail: 'the parser found no tool calls' });
    });

    it("says the agent didn't load the skill, an agent failure, when the parser found tool calls but no skill load", () => {
        const record = { ...passing().record!, skillReads: [ { file: 'serenity-js-screenplay/references/tasks.md', via: 'read' as const } ] };

        expect(failed(passing({ record }))).toEqual([ { name: 'the skill load', ok: false, cause: 'agent', detail: "the agent didn't load the skill serenity-js-writing-tests" } ]);
    });

    it("says the agent didn't read the file, or run the command, when it didn't", () => {
        const record = { ...passing().record!, skillReads: [ { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' as const } ], shellCommands: [ 'curl "http://127.0.0.1:4567/v4/?expr=1%2B1"', 'npm test' ] };

        expect(failed(passing({ record })).map(check => [ check.cause, check.detail ])).toEqual([
            [ 'agent', "the agent didn't read serenity-js-screenplay/references/tasks.md" ],
            [ 'agent', "the agent didn't run cat .mocharc.yml" ],
        ]);
    });

    it("says the agent read the file with a shell command, when it did, so it's clear the harness saw the read", () => {
        const record = { ...passing().record!, skillReads: [
            { file: 'serenity-js-writing-tests/SKILL.md', via: 'skill-tool' as const },
            { file: 'serenity-js-screenplay/references/tasks.md', via: 'shell' as const },
        ] };

        expect(failed(passing({ record }))).toEqual([
            { name: 'the file read', ok: false, cause: 'agent', detail: 'the agent read serenity-js-screenplay/references/tasks.md with a shell command instead of the file-reading tool' },
        ]);
    });

    it("fails the harness when the parser couldn't read the stream, and checks nothing else", () => {
        const checks = smokeChecks(passing({ error: "the stream doesn't look like Kiro's ACP stream-json", record: undefined, resultSaved: false, packet: undefined }));

        expect(checks[0]).toEqual({ name: 'the stream', ok: false, cause: 'harness', detail: "scoring stopped: the stream doesn't look like Kiro's ACP stream-json" });
        expect(checks.slice(1).every(check => ! check.ok && check.detail === 'not checked, because scoring stopped')).toBe(true);
    });

    it('fails the model check, naming both, when the reported model differs from the pin', () => {
        const record = { ...passing().record!, models: [ 'claude-opus-5.5' ] };

        expect(failed(passing({ record }))).toEqual([ { name: 'the model', ok: false, cause: 'harness', detail: 'the stream reports claude-opus-5.5, but the pin is claude-sonnet-5.5' } ]);
    });

    it('fails the model check when the pin is a model and any of the reported ones differs', () => {
        const record = { ...passing().record!, models: [ 'claude-sonnet-5.5', 'gpt-5.4' ] };

        expect(failed(passing({ record }))[0].detail).toBe('the stream reports claude-sonnet-5.5, gpt-5.4, but the pin is claude-sonnet-5.5');
    });

    it('fails the model check when no model answered, however the pin is set, as with a session that refused to start', () => {
        const record = { ...passing().record!, models: [], modelAnswered: false };
        const detail = 'no model answered: the stream has no assistant.usage or assistant.message event';

        expect(failed(passing({ record }))).toEqual([ { name: 'the model', ok: false, cause: 'harness', detail } ]);
        expect(failed(passing({ pin: 'auto', record }))).toEqual([ { name: 'the model', ok: false, cause: 'harness', detail } ]);
    });

    it('passes the model check with a pin of "auto" when a model answered, whichever it was', () => {
        expect(failed(passing({ pin: 'auto', record: { ...passing().record!, models: [ 'gpt-5.4', 'claude-sonnet-5.5' ] } }))).toEqual([]);
        expect(failed(passing({ pin: 'auto', record: { ...passing().record!, models: [], modelAnswered: true } }))).toEqual([]);
    });

    it('fails the model check when the pin is a model and the answer names none', () => {
        const record = { ...passing().record!, models: [], modelAnswered: true };

        expect(failed(passing({ record }))[0].detail).toBe('the stream reports no model, but the pin is claude-sonnet-5.5');
    });

    it("needs credits for Kiro, and premium requests for Copilot", () => {
        expect(failed(passing({ record: { ...passing().record!, credits: undefined } }))[0].detail).toBe('no credits recorded');

        const copilot = passing({ agent: 'copilot', record: { ...passing().record!, credits: undefined, premiumRequests: 1, agentEnvironment: [ 'PATH', 'COPILOT_GITHUB_TOKEN', 'COPILOT_HOME' ] } });
        expect(failed(copilot)).toEqual([]);
        expect(failed({ ...copilot, record: { ...copilot.record!, premiumRequests: undefined } })[0].detail).toBe('no premium requests recorded');
    });

    it("fails when tsc and npm test didn't run under sandbox-exec, or left no logs", () => {
        expect(failed(passing({ record: { ...passing().record!, checksSandboxed: false } }))[0].detail).toBe("tsc and npm test didn't run under sandbox-exec");
        expect(failed(passing({ logs: { tsc: true, test: false } }))[0].detail).toBe('no test.log');
    });

    it('fails when result.json or the review packet is missing, or the packet gives a skill away', () => {
        expect(failed(passing({ resultSaved: false }))[0].detail).toBe('no result.json');
        expect(failed(passing({ packet: undefined }))[0].detail).toBe('no review packet');
        expect(failed(passing({ packet: 'read .kiro/skills/serenity-js-screenplay/references/tasks.md' }))[0].detail).toBe('the review packet names a skill or a skill path');
    });

    it("fails when the agent's environment held another agent's credential, or anything else", () => {
        const env = (names: string[]) => passing({ record: { ...passing().record!, agentEnvironment: names } });

        expect(failed(env([ 'PATH', 'KIRO_API_KEY', 'GH_TOKEN' ]))[0].detail).toBe('the agent got GH_TOKEN, which it shouldn\'t');
        expect(failed(env([ 'PATH', 'KIRO_API_KEY', 'AWS_SECRET_ACCESS_KEY' ]))[0].detail).toBe('the agent got AWS_SECRET_ACCESS_KEY, which it shouldn\'t');
        expect(failed(env([ 'PATH' ]))[0].detail).toBe('the agent got none of its credentials: KIRO_API_KEY');
    });
});

describe('the smoke checks of the local API server', () => {

    it("says the agent didn't reach the local server, its own failure, when it didn't run curl", () => {
        const record = { ...passing().record!, shellCommands: [ 'cat .mocharc.yml', 'npm test' ], serverRequests: { agent: 0, checks: 4 } };

        expect(failed(passing({ record }))).toEqual([ { name: 'the agent and the local server', ok: false, cause: 'agent', detail: "the agent didn't run curl against the local server" } ]);
    });

    it("fails the harness when the agent ran curl, but the local server logged none of its requests", () => {
        const record = { ...passing().record!, serverRequests: { agent: 0, checks: 4 } };

        expect(failed(passing({ record }))).toEqual([ { name: 'the agent and the local server', ok: false, cause: 'harness', detail: 'the agent ran curl, but the local server logged no request from it: is it reachable from the sandbox?' } ]);
    });

    it("fails the harness when its npm test didn't use the local server", () => {
        const record = { ...passing().record!, serverRequests: { agent: 1, checks: 0 } };

        expect(failed(passing({ record }))).toEqual([ { name: "the harness's npm test and the local server", ok: false, cause: 'harness', detail: "the local server logged no request from the harness's tsc and npm test" } ]);
    });

    it("fails the harness when a sandbox blocks loopback for npm test, although the harness's probe reached the server", async () => {
        const directory = mkdtempSync(join(tmpdir(), 'skill-layouts-smoke-server-'));
        try {
            const serverRequests = await withApiServer(join(directory, 'server.jsonl'), await freePort(), async server => {
                // the agent's curl
                await new Promise(resolve => get(`${ server.urls.mathjs }?expr=1%2B1`, { agent: new Agent() }, response => response.resume().on('end', resolve)));
                const agentFinished = server.requests().length;
                // npm test was blocked, so it failed, and the harness probed the server
                expect(await unreachable([ `${ server.urls.mathjs }?expr=1` ])).toEqual([]);
                return serverRequestsOf(server.requests(), agentFinished);
            });

            expect(failed(passing({ record: { ...passing().record!, serverRequests } })).map(check => check.name)).toEqual([ "the harness's npm test and the local server" ]);
        }
        finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe('renderSmoke', () => {

    it('prints one line per check, ok or failed', () => {
        const lines = renderSmoke('kiro', smokeChecks(passing({ record: { ...passing().record!, shellCommands: [] } }))).split('\n');

        expect(lines[0]).toBe('kiro: ok      the stream');
        expect(lines[3]).toBe("kiro: failed  the shell command: the agent didn't run cat .mocharc.yml");
    });

    it('names the failed checks, keeping what the agent did apart from what the harness did', () => {
        const record = { ...passing().record!, skillReads: [], completedToolCalls: 3, credits: undefined };

        expect(smokeProblem(smokeChecks(passing({ record })))).toBe(
            "the smoke run failed: the harness: the usage (no credits recorded); the agent didn't follow the prompt: the skill load (the agent didn't load the skill serenity-js-writing-tests), the file read (the agent didn't read serenity-js-screenplay/references/tasks.md)",
        );
    });
});
