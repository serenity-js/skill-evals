// Where the judge works: a directory per session, with what it's given written into it. JudgeWorkspace is the only
// code that writes a judge's inputs, with the filesystem operations it's constructed with.
import { join } from 'node:path';

import type { JudgeBrief } from './brief.ts';
import type { Filesystem } from './filesystem.ts';
import { JudgeVerdicts } from './rule-verdict.ts';

/** The file the judge writes its verdicts to, in its directory */
export const VERDICTS_FILE = 'verdicts.json';

/** The filesystem operations a workspace needs */
export type WorkspaceFilesystem = Pick<Filesystem, 'writeFile' | 'copy' | 'readFile' | 'remove'>;

/** The project's files, without anything the harness or git put there. */
const isProjectFile = (source: string) => ! source.split(/[/\\]/).some(part => part === '.git' || part === 'node_modules');

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
                this.filesystem.copy(source, join(path, side), isProjectFile);
            }
        }
        return new WrittenJudgeDirectory(path, this.filesystem);
    }
}
