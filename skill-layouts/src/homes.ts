// Each run gets a Kiro home and a Copilot home of its own, created empty, so the user's configuration, agents, MCP
// servers, steering and skills don't reach the runs. Without the user's login, the agents authenticate from the
// environment: KIRO_API_KEY for Kiro, and COPILOT_GITHUB_TOKEN, or GH_TOKEN, for Copilot. Copilot also reads personal
// skills from ~/.agents/skills, which COPILOT_HOME doesn't cover, so the runs don't start while it exists.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Agent } from './review.ts';

/**
 * The hosts the agents' sandboxes let shell commands reach: the local API server, which stands in for the template's
 * math.js API and the exchange rates API request 4 asks for. The public APIs themselves aren't reachable.
 */
export const ALLOWED_HOSTS = [ '127.0.0.1', 'localhost' ];

/**
 * What Copilot's sandbox lets shell commands reach. Once its allowlist has an entry, every other host is blocked, so
 * it lists the npm registry too, which Kiro's COMMON_DEPENDENCIES mode reaches, along with other package services.
 */
export const COPILOT_ALLOWED_HOSTS = [ ...ALLOWED_HOSTS, 'registry.npmjs.org' ];

export interface AgentHomes {
    KIRO_HOME: string;
    COPILOT_HOME: string;
    /** Keeps Copilot from updating itself, or running a newer cached version, in the middle of an evaluation */
    COPILOT_AUTO_UPDATE: 'false';
}

/** Empty homes for a run, in `directory`, with each agent's sandbox on and the scenarios' APIs reachable from it. */
export function prepareAgentHomes(directory: string): AgentHomes {
    rmSync(directory, { recursive: true, force: true });
    const homes: AgentHomes = { KIRO_HOME: join(directory, 'kiro'), COPILOT_HOME: join(directory, 'copilot'), COPILOT_AUTO_UPDATE: 'false' };
    mkdirSync(join(homes.KIRO_HOME, 'settings'), { recursive: true });
    mkdirSync(homes.COPILOT_HOME, { recursive: true });

    // Kiro: the common package registries, for npm install, and sandbox_network rules for the local API server
    writeFileSync(join(homes.KIRO_HOME, 'settings', 'sandbox.json'), `${ JSON.stringify({ enabled: true, networkAccess: 'COMMON_DEPENDENCIES' }, null, 2) }\n`);
    writeFileSync(join(homes.KIRO_HOME, 'settings', 'permissions.yaml'), [
        'rules:',
        '  - capability: sandbox_network',
        `    match: [${ ALLOWED_HOSTS.map(host => `'${ host }'`).join(', ') }]`,
        '    effect: allow',
        '',
    ].join('\n'));

    // Copilot: the sandbox on, with no way out of it, no git or gh credentials in it, and an allowlist of hosts
    writeFileSync(join(homes.COPILOT_HOME, 'settings.json'), `${ JSON.stringify({
        sandbox: {
            enabled: true,
            allowBypass: false,
            auth: { git: false, gh: false },
            // the local network for the local API server, which listens on 127.0.0.1
            userPolicy: { network: { allowOutbound: true, allowLocalNetwork: true, allowedHosts: COPILOT_ALLOWED_HOSTS } },
        },
    }, null, 2) }\n`);
    return homes;
}

/** What's missing for the agents to authenticate with empty homes. */
export function credentialProblems(agents: Agent[], env: NodeJS.ProcessEnv): string[] {
    return [
        ...(agents.includes('kiro') && ! env.KIRO_API_KEY
            ? [ 'Kiro needs KIRO_API_KEY: each run has its own KIRO_HOME, without your login' ] : []),
        ...(agents.includes('copilot') && ! env.COPILOT_GITHUB_TOKEN && ! env.GH_TOKEN
            ? [ 'Copilot needs COPILOT_GITHUB_TOKEN, or GH_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME, without your login' ] : []),
    ];
}

/** Skills of the user's that would reach Copilot's runs, whatever COPILOT_HOME says. */
export function personalSkillsProblems(agents: Agent[], home: string): string[] {
    const personal = join(home, '.agents', 'skills');
    return agents.includes('copilot') && existsSync(personal)
        ? [ `Copilot reads personal skills from ${ personal }, which COPILOT_HOME doesn't cover: move it aside for the evaluation` ]
        : [];
}
