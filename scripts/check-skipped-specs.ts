// Fails when vitest skipped a spec it shouldn't have, reading its JSON report rather than its console output.
//
//   node scripts/check-skipped-specs.ts <report.json> [--may-skip <describe path>]...
//
// Without --may-skip, no spec may be skipped: on macOS, every spec runs, including those under sandbox-exec. With it,
// only the specs under that describe path, such as "sandboxed > under sandbox-exec" on Linux, may be.
import { readFileSync } from 'node:fs';

interface Report {
    numTotalTests: number;
    testResults: Array<{ name: string, assertionResults: Array<{ ancestorTitles: string[], title: string, status: string }> }>;
}

const [ file, ...options ] = process.argv.slice(2);
const allowed: string[] = [];
for (let index = 0; index < options.length; index++) {
    if (options[index] !== '--may-skip' || ! options[index + 1]) {
        throw new Error('usage: check-skipped-specs.ts <report.json> [--may-skip <describe path>]...');
    }
    allowed.push(options[++index]);
}

const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
const specs = report.testResults.flatMap(result => result.assertionResults.map(spec => ({
    file: result.name,
    describe: spec.ancestorTitles.join(' > '),
    name: [ ...spec.ancestorTitles, spec.title ].join(' > '),
    status: spec.status,
})));
if (specs.length === 0 || specs.length !== report.numTotalTests) {
    throw new Error(`${ file } lists ${ specs.length } specs, but vitest counted ${ report.numTotalTests }`);
}

const isUnder = (describe: string, path: string) => describe === path || describe.startsWith(`${ path } > `);
const skipped = specs.filter(spec => spec.status !== 'passed' && spec.status !== 'failed');
const unexpected = skipped.filter(spec => ! allowed.some(path => isUnder(spec.describe, path)));

console.log(`${ specs.length } specs, ${ skipped.length } skipped${ allowed.length > 0 ? `, which may only be under: ${ allowed.join('; ') }` : ', and none may be' }`);
for (const spec of skipped) {
    console.log(`  ${ unexpected.includes(spec) ? 'not allowed' : 'allowed' }: ${ spec.name } (${ spec.status })`);
}
if (unexpected.length > 0) {
    console.error(`${ unexpected.length } spec(s) skipped that should have run`);
    process.exitCode = 1;
}
