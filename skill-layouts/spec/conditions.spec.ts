import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changedConditions, checkConditions, hashOf, lockfileHashes, recordAgentConditions, recordLockfiles, type SharedConditions } from '../src/conditions.ts';
import { writeFixtures } from '../src/cli.ts';
import { evalRoot } from '../src/layouts.ts';

const shared: SharedConditions = {
    template: { commit: '2315e1e465e5fcc9ac750a503ed688808cf9d464' },
    serenityJs: { commit: '93273d64b9a6156c5d63168075019e4d8ca15500' },
    requests: 'sha256:aaaa',
    skills: { none: 'sha256:0000', a: 'sha256:1111', b: 'sha256:2222', c: 'sha256:3333' },
    lockfiles: { none: 'sha256:5555', b: 'sha256:6666' },
    apiServer: { port: 4170 },
};
const kiro = { model: 'claude-sonnet-5.5', version: 'kiro-cli 3.2.0' };
const copilot = { model: 'claude-sonnet-5.5', version: 'GitHub Copilot CLI 1.0.91' };

describe('changedConditions', () => {

    it('finds nothing changed when the conditions are the same', () => {
        expect(changedConditions(shared, structuredClone(shared))).toEqual([]);
    });

    it('names each condition that changed', () => {
        const now = structuredClone(shared);
        now.serenityJs.commit = 'f00';
        now.requests = 'sha256:bbbb';
        now.skills.b = 'sha256:4444';
        now.apiServer.port = 4171;

        expect(changedConditions(shared, now)).toEqual([
            'serenityJs.commit: 93273d64b9a6156c5d63168075019e4d8ca15500, now f00',
            'requests: sha256:aaaa, now sha256:bbbb',
            'skills.b: sha256:2222, now sha256:4444',
            'apiServer.port: 4170, now 4171',
        ]);
    });
});

describe('hashOf', () => {

    let copy: string;

    beforeEach(() => {
        copy = mkdtempSync(join(tmpdir(), 'skill-layouts-hash-'));
        cpSync(join(evalRoot, 'layouts', 'b'), copy, { recursive: true });
    });
    afterEach(() => rmSync(copy, { recursive: true, force: true }));

    it("changes when any file of a layout's skills changes", () => {
        const before = hashOf(copy);
        writeFileSync(join(copy, 'core', 'serenity-js-screenplay', 'references', 'tasks.md'), 'changed\n');

        expect(hashOf(copy)).not.toBe(before);
    });

    it("changes when a file is renamed, though its contents don't", () => {
        const before = hashOf(copy);
        cpSync(join(copy, 'core', 'serenity-js-screenplay', 'references', 'tasks.md'), join(copy, 'core', 'serenity-js-screenplay', 'references', 'renamed.md'));
        rmSync(join(copy, 'core', 'serenity-js-screenplay', 'references', 'tasks.md'));

        expect(hashOf(copy)).not.toBe(before);
    });

    it("is the same for the same files, and says it's a SHA-256", () => {
        expect(hashOf(copy)).toBe(hashOf(copy));
        expect(hashOf(copy)).toMatch(/^sha256:[\da-f]{64}$/);
    });

    it('hashes a single file too, such as requests.json', () => {
        expect(hashOf(join(evalRoot, 'requests.json'))).toMatch(/^sha256:/);
    });
});

