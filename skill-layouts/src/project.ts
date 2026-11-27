// Builds what the runs start from: tarballs of the Serenity/JS packages with each layout's skills, and a copy of the
// Mocha template that installs them, with the skills linked for Kiro and Copilot as `npx skills` links them.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

import { adapterOf, AGENTS } from './agents/index.ts';
import { run as runToCompletion } from './child-processes.ts';
import { type Layout, PACKAGES_WITH_SKILLS, skillsDirectoryOf } from './layouts.ts';
import { Work } from './work.ts';

/** The packages the template depends on, all packed from the same build, so the template uses one build of the framework. */
export const PACKAGES = [ 'assertions', 'console-reporter', 'core', 'html-reporter', 'mocha', 'rest' ] as const;

/** The skills CLI, pinned, so every layout is linked the same way. */
export const SKILLS_CLI = 'skills@1.8.1';

/**
 * How a user links the skills of their dependencies for every agent, with `npx skills`, and the directories it links
 * them into, as each agent's adapter, in agents/, says.
 */
export const SKILLS_SYNC = [ 'experimental_sync', '-y', '-a', ...AGENTS.map(agent => adapterOf(agent).skills.cliAgent) ];
export const AGENT_SKILL_DIRECTORIES = AGENTS.map(agent => adapterOf(agent).skills.directory);

interface Manifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    overrides?: Record<string, string>;
    [key: string]: unknown;
}

const posix = (path: string) => path.split(sep).join('/');

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
    // the user's whole environment, credentials included: a known issue, in the README
    return runToCompletion(command, args, { cwd, env: { ...process.env, ...env }, stdio: [ 'ignore', 'pipe', 'pipe' ] });
}

// ---------------------------------------------------------------------------------------------------------------------
// The package manifest

/**
 * The template's manifest with its Serenity/JS dependencies pointing at the tarballs. The tarballs' own dependencies on
 * each other are `workspace:*`, which `npm pack` leaves as they are, so `overrides` points those at the tarballs too.
 */
export function withTarballs(manifest: Manifest, tarballs: Record<string, string>): Manifest {
    const specifiers = Object.fromEntries(Object.entries(tarballs).map(([ name, path ]) => [ name, `file:${ posix(path) }` ]));
    for (const name of Object.keys(specifiers)) {
        if (! manifest.dependencies?.[name] && ! manifest.devDependencies?.[name]) {
            throw new Error(`the template doesn't depend on ${ name }, so it can't be pointed at its tarball`);
        }
    }
    const pointAtTarballs = (dependencies: Record<string, string> | undefined) => dependencies && Object.fromEntries(
        Object.entries(dependencies).map(([ name, version ]) => [ name, specifiers[name] ?? version ]));

    return {
        ...manifest,
        dependencies: pointAtTarballs(manifest.dependencies),
        ...(manifest.devDependencies ? { devDependencies: pointAtTarballs(manifest.devDependencies) } : {}),
        overrides: { ...manifest.overrides, ...specifiers },
    };
}

const BASE_API_URL = /BASE_API_URL=\S*/;

/**
 * The manifest with its test script pointing the scenarios at the local API server, e.g. `http://127.0.0.1:4567/v4/`,
 * instead of api.mathjs.org. Every run's server listens on the one port config.json sets, so every run gets the same
 * script.
 */
export function withLocalApi<M extends { scripts?: Record<string, string> }>(manifest: M, mathjsUrl: string): M & { scripts: Record<string, string> } {
    const test = manifest.scripts?.test ?? '';
    if (! BASE_API_URL.test(test)) {
        throw new Error(`the test script, ${ JSON.stringify(test) }, doesn't set BASE_API_URL, so it can't be pointed at the local API server`);
    }
    return { ...manifest, scripts: { ...manifest.scripts, test: test.replace(BASE_API_URL, `BASE_API_URL=${ mathjsUrl }`) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Checks

/** Every directory in `nodeModules` that holds the package `name`, relative to the project. */
export function copiesOf(nodeModules: string, name: string): string[] {
    const project = join(nodeModules, '..');
    const found: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (! entry.isDirectory() || entry.name === '.bin') {
                continue;
            }
            const path = join(directory, entry.name);
            if (entry.name.startsWith('@')) {
                visit(path);
                continue;
            }
            const scoped = basename(directory).startsWith('@') ? `${ basename(directory) }/${ entry.name }` : entry.name;
            if (scoped === name && existsSync(join(path, 'package.json'))) {
                found.push(posix(relative(project, path)));
            }
            if (existsSync(join(path, 'node_modules'))) {
                visit(join(path, 'node_modules'));
            }
        }
    };
    visit(nodeModules);
    return found.sort();
}

function filesUnder(directory: string): string[] {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => posix(relative(directory, join(entry.parentPath, entry.name))))
        .sort();
}

