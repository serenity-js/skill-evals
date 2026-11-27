// The project a recorded run started from, and left, rebuilt for the judge: the template at the round's commit, with
// the newest version of the request's fixture that the run's diff applies to.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { run, runBuffer } from '../child-processes.ts';

/** How the starting projects run git and tar: child-processes.ts's runner. */
export interface Commands {
    run: typeof run;
    runBuffer: typeof runBuffer;
}

/** A version of a fixture: as it is, or as a commit of the harness's history has it. */
export interface FixtureVersion {
    label: string;
    copyTo(directory: string): void;
}

/** The versions of the requests' fixtures, in `<root>/fixtures/`, and in the history of the repository it's in. */
export class FixtureHistory {

    private readonly root: string;
    private readonly commands: Commands;

    constructor(root: string, commands: Commands) {
        this.root = root;
        this.commands = commands;
    }

    /**
     * The versions of a request's fixture, newest first: as it is, then as each commit that changed it left it. None
     * for a request without one, which only has the template.
     */
    versionsOf(fixture: string | undefined): FixtureVersion[] {
        if (fixture === undefined) {
            return [ { label: 'no fixture', copyTo: () => {} } ];
        }
        const { run, runBuffer } = this.commands;
        const current = join(this.root, 'fixtures', fixture);
        // the fixture's path in the repository, as git has it, whatever links the path to the repository goes through
        const top = run('git', [ 'rev-parse', '--show-toplevel' ], { cwd: current, stdio: 'pipe' }).trim();
        const path = run('git', [ 'rev-parse', '--show-prefix' ], { cwd: current, stdio: 'pipe' }).trim().replace(/\/$/, '');
        const commits = run('git', [ 'log', '--format=%H', '--', path ], { cwd: top, stdio: 'pipe' }).split('\n').filter(Boolean);
        return [
            { label: `the ${ fixture } fixture as it is`, copyTo: directory => cpSync(current, directory, { recursive: true }) },
            ...commits.map(commit => ({
                label: `the ${ fixture } fixture as of ${ commit.slice(0, 7) }`,
                copyTo: (directory: string) => {
                    const scratch = mkdtempSync(join(tmpdir(), 'skill-layouts-fixture-'));
                    try {
                        runBuffer('tar', [ '-x', '-C', scratch ], { input: runBuffer('git', [ 'archive', commit, path ], { cwd: top, maxBuffer: 256 * 1024 * 1024 }) });
                        if (existsSync(join(scratch, path))) {
                            cpSync(join(scratch, path), directory, { recursive: true });
                        }
                    }
                    finally {
                        rmSync(scratch, { recursive: true, force: true });
                    }
                },
            })),
        ];
    }
}

/** A run's project, rebuilt: as the run found it, as it left it, and with which version of its fixture. */
export class StartingProject {

    static of(directory: string, version: string): StartingProject {
        return new StartingProject(join(directory, 'before'), join(directory, 'after'), version);
    }

    readonly before: string;
    readonly after: string;
    readonly version: string;

    private constructor(before: string, after: string, version: string) {
        this.before = before;
        this.after = after;
        this.version = version;
    }
}

/** Rebuilds the projects recorded runs started from, with the commands it's given. */
export class ProjectBuilder {

    private readonly commands: Commands;

    constructor(commands: Commands) {
        this.commands = commands;
    }

    /**
     * The project as the run found it, in `<directory>/before`, and as it left it, in `<directory>/after`: the template
     * at `commit`, with the first of `versions` of its fixture that `diff` applies to, since a fixture may have changed
     * since the round. It says why, version by version, when the diff applies to none.
     */
    build(directory: string, { template, commit, versions, diff }: { template: string, commit: string, versions: FixtureVersion[], diff: string }): StartingProject {
        const { run, runBuffer } = this.commands;
        const git = (cwd: string, args: string[]) =>
            run('git', [ '-c', 'user.name=skill-layouts', '-c', 'user.email=skill-layouts@localhost', '-c', 'commit.gpgsign=false', ...args ], { cwd, stdio: 'pipe' });
        const before = join(directory, 'before');
        const after = join(directory, 'after');
        const patch = join(directory, 'run.patch');
        mkdirSync(directory, { recursive: true });
        writeFileSync(patch, diff);
        const archive = runBuffer('git', [ 'archive', commit ], { cwd: template, maxBuffer: 256 * 1024 * 1024 });
        const reasons: string[] = [];
        for (const version of versions) {
            rmSync(before, { recursive: true, force: true });
            rmSync(after, { recursive: true, force: true });
            mkdirSync(before, { recursive: true });
            runBuffer('tar', [ '-x', '-C', before ], { input: archive });
            version.copyTo(before);
            cpSync(before, after, { recursive: true });
            if (diff.trim() === '') {
                return StartingProject.of(directory, version.label);
            }
            git(after, [ 'init', '--quiet' ]);
            try {
                git(after, [ 'apply', '--whitespace=nowarn', patch ]);
                return StartingProject.of(directory, version.label);
            }
            catch (error) {
                reasons.push(`${ version.label }: ${ String((error as { stderr?: string }).stderr ?? '').trim().split('\n')[0] }`);
            }
            finally {
                rmSync(join(after, '.git'), { recursive: true, force: true });
            }
        }
        throw new Error(`its diff doesn't apply to the template at ${ commit } with ${ reasons.join('; ') }`);
    }
}