describe('the conditions of a resumed evaluation', () => {

    let results: string;
    let file: string;

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-conditions-'));
        file = join(results, 'conditions.json');
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    const saved = () => JSON.parse(readFileSync(file, 'utf8'));

    /** A Kiro-only pilot: the shared conditions checked, and Kiro's recorded when its first run starts. */
    function kiroOnlyPilot() {
        checkConditions(file, shared, { kiro });
        recordAgentConditions(file, 'kiro', kiro);
    }

    it('saves the shared conditions the first time, and no agent conditions until that agent runs', () => {
        checkConditions(file, shared, { kiro });

        expect(saved()).toEqual({ shared, agents: {} });
    });

    it("records an agent's model and version when its first run starts, and keeps them after that", () => {
        kiroOnlyPilot();
        recordAgentConditions(file, 'kiro', { ...kiro, version: 'kiro-cli 3.3.0' });

        expect(saved()).toEqual({ shared, agents: { kiro } });
    });

    it('lets a Copilot-only resume follow a Kiro-only pilot in the same --out', () => {
        kiroOnlyPilot();

        expect(() => checkConditions(file, shared, { copilot })).not.toThrow();
        recordAgentConditions(file, 'copilot', copilot);
        expect(saved()).toEqual({ shared, agents: { kiro, copilot } });
    });

    it('refuses a Copilot resume after requests.json changed, and says what changed', () => {
        kiroOnlyPilot();

        expect(() => checkConditions(file, { ...shared, requests: 'sha256:bbbb' }, { copilot }))
            .toThrow(/requests: sha256:aaaa, now sha256:bbbb/);
    });

    it("refuses a Kiro resume after Kiro's pin changed", () => {
        kiroOnlyPilot();

        expect(() => checkConditions(file, shared, { kiro: { ...kiro, model: 'claude-opus-5.5' } }))
            .toThrow(/kiro\.model: claude-sonnet-5\.5, now claude-opus-5\.5/);
    });

    it("refuses a resume of either agent after the pin of an agent that has runs changed, though that agent isn't running", () => {
        kiroOnlyPilot();

        expect(() => checkConditions(file, shared, { copilot }, { kiro: 'claude-opus-5.5' }))
            .toThrow(/kiro\.model: claude-sonnet-5\.5, now claude-opus-5\.5/);
    });

    it("accepts a change to Copilot's pin before Copilot's first run", () => {
        kiroOnlyPilot();

        expect(() => checkConditions(file, shared, { copilot: { ...copilot, model: 'gpt-6' } }, { kiro: kiro.model, copilot: 'gpt-6' })).not.toThrow();
    });

    it('keeps the saved conditions when it refuses', () => {
        kiroOnlyPilot();
        const before = readFileSync(file, 'utf8');

        expect(() => checkConditions(file, { ...shared, requests: 'sha256:bbbb' }, { kiro })).toThrow();
        expect(readFileSync(file, 'utf8')).toBe(before);
    });
});

describe('the lockfiles of an evaluation', () => {

    let results: string;
    let file: string;

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-lockfiles-'));
        file = join(results, 'conditions.json');
        for (const layout of [ 'none', 'b' ]) {
            mkdirSync(join(results, 'layouts', layout), { recursive: true });
            writeFileSync(join(results, 'layouts', layout, 'package-lock.json'), `{ "layout": "${ layout }" }`);
        }
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    const withoutLockfiles = { ...shared, lockfiles: {} };

    it('hashes the lockfile saved for each layout, and none for a layout not prepared yet', () => {
        expect(Object.keys(lockfileHashes(results, [ 'none', 'a', 'b' ]))).toEqual([ 'none', 'b' ]);
    });

    it("records each saved lockfile's hash in the shared conditions once it's saved, and refuses a resume after one changed", () => {
        checkConditions(file, withoutLockfiles, { kiro });
        recordLockfiles(file, lockfileHashes(results, [ 'none', 'b' ]));
        writeFileSync(join(results, 'layouts', 'b', 'package-lock.json'), '{ "layout": "b, with other versions" }');

        expect(() => checkConditions(file, { ...shared, lockfiles: lockfileHashes(results, [ 'none', 'b' ]) }, { kiro }))
            .toThrow(/lockfiles\.b: sha256:[\da-f]+, now sha256:[\da-f]+/);
    });

    it("resumes while the saved lockfiles are as they were", () => {
        checkConditions(file, withoutLockfiles, { kiro });
        recordLockfiles(file, lockfileHashes(results, [ 'none', 'b' ]));

        expect(() => checkConditions(file, { ...shared, lockfiles: lockfileHashes(results, [ 'none', 'b' ]) }, { copilot })).not.toThrow();
    });
});

describe('fixtures.json', () => {

    let results: string;

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-fixtures-'));
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    it('keeps every agent that has run, with its recorded model and version, after --agent kiro, then --agent copilot', () => {
        const file = join(results, 'conditions.json');
        const fixtures = { serenityJs: { clone: '/s', commit: 'abc' }, template: { directory: '/t', commit: 'def' }, examples: [] };

        checkConditions(file, shared, { kiro });
        recordAgentConditions(file, 'kiro', kiro);
        writeFixtures(results, fixtures);
        checkConditions(file, shared, { copilot });
        recordAgentConditions(file, 'copilot', copilot);
        writeFixtures(results, fixtures);

        expect(JSON.parse(readFileSync(join(results, 'fixtures.json'), 'utf8')).agents).toEqual({ kiro, copilot });
    });
});
