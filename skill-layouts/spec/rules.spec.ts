import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { run } from '../src/child-processes.ts';
import { Verdict } from '../src/judging/verdict.ts';
import { Change, Example, gitDirectoryDiff, RulePatterns } from '../src/rules.ts';

const LOOSE = { rule: { kind: 'binary_expression', has: { field: 'operator', regex: '^(==|!=)$' } } };
const STRICT = { rule: { kind: 'binary_expression', has: { field: 'operator', regex: '^(===|!==)$' } } };

/** A file the change touched, with the 1-based lines it added */
const changed = (path: string, lines: string[], added: number[]) => ({ path, content: lines.join('\n'), addedLines: new Set(added) });

describe('rules', () => {

    describe('RulePatterns', () => {

        const equality = RulePatterns.of({ violations: LOOSE, applies: STRICT });

        it('fails a change that adds a violation, with the line it rests on', () => {
            const verdict = equality.verdictOn(Change.ofNewFile('src/names.ts', "export const isBlank = (name: string) => name == '';\n"));

            expect(verdict.verdict).toBe(Verdict.fail);
            expect(verdict.evidence).toEqual([ "src/names.ts:1: name == ''" ]);
        });

        it('passes a change that adds code the rule applies to, and no violation', () => {
            const verdict = equality.verdictOn(Change.ofNewFile('src/names.ts', "export const isBlank = (name: string) => name === '';\n"));

            expect(verdict.verdict).toBe(Verdict.pass);
            expect(verdict.evidence).toEqual([ "src/names.ts:1: name === ''" ]);
        });

        it('fails a change that adds both, since a violation anywhere fails the rule', () => {
            const verdict = equality.verdictOn(Change.ofNewFile('src/names.ts', [ "const a = (name: string) => name === '';", "const b = (name: string) => name != '';" ].join('\n')));

            expect(verdict.verdict).toBe(Verdict.fail);
            expect(verdict.evidence).toEqual([ "src/names.ts:2: name != ''" ]);
        });

        it("scores only the lines the change added, so a violation it didn't add leaves the rule n/a", () => {
            const verdict = equality.verdictOn(Change.of([ changed('src/names.ts', [ "const a = (name: string) => name == '';", 'const b = 1;' ], [ 2 ]) ]));

            expect(verdict.verdict).toBe(Verdict.notApplicable);
            expect(verdict.evidence).toEqual([]);
        });

        it('only looks at TypeScript files', () => {
            expect(equality.verdictOn(Change.ofNewFile('notes.md', "name == ''")).verdict).toBe(Verdict.notApplicable);
        });

        it("takes ast-grep's utils and constraints, as rule.yml has them", () => {
            const letDeclarations = RulePatterns.of({
                violations: {
                    rule: { matches: 'declaration' },
                    utils: { declaration: { kind: 'lexical_declaration', has: { kind: 'variable_declarator', has: { field: 'name', pattern: '$NAME' } } } },
                    constraints: { NAME: { regex: '^tmp' } },
                },
                applies: { rule: { kind: 'lexical_declaration', regex: '^const\\s' } },
            });

            expect(letDeclarations.verdictOn(Change.ofNewFile('a.ts', 'let tmpName = 1;')).verdict).toBe(Verdict.fail);
            expect(letDeclarations.verdictOn(Change.ofNewFile('a.ts', 'let name = 1;')).verdict).toBe(Verdict.notApplicable);
        });

        describe('with followsTheProject: file', () => {

            const followingTheFile = RulePatterns.of({ violations: LOOSE, applies: STRICT, followsTheProject: 'file' });

            it("doesn't count a violation added to a file that already has one", () => {
                const change = Change.of([ changed('src/names.ts', [ "const a = (name: string) => name == '';", "const b = (name: string) => name == 'x';" ], [ 2 ]) ]);

                expect(followingTheFile.verdictOn(change).verdict).toBe(Verdict.notApplicable);
                expect(equality.verdictOn(change).verdict).toBe(Verdict.fail);
            });

            it('counts a violation added to another file', () => {
                const change = Change.of([
                    changed('src/names.ts', [ "const a = (name: string) => name == '';", 'const b = 1;' ], [ 2 ]),
                    changed('src/visitors.ts', [ "const c = (name: string) => name == '';" ], [ 1 ]),
                ]);

                expect(followingTheFile.verdictOn(change).evidence).toEqual([ "src/visitors.ts:1: name == ''" ]);
            });
        });

        describe('with followsTheProject: project', () => {

            const followingTheProject = RulePatterns.of({ violations: LOOSE, applies: STRICT, followsTheProject: 'project' });

            it("doesn't count a violation when a file had one before the change", () => {
                const change = Change.of(
                    [ changed('src/visitors.ts', [ "const c = (name: string) => name == '';" ], [ 1 ]) ],
                    [ { path: 'src/names.ts', content: "const a = (name: string) => name == '';" } ],
                );

                expect(followingTheProject.verdictOn(change).verdict).toBe(Verdict.notApplicable);
            });

            it("doesn't count a violation when a changed file has one on a line the change didn't add", () => {
                const change = Change.of([
                    changed('src/names.ts', [ "const a = (name: string) => name == '';", 'const b = 1;' ], [ 2 ]),
                    changed('src/visitors.ts', [ "const c = (name: string) => name == '';" ], [ 1 ]),
                ]);

                expect(followingTheProject.verdictOn(change).verdict).toBe(Verdict.notApplicable);
            });

            it('counts a violation in a project that had none', () => {
                const change = Change.of(
                    [ changed('src/visitors.ts', [ "const c = (name: string) => name == '';" ], [ 1 ]) ],
                    [ { path: 'src/names.ts', content: "const a = (name: string) => name === '';" }, { path: 'notes.md', content: "name == ''" } ],
                );

                expect(followingTheProject.verdictOn(change).verdict).toBe(Verdict.fail);
            });
        });

        it('says what it decided, and from which line', () => {
            expect(equality.verdictOn(Change.ofNewFile('a.ts', "x == ''")).toString()).toBe("fail, from a.ts:1: x == ''");
            expect(equality.verdictOn(Change.ofNewFile('a.ts', 'x;')).toString()).toBe('n/a');
        });
    });

    describe('Example', () => {

        let root: string;
        const write = (path: string, content: string) => {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), content);
        };

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-rules-'));
        });

        afterEach(() => {
            rmSync(root, { recursive: true, force: true });
        });

        const diff = gitDirectoryDiff(run);

        it('is all added lines when it is a single file, with nothing before it', () => {
            write('fail/loose.ts', "const a = 1;\nconst b = a == 1;\n");

            const change = Example.at(join(root, 'fail/loose.ts'), 'fail/loose.ts', Verdict.fail).changeWith(diff);

            expect(change.files).toEqual([ { path: 'loose.ts', content: "const a = 1;\nconst b = a == 1;\n", addedLines: new Set([ 1, 2 ]) } ]);
            expect(change.before).toEqual([]);
        });

        it("is the lines after/ added to before/, with before/'s files as the project before the change", () => {
            write('n-a/x/before/src/names.ts', 'const a = 1;\nconst b = 2;\n');
            write('n-a/x/after/src/names.ts', 'const a = 1;\nconst added = 3;\nconst b = 2;\n');
            write('n-a/x/after/src/visitors.ts', 'const c = 4;\n');
            write('n-a/x/before/src/removed.ts', 'const d = 5;\n');

            const change = Example.at(join(root, 'n-a/x'), 'n-a/x', Verdict.notApplicable).changeWith(diff);

            expect(change.files).toEqual([
                { path: 'src/names.ts', content: 'const a = 1;\nconst added = 3;\nconst b = 2;\n', addedLines: new Set([ 2 ]) },
                { path: 'src/visitors.ts', content: 'const c = 4;\n', addedLines: new Set([ 1 ]) },
            ]);
            expect(change.before.map(file => file.path)).toEqual([ 'src/names.ts', 'src/removed.ts' ]);
        });

        it('names its files as they are, whatever characters they have', () => {
            write('fail/x/before/src/café.ts', 'const a = 1;\n');
            write('fail/x/after/src/café.ts', 'const a = 1;\nconst b = 2;\n');
            write('fail/x/after/src/a "quoted" name.ts', 'const c = 3;\n');

            const change = Example.at(join(root, 'fail/x'), 'fail/x', Verdict.fail).changeWith(diff);

            expect(change.files.map(file => [ file.path, [ ...file.addedLines ] ])).toEqual([ [ 'src/a "quoted" name.ts', [ 1 ] ], [ 'src/café.ts', [ 2 ] ] ]);
        });

        it('is all added lines when it has no before/', () => {
            write('pass/x/after/src/names.ts', 'const a = 1;');

            const change = Example.at(join(root, 'pass/x'), 'pass/x', Verdict.pass).changeWith(diff);

            expect(change.files).toEqual([ { path: 'src/names.ts', content: 'const a = 1;', addedLines: new Set([ 1 ]) } ]);
        });
    });
});
