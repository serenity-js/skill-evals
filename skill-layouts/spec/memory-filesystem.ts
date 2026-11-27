// A filesystem in memory, for the specs of the classes that only read and write files through the operations they're
// given: files by their paths, with a directory as a path its files' paths start with.
import type { Filesystem } from '../src/judging/filesystem.ts';

export class MemoryFilesystem implements Filesystem {

    readonly files = new Map<string, string>();
    private readonly directories = new Set<string>();
    private temporary = 0;

    readFile(path: string): string | undefined {
        return this.files.get(path);
    }

    writeFile(path: string, content: string): void {
        this.files.set(path, content);
    }

    makeDirectory(path: string): void {
        this.directories.add(path);
    }

    remove(path: string): void {
        for (const file of [ ...this.files.keys() ].filter(file => file === path || file.startsWith(`${ path }/`))) {
            this.files.delete(file);
        }
        for (const directory of [ ...this.directories ].filter(directory => directory === path || directory.startsWith(`${ path }/`))) {
            this.directories.delete(directory);
        }
    }

    exists(path: string): boolean {
        return this.files.has(path) || this.directories.has(path) || [ ...this.files.keys() ].some(file => file.startsWith(`${ path }/`));
    }

    /** Copies `from`'s files and directories, empty ones included, as nodeFilesystem's copy does */
    copy(from: string, to: string, include: (path: string) => boolean = () => true): void {
        const isIn = (path: string) => (path === from || path.startsWith(`${ from }/`)) && include(path);
        const copied = (path: string) => `${ to }${ path.slice(from.length) }`;
        for (const directory of [ ...this.directories ].filter(isIn)) {
            this.directories.add(copied(directory));
        }
        for (const [ file, content ] of [ ...this.files ].filter(([ file ]) => isIn(file))) {
            this.files.set(copied(file), content);
        }
    }

    makeTemporaryDirectory(prefix: string): string {
        const directory = `/tmp/${ prefix }${ ++this.temporary }`;
        this.directories.add(directory);
        return directory;
    }
}
