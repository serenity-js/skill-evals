import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkPlan, planOf } from '../src/cli.ts';
import type { PlannedRun } from '../src/review.ts';

describe('planOf', () => {

    let results: string;

    beforeEach(() => {
        results = mkdtempSync(join(tmpdir(), 'skill-layouts-plan-'));
    });
    afterEach(() => rmSync(results, { recursive: true, force: true }));

    const keysOf = (planned: PlannedRun[]) => planned.map(({ agent, layout, request }) => `${ agent } ${ layout } ${ request }`).sort();

    it("plans a pilot of other layouts and requests, and keeps the plan in the --out's mapping.json", () => {
        const planned = planOf({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, results);

        expect(keysOf(planned)).toEqual([
            'copilot a 11-add-to-messy-code', 'copilot a 9-new-interface', 'copilot c 11-add-to-messy-code', 'copilot c 9-new-interface',
            'kiro a 11-add-to-messy-code', 'kiro a 9-new-interface', 'kiro c 11-add-to-messy-code', 'kiro c 9-new-interface',
        ]);
        expect(JSON.parse(readFileSync(join(results, 'mapping.json'), 'utf8'))).toEqual(planned);
    });

    it('resumes the same plan, with the same run IDs', () => {
        const planned = planOf({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, results);

        expect(planOf({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, results)).toEqual(planned);
    });

    it("checks an --out's plan without writing one, so a check that fails later leaves no plan behind", () => {
        expect(() => checkPlan({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, results)).not.toThrow();
        expect(() => readFileSync(join(results, 'mapping.json'))).toThrow(/ENOENT/);
    });

    it('refuses an --out planned with other layouts or requests, before the evaluation checks anything else or prepares anything', () => {
        const out = join(results, 'out');
        mkdirSync(join(out, 'pilot'), { recursive: true });
        planOf({ mode: 'pilot' }, join(out, 'pilot'));

        // no agent's credentials, and no serenity-js clone, which would stop the evaluation if it checked them first
        const refused = (() => {
            try {
                execFileSync(process.execPath, [ join(import.meta.dirname, '..', 'src', 'cli.ts'), '--pilot', '--layouts', 'a,c', '--requests', '9,11', '--serenity-js', join(results, 'no-clone'), '--out', out, '--work', join(results, 'work') ], { env: { PATH: process.env.PATH }, stdio: 'pipe', encoding: 'utf8' });
                return '';
            }
            catch (error) {
                return String((error as { stderr?: string }).stderr);
            }
        })();

        expect(refused).toContain('this --out was planned with layouts none, b and requests 5, 6, 9, 11, not layouts a, c and requests 9, 11: pass another --out');
    });

    it('refuses to resume an --out planned with its runs repeated another number of times, and says how many', () => {
        planOf({ mode: 'pilot', layouts: [ 'a' ], requests: [ '9' ] }, results);

        expect(() => planOf({ mode: 'pilot', layouts: [ 'a' ], requests: [ '9' ], repeats: 3 }, results))
            .toThrow(/^this --out was planned with layouts a and requests 9, not layouts a and requests 9, 3 times each: pass another --out$/);
    });

    it('refuses to resume an --out planned with other layouts or requests, since that is a different plan', () => {
        planOf({ mode: 'pilot' }, results);

        expect(() => planOf({ mode: 'pilot', layouts: [ 'a', 'c' ], requests: [ '9', '11' ] }, results))
            .toThrow(/^this --out was planned with layouts none, b and requests 5, 6, 9, 11, not layouts a, c and requests 9, 11: pass another --out$/);
    });
});
