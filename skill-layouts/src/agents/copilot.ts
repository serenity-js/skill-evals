// GitHub Copilot CLI, run headless: its sandbox on, with no way out of it, no git or gh credentials in it, and an
// allowlist of hosts. Copilot also reads personal skills from ~/.agents/skills, which COPILOT_HOME doesn't cover, so
// the runs don't start while it exists.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCopilotStream } from '../streams.ts';
import { ALLOWED_HOSTS, type AgentAdapter } from './agent.ts';

/**
 * What Copilot's sandbox lets shell commands reach. Once its allowlist has an entry, every other host is blocked, so
 * it lists the npm registry too, which Kiro's COMMON_DEPENDENCIES mode reaches, along with other package services.
 */
export const COPILOT_ALLOWED_HOSTS = [ ...ALLOWED_HOSTS, 'registry.npmjs.org' ];

export const copilot: AgentAdapter<'copilot'> = {
    id: 'copilot',
    executable: 'copilot',
    // its built-in MCP servers are off, since Kiro's runs have none
    command: (model, prompt) => ({
        command: 'copilot',
        args: [
            '-p', prompt, '--output-format', 'json', '--model', model, '--no-ask-user',
            '--allow-all-tools', `--allow-url=${ ALLOWED_HOSTS.join(',') }`, '--sandbox', '--disable-builtin-mcps',
        ],
    }),
    homeVariable: 'COPILOT_HOME',
    // keeps Copilot from updating itself, or running a newer cached version, in the middle of an evaluation
    environment: { COPILOT_AUTO_UPDATE: 'false' },
    prepareHome: home => {
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'settings.json'), `${ JSON.stringify({
            sandbox: {
                enabled: true,
                allowBypass: false,
                auth: { git: false, gh: false },
                // the local network for the local API server, which listens on 127.0.0.1
                userPolicy: { network: { allowOutbound: true, allowLocalNetwork: true, allowedHosts: COPILOT_ALLOWED_HOSTS } },
            },
        }, null, 2) }\n`);
    },
    credentials: [ 'COPILOT_GITHUB_TOKEN' ],
    credentialOf: (env): Record<string, string> => env.COPILOT_GITHUB_TOKEN ? { COPILOT_GITHUB_TOKEN: env.COPILOT_GITHUB_TOKEN } : {},
    // GH_TOKEN would reach gh in the agent's shell commands too, so the runs don't pass it on
    credentialProblem: env => env.COPILOT_GITHUB_TOKEN
        ? undefined
        : 'Copilot needs COPILOT_GITHUB_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME and HOME, without your login, and gets no GH_TOKEN',
    otherProblems: userHome => {
        const personal = join(userHome, '.agents', 'skills');
        return existsSync(personal)
            ? [ `Copilot reads personal skills from ${ personal }, which COPILOT_HOME doesn't cover: move it aside for the evaluation` ]
            : [];
    },
    parseStream: (stream, { timedOut, skills }) => parseCopilotStream(stream, { timedOut, skills }),
    // Copilot reads project skills from .github/skills, .agents/skills and .claude/skills; npx skills links .agents/skills.
    // .agents and .claude hold agents' configuration, not the project's, while .github holds the project's own workflows
    skills: { reads: [ '.github/skills', '.agents/skills', '.claude/skills' ], cliAgent: 'github-copilot', directory: '.agents/skills', agentDirectories: [ '.agents', '.claude' ] },
    usageProblem: ({ premiumRequests }) => premiumRequests === undefined ? 'no premium requests recorded' : undefined,
};
