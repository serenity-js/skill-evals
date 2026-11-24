import { Ability } from '@serenity-js/core';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensure, isNotBlank } from 'tiny-types';

/**
 * Lets an actor read and write the files the calculation jobs service exchanges: it writes job files to the
 * directory the service picks them up from, and reads the result files the service writes.
 */
export class UseJobFiles extends Ability {
    static in(jobsDirectory: string, resultsDirectory: string): UseJobFiles {
        return new UseJobFiles(jobsDirectory, resultsDirectory);
    }

    constructor(private readonly jobsDirectory: string, private readonly resultsDirectory: string) {
        super();
        ensure('jobsDirectory', jobsDirectory, isNotBlank());
        ensure('resultsDirectory', resultsDirectory, isNotBlank());
    }

    writeJob(name: string, expression: string): Promise<void> {
        return writeFile(join(this.jobsDirectory, name), expression);
    }

    /** The contents of the result file `name`, or `undefined` while the service hasn't written it. */
    async readResult(name: string): Promise<string | undefined> {
        const path = join(this.resultsDirectory, name);
        return existsSync(path) ? readFile(path, 'utf8') : undefined;
    }
}
