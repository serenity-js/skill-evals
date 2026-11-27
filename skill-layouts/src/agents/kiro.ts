// Kiro CLI, run headless: its sandbox on, with the common package registries for npm install, and the local API server.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseKiroStream } from '../streams.ts';
import { ALLOWED_HOSTS, type AgentAdapter } from './agent.ts';

export const kiro: AgentAdapter<'kiro'> = {
    id: 'kiro',
    executable: 'kiro-cli',
    command: (model, prompt) => ({
        command: 'kiro-cli',
        args: [ 'chat', '--v3', '--no-interactive', '--sandbox', '--trust-all-tools', '--output-format', 'stream-json', '--model', model, prompt ],
    }),
    homeVariable: 'KIRO_HOME',
    environment: {},
    prepareHome: home => {
        mkdirSync(join(home, 'settings'), { recursive: true });
        // the common package registries, for npm install, and sandbox_network rules for the local API server
        writeFileSync(join(home, 'settings', 'sandbox.json'), `${ JSON.stringify({ enabled: true, networkAccess: 'COMMON_DEPENDENCIES' }, null, 2) }\n`);
        writeFileSync(join(home, 'settings', 'permissions.yaml'), [
            'rules:',
            '  - capability: sandbox_network',
            `    match: [${ ALLOWED_HOSTS.map(host => `'${ host }'`).join(', ') }]`,
            '    effect: allow',
            '',
        ].join('\n'));
    },
    credentials: [ 'KIRO_API_KEY' ],
    credentialOf: (env): Record<string, string> => env.KIRO_API_KEY ? { KIRO_API_KEY: env.KIRO_API_KEY } : {},
    credentialProblem: env => env.KIRO_API_KEY ? undefined : 'Kiro needs KIRO_API_KEY: each run has its own KIRO_HOME, without your login',
    otherProblems: () => [],
    parseStream: (stream, { skills }) => parseKiroStream(stream, skills),
    // Kiro reads project skills from .kiro/skills; npx skills only links into it when the project has a .kiro directory,
    // as a Kiro user's project would
    skills: { reads: [ '.kiro/skills' ], cliAgent: 'kiro-cli', directory: '.kiro/skills', needs: '.kiro', agentDirectories: [ '.kiro' ] },
    usageProblem: ({ credits }) => credits === undefined ? 'no credits recorded' : undefined,
};