function skillNamesIn(directory: string): string[] {
    return existsSync(directory)
        ? readdirSync(directory).filter(name => name.startsWith('serenity-js-')).sort()
        : [];
}

/**
 * Whether the agents' skill directories in a project link exactly the layout's skills, with the layout's files.
 * `layoutSkillDirectories` are the layout's directories of skills, one per package, e.g. `layouts/b/core`.
 */
export function problemsWithLinkedSkills(project: string, layoutSkillDirectories: string[]): string[] {
    const sources = new Map(layoutSkillDirectories.flatMap(directory => skillNamesIn(directory).map(name => [ name, join(directory, name) ])));
    const expected = [ ...sources.keys() ].sort();

    return AGENT_SKILL_DIRECTORIES.flatMap(directory => {
        const linked = skillNamesIn(join(project, directory));
        if (linked.join() !== expected.join()) {
            return [ `${ directory }: links ${ linked.join(', ') || 'nothing' }, but the layout has ${ expected.join(', ') || 'no skills' }` ];
        }
        return linked.flatMap(name => {
            const installed = realpathSync(join(project, directory, name));
            const source = sources.get(name)!;
            const files = [ ...new Set([ ...filesUnder(installed), ...filesUnder(source) ]) ].sort();
            const different = files.find(file =>
                ! existsSync(join(installed, file)) || ! existsSync(join(source, file))
                || readFileSync(join(installed, file), 'utf8') !== readFileSync(join(source, file), 'utf8'));
            return different ? [ `${ directory }/${ name }: ${ different } differs from the layout's` ] : [];
        });
    });
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * A path as `git diff` names it: as it is, or in quotes, with C's escapes, when it has a quote, a backslash or a control
 * character, or a non-ASCII one without core.quotePath=false, such as `"b/caf\303\251.ts"` for `b/café.ts`.
 */
function unquoted(path: string): string {
    if (! path.startsWith('"')) {
        return path;
    }
    const bytes: number[] = [];
    for (let index = 1; index < path.length - 1; index++) {
        if (path[index] !== '\\') {
            const character = String.fromCodePoint(path.codePointAt(index)!);
            bytes.push(...Buffer.from(character));
            index += character.length - 1;
        }
        else if (/[0-7]{3}/.test(path.slice(index + 1, index + 4))) {
            bytes.push(Number.parseInt(path.slice(index + 1, index + 4), 8));
            index += 3;
        }
        else {
            bytes.push(ESCAPES[path[++index]] ?? path.charCodeAt(index));
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

/** The lines each file gained, from `git diff`, with or without context, by the 1-based line numbers of the new file. */
export function addedLinesOf(diff: string): Map<string, Set<number>> {
    const added = new Map<string, Set<number>>();
    let file: string | undefined;
    let line = 0;
    for (const text of diff.split('\n')) {
        if (text.startsWith('+++ ')) {
            // git ends the line with a tab when the path has a space
            file = text === '+++ /dev/null' ? undefined : unquoted(text.slice(4).replace(/\t$/, '')).replace(/^b\//, '');
            continue;
        }
        const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(text);
        if (hunk) {
            line = Number(hunk[1]);
            continue;
        }
        if (file && text.startsWith('+')) {
            if (! added.has(file)) {
                added.set(file, new Set());
            }
            added.get(file)!.add(line++);
        }
        // a line of context, in a diff with context, as a run's diff.patch has, is in the new file too
        else if (file && text.startsWith(' ')) {
            line++;
        }
    }
    return added;
}

// ---------------------------------------------------------------------------------------------------------------------
// Building the fixtures

export interface Packed {
    /** The tarball of each package, by name, e.g. `@serenity-js/core` */
    tarballs: Record<string, string>;
    /** The commit of the serenity-js clone they were packed from */
    commit: string;
}

/** `npm pack`s every package the template depends on, in a compiled serenity-js clone. */
export function packPackages(clone: string, out: string): Packed {
    const destination = new Work(out).tarballs('packed');
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    const tarballs = Object.fromEntries(PACKAGES.map(pkg => {
        const directory = join(clone, 'packages', pkg);
        if (! existsSync(join(directory, 'lib'))) {
            throw new Error(`${ directory } has no lib/: compile the clone first, with make COMPILE_SCOPE=libs compile`);
        }
        const [ { filename } ] = JSON.parse(run('npm', [ 'pack', '--json', '--pack-destination', destination ], directory)) as Array<{ filename: string }>;
        return [ `@serenity-js/${ pkg }`, join(destination, filename) ];
    }));
    return { tarballs, commit: run('git', [ 'rev-parse', 'HEAD' ], clone).trim() };
}

/** A name for a layout's tarballs that doesn't give the layout away in the package.json a reviewer may see in a diff. */
function opaqueNameOf(layout: Layout): string {
    return createHash('sha256').update(`skill-layouts:${ layout }`).digest('hex').slice(0, 8);
}

/** The packed tarballs, with the `skills/` of core and mocha replaced by the layout's. */
export function layoutTarballs(layout: Layout, packed: Packed, out: string): Record<string, string> {
    const destination = new Work(out).tarballs(opaqueNameOf(layout));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });

    return Object.fromEntries(Object.entries(packed.tarballs).map(([ name, tarball ]) => {
        const target = join(destination, basename(tarball));
        const pkg = name.replace('@serenity-js/', '');
        if (! (PACKAGES_WITH_SKILLS as readonly string[]).includes(pkg)) {
            cpSync(tarball, target);
            return [ name, target ];
        }
        const scratch = mkdtempSync(join(tmpdir(), 'skill-layouts-'));
        try {
            run('tar', [ '-xzf', tarball, '-C', scratch ], scratch);
            rmSync(join(scratch, 'package', 'skills'), { recursive: true, force: true });
            const skills = skillsDirectoryOf(layout, pkg as typeof PACKAGES_WITH_SKILLS[number]);
            if (skills) {
                cpSync(skills, join(scratch, 'package', 'skills'), { recursive: true });
            }
            // npm pack writes the same bytes for the same files, unlike tar, so a saved lockfile's integrity hashes
            // still match the tarballs on a resume
            run('npm', [ 'pack', '--ignore-scripts', '--pack-destination', destination ], join(scratch, 'package'));
        }
        finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        return [ name, target ];
    }));
}

/** Refuses a template clone that doesn't have the pinned commit, and says how to get it. */
export function checkTemplateCommit(template: string, commit: string): void {
    try {
        run('git', [ 'cat-file', '-e', `${ commit }^{commit}` ], template);
    }
    catch {
        throw new Error(`${ template } doesn't have commit ${ commit }, which config.json pins: fetch it, e.g. with git fetch origin, or git fetch origin pull/<number>/head for a pull request that isn't merged yet`);
    }
}

/**
 * Installs the project's dependencies: the first time a layout is prepared for an --out, resolving them with npm
 * install and saving npm's lockfile in `savedLockfile`; after that, from that lockfile, with npm ci, so a resume, such
 * as the second agent's half of the pilot, gets the same third-party versions as the first.
 */
export function installDependencies(project: string, savedLockfile: string, npm: (command: string, args: string[], cwd: string) => string = run): void {
    const lockfile = join(project, 'package-lock.json');
    if (existsSync(savedLockfile)) {
        cpSync(savedLockfile, lockfile);
        npm('npm', [ 'ci', '--no-audit', '--no-fund' ], project);
        return;
    }
    rmSync(lockfile, { force: true });
    npm('npm', [ 'install', '--no-audit', '--no-fund' ], project);
    mkdirSync(dirname(savedLockfile), { recursive: true });
    cpSync(lockfile, savedLockfile);
}

/**
 * A copy of the template, at the pinned commit, with the layout's tarballs installed and its skills linked, checked:
 * one copy of `@serenity-js/core`, installed from the tarball, and the layout's skills linked for both agents.
 */
export function prepareProject(layout: Layout, template: { directory: string, commit: string }, tarballs: Record<string, string>, out: string, savedLockfile: string): string {
    const { project, templateArchive: archive } = new Work(out).layout(layout);
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });

    run('git', [ 'archive', '--output', archive, template.commit ], template.directory);
    run('tar', [ '-xf', archive, '-C', project ], project);
    rmSync(archive);

    const manifestPath = join(project, 'package.json');
    writeFileSync(manifestPath, `${ JSON.stringify(withTarballs(JSON.parse(readFileSync(manifestPath, 'utf8')), tarballs), null, 2) }\n`);
    installDependencies(project, savedLockfile);

    // the directories an agent's project needs before npx skills links into it, such as .kiro
    for (const needed of AGENTS.flatMap(agent => adapterOf(agent).skills.needs ?? [])) {
        mkdirSync(join(project, needed), { recursive: true });
    }
    run('npx', [ '-y', SKILLS_CLI, ...SKILLS_SYNC ], project);

    const problems = [
        ...problemsWithCore(project),
        ...problemsWithLinkedSkills(project, PACKAGES_WITH_SKILLS.flatMap(pkg => skillsDirectoryOf(layout, pkg) ?? [])),
    ];
    if (problems.length > 0) {
        throw new Error(`the project for layout ${ layout } isn't set up as the evaluation needs:\n${ problems.map(problem => `  ${ problem }`).join('\n') }`);
    }
    return project;
}

function problemsWithCore(project: string): string[] {
    const copies = copiesOf(join(project, 'node_modules'), '@serenity-js/core');
    const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8')) as { packages: Record<string, { resolved?: string }> };
    const resolved = lock.packages['node_modules/@serenity-js/core']?.resolved ?? '';
    return [
        ...(copies.length === 1 ? [] : [ `node_modules holds ${ copies.length } copies of @serenity-js/core: ${ copies.join(', ') }` ]),
        ...(resolved.startsWith('file:') ? [] : [ `@serenity-js/core was installed from ${ resolved || 'an unknown source' }, not from its tarball` ]),
    ];
}

/**
 * Type-checks the `typescript` examples of the layout's skills with the serenity-js clone's `bin/test-skills.ts`, as
 * installed in a copy of the project, so the examples compile against the packed packages and the template's own
 * dependencies, like `@serenity-js/rest` and Mocha. The copy is thrown away, so the runs' projects stay as installed.
 */
export function checkExamples(layout: Layout, project: string, clone: string, out: string): string[] {
    const copy = new Work(out).layout(layout).examples;
    rmSync(copy, { recursive: true, force: true });
    cpSync(project, copy, { recursive: true, verbatimSymlinks: true });

    const tsx = join(clone, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const script = join(clone, 'bin', 'test-skills.ts');
    if (! existsSync(script)) {
        throw new Error(`${ script } doesn't exist: check out the branch of serenity-js/serenity-js#3616, or one that includes it`);
    }

    return PACKAGES_WITH_SKILLS.filter(pkg => skillsDirectoryOf(layout, pkg)).map(pkg => {
        const installed = join(copy, 'node_modules', '@serenity-js', pkg);
        // the compiler options the package's own test:skills uses, without the files of the clone
        const { compilerOptions } = JSON.parse(run('npx', [ 'tsc', '--showConfig', '--project', join(clone, 'packages', pkg, 'tsconfig.json') ], clone)) as { compilerOptions: unknown };
        writeFileSync(join(installed, 'tsconfig.json'), JSON.stringify({ compilerOptions }, null, 2));
        try {
            return `@serenity-js/${ pkg }: ${ run(process.execPath, [ '--import', `file://${ posix(tsx) }`, script ], installed).trim() }`;
        }
        catch (error) {
            const { stdout = '', stderr = '' } = error as { stdout?: string, stderr?: string };
            throw new Error(`the examples of layout ${ layout } in @serenity-js/${ pkg } don't compile:\n${ stdout }${ stderr }`);
        }
    });
}
