import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ADAPTERS, adapterOf, AGENTS, credentialProblems, homeVariables, otherProblems, prepareAgentHomes, versionOf } from '../src/agents/index.ts';
import { parseCopilotStream, parseKiroStream } from '../src/streams.ts';

describe('the agents', () => {

    it('are Kiro and Copilot, in the order compare.md shows their runs, each with an adapter of its own', () => {
        expect(AGENTS).toEqual([ 'kiro', 'copilot' ]);
        expect(Object.keys(ADAPTERS)).toEqual([ ...AGENTS ]);
        for (const agent of AGENTS) {
            expect(adapterOf(agent).id).toBe(agent);
        }
    });

    it('run as kiro-cli and copilot, which is what --version is asked of', () => {
        expect(AGENTS.map(agent => adapterOf(agent).executable)).toEqual([ 'kiro-cli', 'copilot' ]);
        expect(AGENTS.map(agent => adapterOf(agent).command('m', 'p').command)).toEqual([ 'kiro-cli', 'copilot' ]);
    });

    it("asks the agent's executable for its version, without what it prints on standard error", () => {
        const calls: unknown[] = [];

        expect(versionOf(adapterOf('copilot'), (command, args, options) => {
            calls.push({ command, args, options });
            return ' GitHub Copilot CLI 1.0.114.\n';
        })).toBe('GitHub Copilot CLI 1.0.114.');
        expect(calls).toEqual([ { command: 'copilot', args: [ '--version' ], options: { stdio: [ 'ignore', 'pipe', 'ignore' ] } } ]);
    });

    describe("a run's homes", () => {

        let directory: string;

        beforeEach(() => {
            directory = mkdtempSync(join(tmpdir(), 'skill-layouts-agents-'));
        });
        afterEach(() => rmSync(directory, { recursive: true, force: true }));

        it("have every agent's home, keyed by its home variable, with its constant variables, whichever agent the run is of", () => {
            const homes = prepareAgentHomes(join(directory, '3f9c2a1e'), join(directory, 'npm-cache'));

            expect(homes).toEqual({
                HOME: join(directory, '3f9c2a1e', 'home'),
                npm_config_cache: join(directory, 'npm-cache'),
                ...Object.fromEntries(AGENTS.flatMap(agent => [
                    [ adapterOf(agent).homeVariable, join(directory, '3f9c2a1e', agent) ],
                    ...Object.entries(adapterOf(agent).environment),
                ])),
            });
            expect(readdirSync(join(directory, '3f9c2a1e')).sort()).toEqual([ 'copilot', 'home', 'kiro' ]);
        });

        it('are named, for the smoke run, by every variable they set, but HOME', () => {
            expect(homeVariables()).toEqual([ 'KIRO_HOME', 'COPILOT_HOME', 'COPILOT_AUTO_UPDATE', 'npm_config_cache' ]);
        });
    });

    describe('credentials', () => {

        const env = { KIRO_API_KEY: 'kiro-key', COPILOT_GITHUB_TOKEN: 'github_pat_1', GH_TOKEN: 'gho_1' };

        it("give each agent its own credential only", () => {
            expect(adapterOf('kiro').credentialOf(env)).toEqual({ KIRO_API_KEY: 'kiro-key' });
            expect(adapterOf('copilot').credentialOf(env)).toEqual({ COPILOT_GITHUB_TOKEN: 'github_pat_1' });
            expect(adapterOf('copilot').credentialOf({ GH_TOKEN: 'gho_1' })).toEqual({});
            expect(AGENTS.map(agent => adapterOf(agent).credentials)).toEqual([ [ 'KIRO_API_KEY' ], [ 'COPILOT_GITHUB_TOKEN' ] ]);
        });

        it("say what's missing for the agents about to run, in the order of the agents, whatever order they're given in", () => {
            expect(credentialProblems([ 'copilot', 'kiro' ], {})).toEqual([ adapterOf('kiro').credentialProblem({}), adapterOf('copilot').credentialProblem({}) ]);
            expect(credentialProblems([ 'copilot' ], { COPILOT_GITHUB_TOKEN: 'github_pat_1' })).toEqual([]);
        });
    });

    it("say what else of the user's would reach their runs: Copilot's personal skills only", () => {
        const home = mkdtempSync(join(tmpdir(), 'skill-layouts-agents-home-'));
        try {
            mkdirSync(join(home, '.agents', 'skills'), { recursive: true });

            expect(adapterOf('kiro').otherProblems(home)).toEqual([]);
            expect(otherProblems([ 'kiro' ], home)).toEqual([]);
            expect(otherProblems([ 'kiro', 'copilot' ], home)).toEqual(adapterOf('copilot').otherProblems(home));
            expect(otherProblems([ 'copilot' ], home)).toHaveLength(1);
        }
        finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("parse their own streams: Copilot's knowing whether the run timed out, Kiro's without", () => {
        const kiroStream = readFileSync(join(import.meta.dirname, 'fixtures', 'kiro-v3.smoke-974a67ed.jsonl'), 'utf8');
        const copilotStream = readFileSync(join(import.meta.dirname, 'fixtures', 'copilot-cli.smoke-e3c01675.jsonl'), 'utf8');

        expect(adapterOf('kiro').parseStream(kiroStream, { timedOut: true })).toEqual(parseKiroStream(kiroStream));
        expect(adapterOf('copilot').parseStream(copilotStream, { timedOut: true })).toEqual(parseCopilotStream(copilotStream, { timedOut: true }));
    });

    it("check the usage each reports in the smoke run: Kiro's credits, Copilot's premium requests", () => {
        expect(adapterOf('kiro').usageProblem({ premiumRequests: 1 })).toBe('no credits recorded');
        expect(adapterOf('kiro').usageProblem({ credits: 0.4 })).toBeUndefined();
        expect(adapterOf('copilot').usageProblem({ credits: 0.4 })).toBe('no premium requests recorded');
        expect(adapterOf('copilot').usageProblem({ premiumRequests: 1 })).toBeUndefined();
    });

    it("say how npx skills links their skills: Kiro's into .kiro/skills, once there's a .kiro, Copilot's into .agents/skills", () => {
        expect(AGENTS.map(agent => adapterOf(agent).skills)).toEqual([
            { cliAgent: 'kiro-cli', directory: '.kiro/skills', needs: '.kiro' },
            { cliAgent: 'github-copilot', directory: '.agents/skills' },
        ]);
    });
});
