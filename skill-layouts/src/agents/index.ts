// The agents the evaluation runs, in the order compare.md shows their runs. A third agent is a module of its own, like
// kiro.ts, and two lines here: its id in AGENTS, and its adapter in ADAPTERS.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { run, type RunOptions } from '../child-processes.ts';
import type { AgentAdapter } from './agent.ts';
import { copilot } from './copilot.ts';
import { kiro } from './kiro.ts';

export type { AgentAdapter } from './agent.ts';

export const AGENTS = [ 'kiro', 'copilot' ] as const;
export type Agent = typeof AGENTS[number];

export const ADAPTERS: { readonly [A in Agent]: AgentAdapter<A> } = { kiro, copilot };

export function adapterOf<A extends Agent>(agent: A): AgentAdapter<A> {
    return ADAPTERS[agent];
}

/** What the agent's --version prints, trimmed, or `not installed` when it can't start or fails. */
export function versionOf(adapter: Pick<AgentAdapter, 'executable'>, runCommand: (command: string, args: string[], options?: RunOptions) => string = run): string {
    try {
        return runCommand(adapter.executable, [ '--version' ], { stdio: [ 'ignore', 'pipe', 'ignore' ] }).trim();
    }
    catch {
        return 'not installed';
    }
}

/**
 * A run's homes: its HOME, instead of the user's, npm's cache, which every run shares, and each agent's home, keyed by
 * its home variable, such as KIRO_HOME, with the agent's constant variables, such as COPILOT_AUTO_UPDATE.
 */
export type AgentHomes = { HOME: string, npm_config_cache: string } & Record<string, string>;

/**
 * Empty homes for a run, in `directory`, and npm's cache in `npmCache`, which is kept, since every run shares it. Every
 * run gets every agent's home, in `<directory>/<agent>`, whichever agent it runs, with that agent's settings in it.
 * Each run's Kiro unpacks its runtime into its HOME's Library/Application Support/kiro-cli, and Copilot its package
 * into Library/Caches/copilot.
 */
export function prepareAgentHomes(directory: string, npmCache: string): AgentHomes {
    rmSync(directory, { recursive: true, force: true });
    const homes: AgentHomes = { HOME: join(directory, 'home'), npm_config_cache: npmCache };
    mkdirSync(homes.HOME, { recursive: true });
    mkdirSync(homes.npm_config_cache, { recursive: true });
    for (const agent of AGENTS) {
        const adapter = adapterOf(agent);
        const home = join(directory, adapter.id);
        mkdirSync(home, { recursive: true });
        adapter.prepareHome(home);
        Object.assign(homes, { [adapter.homeVariable]: home }, adapter.environment);
    }
    return homes;
}

/** The variables prepareAgentHomes sets, but HOME, which is one of the basics every environment has. */
export function homeVariables(): string[] {
    return [ ...AGENTS.flatMap(agent => [ adapterOf(agent).homeVariable, ...Object.keys(adapterOf(agent).environment) ]), 'npm_config_cache' ];
}

/** What's missing for the given agents to authenticate with empty homes, in the order of AGENTS. */
export function credentialProblems(agents: readonly Agent[], env: NodeJS.ProcessEnv): string[] {
    return AGENTS.filter(agent => agents.includes(agent)).flatMap(agent => adapterOf(agent).credentialProblem(env) ?? []);
}

/** Anything else of the user's that would reach the given agents' runs, such as Copilot's personal skills. */
export function otherProblems(agents: readonly Agent[], userHome: string): string[] {
    return AGENTS.filter(agent => agents.includes(agent)).flatMap(agent => adapterOf(agent).otherProblems(userHome));
}
