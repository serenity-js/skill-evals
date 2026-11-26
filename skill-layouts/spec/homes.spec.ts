import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALLOWED_HOSTS, credentialProblems, personalSkillsProblems, prepareAgentHomes } from '../src/homes.ts';

describe('prepareAgentHomes', () => {

    let homes: string;

    beforeEach(() => {
        homes = mkdtempSync(join(tmpdir(), 'skill-layouts-homes-'));
    });
    afterEach(() => rmSync(homes, { recursive: true, force: true }));

    it("gives the run a Kiro home, a Copilot home and a HOME of its own, instead of the user's, and keeps Copilot from updating itself", () => {
        const env = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(env).toEqual({
            HOME: join(homes, '3f9c2a1e', 'home'),
            KIRO_HOME: join(homes, '3f9c2a1e', 'kiro'),
            COPILOT_HOME: join(homes, '3f9c2a1e', 'copilot'),
            COPILOT_AUTO_UPDATE: 'false',
            npm_config_cache: join(homes, 'npm-cache'),
        });
        expect(readdirSync(env.COPILOT_HOME)).toEqual([ 'settings.json' ]);
        expect(readdirSync(env.HOME)).toEqual([]);
    });

    it("keeps npm's cache, which every run shares, so each run doesn't download every package again, while each HOME starts empty", () => {
        const first = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));
        writeFileSync(join(first.npm_config_cache, 'index'), '');
        writeFileSync(join(first.HOME, '.npmrc'), '');
        const again = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(readdirSync(again.npm_config_cache)).toEqual([ 'index' ]);
        expect(readdirSync(again.HOME)).toEqual([]);
    });

    it("turns on Kiro's sandbox, with the common development services reachable", () => {
        const { KIRO_HOME } = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(JSON.parse(readFileSync(join(KIRO_HOME, 'settings', 'sandbox.json'), 'utf8'))).toEqual({
            enabled: true,
            networkAccess: 'COMMON_DEPENDENCIES',
        });
    });

    it("lets Kiro's sandboxed commands reach the local API server, and not the public APIs it stands in for", () => {
        const { KIRO_HOME } = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(ALLOWED_HOSTS).toEqual([ '127.0.0.1', 'localhost' ]);
        expect(readFileSync(join(KIRO_HOME, 'settings', 'permissions.yaml'), 'utf8')).toBe([
            'rules:',
            '  - capability: sandbox_network',
            "    match: ['127.0.0.1', 'localhost']",
            '    effect: allow',
            '',
        ].join('\n'));
    });

    it("turns on Copilot's sandbox, without bypass or the user's credentials, and lets it reach only the local API server and the npm registry", () => {
        const { COPILOT_HOME } = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(JSON.parse(readFileSync(join(COPILOT_HOME, 'settings.json'), 'utf8'))).toEqual({
            sandbox: {
                enabled: true,
                allowBypass: false,
                auth: { git: false, gh: false },
                userPolicy: {
                    network: {
                        allowOutbound: true,
                        allowLocalNetwork: true,
                        allowedHosts: [ '127.0.0.1', 'localhost', 'registry.npmjs.org' ],
                    },
                },
            },
        });
    });

    it('starts each run from empty homes, whatever an earlier attempt left there', () => {
        const { COPILOT_HOME } = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));
        mkdirSync(join(COPILOT_HOME, 'skills'));
        const again = prepareAgentHomes(join(homes, '3f9c2a1e'), join(homes, 'npm-cache'));

        expect(readdirSync(again.COPILOT_HOME)).toEqual([ 'settings.json' ]);
    });
});

describe('credentialProblems', () => {

    it('needs KIRO_API_KEY for Kiro, which runs headless with empty homes', () => {
        expect(credentialProblems([ 'kiro' ], {})).toEqual([
            'Kiro needs KIRO_API_KEY: each run has its own KIRO_HOME, without your login',
        ]);
        expect(credentialProblems([ 'kiro' ], { KIRO_API_KEY: 'key' })).toEqual([]);
    });

    it("needs COPILOT_GITHUB_TOKEN for Copilot, and refuses GH_TOKEN alone, which the runs don't pass on", () => {
        const problem = 'Copilot needs COPILOT_GITHUB_TOKEN, with a token that can use Copilot: each run has its own COPILOT_HOME and HOME, without your login, and gets no GH_TOKEN';

        expect(credentialProblems([ 'copilot' ], {})).toEqual([ problem ]);
        expect(credentialProblems([ 'copilot' ], { GH_TOKEN: 'gho_1' })).toEqual([ problem ]);
        expect(credentialProblems([ 'copilot' ], { COPILOT_GITHUB_TOKEN: 'github_pat_1' })).toEqual([]);
    });

    it('only checks the agents the runs use', () => {
        expect(credentialProblems([ 'kiro' ], { KIRO_API_KEY: 'key' })).toEqual([]);
    });
});

describe('personalSkillsProblems', () => {

    let home: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'skill-layouts-home-'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    it("refuses to run Copilot while ~/.agents/skills exists, since Copilot reads personal skills from it, outside COPILOT_HOME", () => {
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });

        expect(personalSkillsProblems([ 'copilot' ], home)).toEqual([
            `Copilot reads personal skills from ${ join(home, '.agents', 'skills') }, which COPILOT_HOME doesn't cover: move it aside for the evaluation`,
        ]);
    });

    it("lets Copilot run when there's no ~/.agents/skills, and doesn't check it for Kiro alone", () => {
        expect(personalSkillsProblems([ 'copilot' ], home)).toEqual([]);
        mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
        expect(personalSkillsProblems([ 'kiro' ], home)).toEqual([]);
        expect(existsSync(join(home, '.agents', 'skills'))).toBe(true);
    });
});
