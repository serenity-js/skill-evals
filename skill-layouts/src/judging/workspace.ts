// Where the judge works: a directory per session, with what it's given written into it. JudgeWorkspace is the only
// code that writes a judge's inputs, with the filesystem operations it's constructed with.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { JudgeBrief } from './brief.ts';
import { JudgeVerdicts } from './rule-verdict.ts';

/** The file the judge writes its verdicts to, in its directory */
export const VERDICTS_FILE = 'verdicts.json';

/** The filesystem operations a workspace needs. */
export interface WorkspaceFilesystem {
    /** Writes a file, with the directories it's in */
    writeFile(path: string, content: string): void;
    /** Copies a project's directory, without anything the harness or git put there: .git and node_modules */
    copyProject(from: string, to: string): void;
    /** A file's contents, or undefined when there's no such file */
    readFile(path: string): string | undefined;
    /** Removes a directory, and everything in it */
    remove(path: string): void;
}

/** The project's files, without anything the harness or git put there. */
const isProjectFile = (source: string) => ! source.split(/[/\\]/).some(part => part === '.git' || part === 'node_modules');

/** The workspace's filesystem operations, as Node.js has them */
export function nodeFilesystem(): WorkspaceFilesystem {
    return {
        writeFile: (path, content) => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        },
        copyProject: (from, to) => cpSync(from, to, { recursive: true, filter: isProjectFile }),
        readFile: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
        remove: path => rmSync(path, { recursive: true, force: true }),
    };
}

/** The directory a judge works in, with what it was given, and the verdicts it leaves. Only a JudgeWorkspace makes one. */
export interface JudgeDirectory {
    readonly path: string;
    /** The verdicts the judge left on `rules`, or what's wrong with them */
    verdicts(rules: readonly string[]): JudgeVerdicts;
    remove(): void;
}

class WrittenJudgeDirectory implements JudgeDirectory {

    readonly path: string;
    private readonly filesystem: WorkspaceFilesystem;

    constructor(path: string, filesystem: WorkspaceFilesystem) {
        this.path = path;
        this.filesystem = filesystem;
    }

    verdicts(rules: readonly string[]): JudgeVerdicts {
        return JudgeVerdicts.read(this.filesystem.readFile(join(this.path, VERDICTS_FILE)), rules, VERDICTS_FILE);
    }

    remove(): void {
        this.filesystem.remove(this.path);
    }
}

/** The directory the judge's directories are made in, each with a new random name, so its path doesn't name the run. */
export class JudgeWorkspace {

    private readonly root: string;
    private readonly filesystem: WorkspaceFilesystem;
    private readonly randomName: () => string;

    constructor({ root, filesystem, randomName }: { root: string, filesystem: WorkspaceFilesystem, randomName: () => string }) {
        this.root = root;
        this.filesystem = filesystem;
        this.randomName = randomName;
    }

    /** A new judge's directory, with the brief's files in it, and its projects as `before/` and `after/` */
    prepare(brief: JudgeBrief): JudgeDirectory {
        const path = join(this.root, this.randomName());
        for (const file of brief.files()) {
            this.filesystem.writeFile(join(path, file.path), file.content);
        }
        for (const [ side, source ] of [ [ 'before', brief.before ], [ 'after', brief.after ] ] as const) {
            if (source !== undefined) {
                this.filesystem.copyProject(source, join(path, side));
            }
        }
        return new WrittenJudgeDirectory(path, this.filesystem);
    }
}
