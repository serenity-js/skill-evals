import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addedLinesOf, AGENT_SKILL_DIRECTORIES, withLocalApi, copiesOf, installDependencies, layoutTarballs, problemsWithLinkedSkills, SKILLS_SYNC, withTarballs } from '../src/project.ts';

describe('withTarballs', () => {

    const manifest = {
        name: 'template',
        dependencies: { '@serenity-js/core': '^3.49.0', '@serenity-js/mocha': '^3.49.0', 'mocha': '^12.0.3' },
        devDependencies: { 'typescript': '^5.9.3' },
    };
    const tarballs = { '@serenity-js/core': '/out/tarballs/1a2b3c4d/serenity-js-core-3.49.0.tgz', '@serenity-js/mocha': '/out/tarballs/1a2b3c4d/serenity-js-mocha-3.49.0.tgz' };

    it("points the template's Serenity/JS dependencies at the tarballs", () => {
        expect(withTarballs(manifest, tarballs).dependencies).toEqual({
            '@serenity-js/core': 'file:/out/tarballs/1a2b3c4d/serenity-js-core-3.49.0.tgz',
            '@serenity-js/mocha': 'file:/out/tarballs/1a2b3c4d/serenity-js-mocha-3.49.0.tgz',
            'mocha': '^12.0.3',
        });
    });

    it("overrides the packages' dependencies on each other too, which npm pack leaves as workspace:*", () => {
        expect(withTarballs(manifest, tarballs).overrides).toEqual({
            '@serenity-js/core': 'file:/out/tarballs/1a2b3c4d/serenity-js-core-3.49.0.tgz',
            '@serenity-js/mocha': 'file:/out/tarballs/1a2b3c4d/serenity-js-mocha-3.49.0.tgz',
        });
    });

    it("refuses a template that doesn't depend on a package the harness packed", () => {
        expect(() => withTarballs(manifest, { ...tarballs, '@serenity-js/rest': '/out/rest.tgz' })).toThrow(/doesn't depend on @serenity-js\/rest/);
    });
});

describe('AGENT_SKILL_DIRECTORIES', () => {
    it("are where npx skills links the project's skills for Kiro and Copilot, which both read them there", () => {
        expect(AGENT_SKILL_DIRECTORIES).toEqual([ '.kiro/skills', '.agents/skills' ]);
        expect(SKILLS_SYNC).toEqual([ 'experimental_sync', '-y', '-a', 'kiro-cli', 'github-copilot' ]);
    });
});

describe('the checks of a prepared project', () => {

    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function packageAt(path: string, name: string) {
        mkdirSync(join(root, path), { recursive: true });
        writeFileSync(join(root, path, 'package.json'), JSON.stringify({ name, version: '3.49.0' }));
    }

    describe('copiesOf', () => {
        it('finds every copy of a package in node_modules, however deeply nested', () => {
            packageAt('node_modules/@serenity-js/core', '@serenity-js/core');
            packageAt('node_modules/@serenity-js/web/node_modules/@serenity-js/core', '@serenity-js/core');
            packageAt('node_modules/@serenity-js/web', '@serenity-js/web');

            expect(copiesOf(join(root, 'node_modules'), '@serenity-js/core')).toEqual([
                'node_modules/@serenity-js/core',
                'node_modules/@serenity-js/web/node_modules/@serenity-js/core',
            ]);
        });
    });

    describe('problemsWithLinkedSkills', () => {

        function skill(path: string, content = '# Skill\n') {
            mkdirSync(join(root, path), { recursive: true });
            writeFileSync(join(root, path, 'SKILL.md'), content);
        }

        function link(directory: string, name: string, target: string) {
            mkdirSync(join(root, directory), { recursive: true });
            symlinkSync(target, join(root, directory, name));
        }

        beforeEach(() => {
            skill('layout/core/serenity-js-screenplay');
            skill('project/node_modules/@serenity-js/core/skills/serenity-js-screenplay');
        });

        const problems = () => problemsWithLinkedSkills(join(root, 'project'), [ join(root, 'layout/core') ]);

        it("accepts a project whose agents' skill directories link the layout's skills", () => {
            link('project/.kiro/skills', 'serenity-js-screenplay', '../../node_modules/@serenity-js/core/skills/serenity-js-screenplay');
            link('project/.agents/skills', 'serenity-js-screenplay', '../../node_modules/@serenity-js/core/skills/serenity-js-screenplay');

            expect(problems()).toEqual([]);
        });

        it('reports a skill that is missing, or that the layout has no such skill', () => {
            link('project/.kiro/skills', 'serenity-js-writing-tasks', '../../node_modules/@serenity-js/core/skills/serenity-js-screenplay');

            expect(problems()).toEqual([
                '.kiro/skills: links serenity-js-writing-tasks, but the layout has serenity-js-screenplay',
                '.agents/skills: links nothing, but the layout has serenity-js-screenplay',
            ]);
        });

        it("reports a linked skill whose files differ from the layout's", () => {
            skill('project/node_modules/@serenity-js/core/skills/serenity-js-screenplay', '# Another skill\n');
            link('project/.kiro/skills', 'serenity-js-screenplay', '../../node_modules/@serenity-js/core/skills/serenity-js-screenplay');
            link('project/.agents/skills', 'serenity-js-screenplay', '../../node_modules/@serenity-js/core/skills/serenity-js-screenplay');

            expect(problems()).toEqual([
                ".kiro/skills/serenity-js-screenplay: SKILL.md differs from the layout's",
                ".agents/skills/serenity-js-screenplay: SKILL.md differs from the layout's",
            ]);
        });

        it('accepts no skills at all for the layout without skills', () => {
            expect(problemsWithLinkedSkills(join(root, 'project'), [])).toEqual([]);
        });
    });
});

describe('addedLinesOf', () => {
    it('reads the lines each file gained from a diff without context', () => {
        const diff = [
            'diff --git a/spec/a.spec.ts b/spec/a.spec.ts',
            '--- a/spec/a.spec.ts',
            '+++ b/spec/a.spec.ts',
            '@@ -3,0 +4,2 @@ describe',
            '+one',
            '+two',
            '@@ -10 +12 @@',
            '-old',
            '+new',
            'diff --git a/spec/b.spec.ts b/spec/b.spec.ts',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/spec/b.spec.ts',
            '@@ -0,0 +1,3 @@',
            '+a',
            '+b',
            '+c',
            'diff --git a/spec/c.spec.ts b/spec/c.spec.ts',
            'deleted file mode 100644',
            '--- a/spec/c.spec.ts',
            '+++ /dev/null',
            '@@ -1,2 +0,0 @@',
            '-gone',
            '-gone',
        ].join('\n');

        expect(addedLinesOf(diff)).toEqual(new Map([
            [ 'spec/a.spec.ts', new Set([ 4, 5, 12 ]) ],
            [ 'spec/b.spec.ts', new Set([ 1, 2, 3 ]) ],
        ]));
    });

    it('reads them from a diff with context, as a run saves it in diff.patch', () => {
        const diff = [
            'diff --git a/spec/a.spec.ts b/spec/a.spec.ts',
            '--- a/spec/a.spec.ts',
            '+++ b/spec/a.spec.ts',
            '@@ -3,4 +3,5 @@ describe',
            ' context',
            '-old',
            '+new',
            '+another',
            ' context',
            ' context',
            '\\ No newline at end of file',
        ].join('\n');

        expect(addedLinesOf(diff)).toEqual(new Map([ [ 'spec/a.spec.ts', new Set([ 4, 5 ]) ] ]));
    });

    it("reads the paths git quotes, such as one with a non-ASCII character or a quote, and those with a space, as they're named", () => {
        const diff = [
            '+++ "b/src/caf\\303\\251.ts"',
            '@@ -0,0 +1 @@',
            '+one',
            '+++ "b/src/a \\"quoted\\" name.ts"\t',
            '@@ -0,0 +1 @@',
            '+two',
            '+++ b/src/a 🙂 name.ts\t',
            '@@ -0,0 +1 @@',
            '+three',
        ].join('\n');

        expect(addedLinesOf(diff)).toEqual(new Map([ [ 'src/café.ts', new Set([ 1 ]) ], [ 'src/a "quoted" name.ts', new Set([ 1 ]) ], [ 'src/a 🙂 name.ts', new Set([ 1 ]) ] ]));
    });
});

describe('installDependencies', () => {

    let root: string;
    let project: string;
    let saved: string;
    let commands: string[];

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-install-'));
        project = join(root, 'project');
        saved = join(root, 'results', 'layouts', 'b', 'package-lock.json');
        mkdirSync(project);
        writeFileSync(join(project, 'package-lock.json'), "{ \"the template's\": true }");
        commands = [];
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // npm, standing in: install writes a lockfile, ci needs one
    const npm = (command: string, args: string[], cwd: string) => {
        commands.push(`${ command } ${ args[0] }`);
        if (args[0] === 'install') {
            writeFileSync(join(cwd, 'package-lock.json'), '{ "resolved": "the first time" }');
        }
        if (args[0] === 'ci' && ! existsSync(join(cwd, 'package-lock.json'))) {
            throw new Error('npm ci needs a lockfile');
        }
        return '';
    };

    it("resolves the dependencies the first time a layout is prepared for an --out, and saves npm's lockfile in the results", () => {
        installDependencies(project, saved, npm);

        expect(commands).toEqual([ 'npm install' ]);
        expect(readFileSync(saved, 'utf8')).toBe('{ "resolved": "the first time" }');
    });

    it('installs from the saved lockfile with npm ci after that, so a resume gets the same third-party versions', () => {
        installDependencies(project, saved, npm);
        rmSync(project, { recursive: true });
        mkdirSync(project);
        commands = [];

        installDependencies(project, saved, npm);

        expect(commands).toEqual([ 'npm ci' ]);
        expect(readFileSync(join(project, 'package-lock.json'), 'utf8')).toBe('{ "resolved": "the first time" }');
    });
});

describe('layoutTarballs', () => {

    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'skill-layouts-tarballs-'));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("repacks a layout's tarballs byte for byte the same every time, so a saved lockfile's integrity hashes still match", () => {
        const pkg = join(root, 'mocha');
        mkdirSync(pkg);
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@serenity-js/mocha', version: '3.49.0' }));
        writeFileSync(join(pkg, 'index.js'), 'module.exports = {}\n');
        const [ { filename } ] = JSON.parse(execFileSync('npm', [ 'pack', '--json', '--pack-destination', root ], { cwd: pkg, encoding: 'utf8' }));
        const packed = { tarballs: { '@serenity-js/mocha': join(root, filename) }, commit: 'abc' };
        const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

        const first = sha(layoutTarballs('b', packed, join(root, 'work'))['@serenity-js/mocha']);
        const second = sha(layoutTarballs('b', packed, join(root, 'work'))['@serenity-js/mocha']);

        expect(second).toBe(first);
    });
});

describe('withLocalApi', () => {

    const template = { name: 'template', scripts: { test: 'cross-env BASE_API_URL=http://api.mathjs.org/v4/ mocha', lint: 'eslint .' } };

    it("points the test script at the local API server, and changes nothing else", () => {
        expect(withLocalApi(template, 'http://127.0.0.1:4567/v4/')).toEqual({
            name: 'template', scripts: { test: 'cross-env BASE_API_URL=http://127.0.0.1:4567/v4/ mocha', lint: 'eslint .' },
        });
    });

    it('points it at another port on a run of its own', () => {
        const first = withLocalApi(template, 'http://127.0.0.1:4567/v4/');

        expect(withLocalApi(first, 'http://127.0.0.1:5678/v4/').scripts.test).toBe('cross-env BASE_API_URL=http://127.0.0.1:5678/v4/ mocha');
    });

    it("refuses a test script that doesn't give the scenarios BASE_API_URL", () => {
        expect(() => withLocalApi({ scripts: { test: 'mocha' } }, 'http://127.0.0.1:4567/v4/')).toThrow(/BASE_API_URL/);
    });
});
