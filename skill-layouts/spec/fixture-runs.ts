// Runs of the pilots, as fixtures: the project they started from, and the diff each one saved, to rebuild its
// working copy from.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'runs');

/** Runs of request 11, which started from the template with the precision fixture: of the eighth pilot, and of the focused round */
const PRECISION_RUNS = [ '89a97301', 'fb87227b', '5a6adab8', 'be977ebc', 'a185af41' ] as const;

/** The focused round's runs of request 9, which started from the template with the calculation-job-results fixture */
export const CALCULATION_JOB_RESULTS_RUNS = [
    '3244ab4d', '6416ca4d', '8752a72e', '8f7df936', '9e3c2bbe', 'ba998d30',
    '295e4dbe', '3364f7ff', 'eb5ca992', '35bc0eb2', '924363f0', 'b002da42',
] as const;

export type FixtureRun = typeof PRECISION_RUNS[number] | typeof CALCULATION_JOB_RESULTS_RUNS[number];

const projectOf = (run: FixtureRun) => (PRECISION_RUNS as readonly string[]).includes(run) ? 'precision-project' : 'calculation-job-results-project';

export const diffOf = (run: FixtureRun) => readFileSync(join(FIXTURES, `${ run }.patch`), 'utf8');

const git = (directory: string, args: string[]) =>
    execFileSync('git', [ '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', ...args ], { cwd: directory, encoding: 'utf8', stdio: 'pipe' });

/** The run's working copy, in a new temporary directory: the project it started from, committed, with its diff applied. */
export function workingCopyOf(run: FixtureRun): string {
    const directory = mkdtempSync(join(tmpdir(), `skill-layouts-${ run }-`));
    cpSync(join(FIXTURES, projectOf(run)), directory, { recursive: true });
    git(directory, [ 'init', '--quiet' ]);
    git(directory, [ 'add', '--all' ]);
    git(directory, [ 'commit', '--quiet', '--message', 'before the run' ]);
    git(directory, [ 'apply', join(FIXTURES, `${ run }.patch`) ]);
    return directory;
}
