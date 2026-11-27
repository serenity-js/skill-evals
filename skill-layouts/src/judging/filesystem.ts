// The filesystem operations judging/ uses, as one interface, so each class is given the ones it needs at construction,
// and the command line chooses the real ones. Every path is absolute, or relative to the process's directory.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Filesystem {
    /** A file's contents, or undefined when there's no such file */
    readFile(path: string): string | undefined;
    /** Writes a file, with the directories it's in */
    writeFile(path: string, content: string): void;
    /** Makes a directory, with the directories it's in; one that's there already stays as it is */
    makeDirectory(path: string): void;
    /** Removes a file or a directory, with everything in it; one that isn't there is fine */
    remove(path: string): void;
    exists(path: string): boolean;
    /** Copies a directory, with everything in it that `include` takes, or everything without it */
    copy(from: string, to: string, include?: (path: string) => boolean): void;
    /** A new, empty directory of its own, in the system's temporary directory, whose name starts with `prefix` */
    makeTemporaryDirectory(prefix: string): string;
}

/** Writes `value` as the harness writes every JSON file: indented by two spaces, with a final newline. */
export function writeJsonTo(filesystem: Pick<Filesystem, 'writeFile'>, path: string, value: unknown): void {
    filesystem.writeFile(path, `${ JSON.stringify(value, null, 2) }\n`);
}

/** The filesystem, as Node.js has it */
export function nodeFilesystem(): Filesystem {
    return {
        readFile: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
        writeFile: (path, content) => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        },
        makeDirectory: path => {
            mkdirSync(path, { recursive: true });
        },
        remove: path => rmSync(path, { recursive: true, force: true }),
        exists: path => existsSync(path),
        copy: (from, to, include) => cpSync(from, to, { recursive: true, ...(include ? { filter: include } : {}) }),
        makeTemporaryDirectory: prefix => mkdtempSync(join(tmpdir(), prefix)),
    };
}
