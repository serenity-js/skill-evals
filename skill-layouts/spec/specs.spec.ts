import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseArguments, validateSpecs } from '../src/cli.ts';
import { run } from '../src/child-processes.ts';
import { Verdict } from '../src/judging/verdict.ts';
import { gitDirectoryDiff } from '../src/rules.ts';
import { Specs } from '../src/specs.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'specs');
const read = (directory: string) => Specs.read(directory, gitDirectoryDiff(run));

describe('a specs directory', () => {

    describe('as the made-up one has it', () => {

        const specs = read(FIXTURE);

        it('has its cases, with their prompts and definitions', () => {
            const greeting = specs.cases.get('greet-a-visitor')!;

            expect([ ...specs.cases.keys() ]).toEqual([ 'greet-a-visitor' ]);
            expect(greeting.prompt).toBe('Greet each visitor by name, and add a test for it.\n');
            expect(greeting.definition).toEqual({
                kind: 'new feature',
                project: 'greeter',
                rules: [ 'strict-equality', 'descriptive-names' ],
                skills: [ '@example/greetings/writing-greetings/SKILL.md' ],
                apis: [ 'mathjs' ],
            });
            expect(greeting.expected).toBe(join(FIXTURE, 'cases', 'greet-a-visitor', 'expected'));
        });

        it('has its projects, with the fixture copied over the template', () => {
            const greeter = specs.projects.get('greeter')!;

            expect(greeter.definition.template).toEqual({ repository: 'https://github.com/example/greeter-template', commit: '0123456789abcdef0123456789abcdef01234567' });
            expect(greeter.definition.directories).toEqual({ VISITORS_DIR: 'visitors' });
            expect(greeter.fixture).toBe(join(FIXTURE, 'projects', 'greeter', 'fixture'));
        });

        it('has its rules: those patterns score, and those only the judge does', () => {
            const rules = specs.rules;

            expect([ ...rules.keys() ]).toEqual([ 'const-over-let', 'descriptive-names', 'strict-equality' ]);
            expect(rules.get('strict-equality')!.frontmatter).toEqual({
                title: 'values are compared with === and !==, not == and !=',
                source: '@example/greetings/writing-greetings/SKILL.md#comparing-values',
                followsTheProject: 'file',
            });
            expect(rules.get('strict-equality')!.patterns?.canPass()).toBe(true);
            expect(rules.get('descriptive-names')!.patterns).toBeUndefined();
            expect(rules.get('descriptive-names')!.text).toMatch(/^A name of one or two letters/);
        });

        it("has each rule's examples, with the verdict each must get", () => {
            const examples = (rule: string) => specs.rules.get(rule)!.examples.map(example => `${ example.path }: ${ example.expected }`);

            expect(examples('strict-equality')).toEqual([
                'rules/strict-equality/pass/compares-strictly.ts: pass',
                'rules/strict-equality/fail/compares-loosely.ts: fail',
                'rules/strict-equality/fail/in-another-file: fail',
                'rules/strict-equality/n-a/compares-nothing.ts: n/a',
                'rules/strict-equality/n-a/follows-the-file: n/a',
            ]);
            expect(specs.rules.get('descriptive-names')!.examples.map(example => example.expected)).toEqual([ Verdict.pass, Verdict.fail ]);
        });

        it('is valid, with every pattern rule getting the verdict each of its examples says', () => {
            expect(specs.validate()).toEqual([]);
        });
    });

    describe('when something is wrong', () => {

        let root: string;
        const path = (file: string) => join(root, file);
        const write = (file: string, content: string) => {
            mkdirSync(dirname(path(file)), { recursive: true });
            writeFileSync(path(file), content);
        };
        const edit = (file: string, change: (content: string) => string) => writeFileSync(path(file), change(readFileSync(path(file), 'utf8')));
        const editJson = (file: string, change: (json: Record<string, unknown>) => void) => edit(file, content => {
            const json = JSON.parse(content);
            change(json);
            return JSON.stringify(json);
        });
        const CASE = 'cases/greet-a-visitor';
        const CASE_JSON = `${ CASE }/case.json`;

        beforeEach(() => {
            root = mkdtempSync(join(tmpdir(), 'skill-layouts-specs-'));
            cpSync(FIXTURE, root, { recursive: true });
        });

        afterEach(() => {
            rmSync(root, { recursive: true, force: true });
        });

        it.each<[ string, () => void, string[] ]>([
            [ 'a top-level directory is missing', () => rmSync(path('projects'), { recursive: true }), [
                'projects/ is missing: a specs directory has cases/, rules/ and projects/',
                `${ CASE_JSON }: project is "greeter", which isn't in projects/`,
            ] ],
            [ 'a case has no prompt', () => rmSync(path(`${ CASE }/prompt.md`)), [
                `${ CASE }/prompt.md is missing`,
            ] ],
            [ 'a case has something else', () => write(`${ CASE }/notes.md`, ''), [
                `${ CASE }/notes.md isn't part of a case, which holds prompt.md, case.json and expected/`,
            ] ],
            [ "a case's expected/ is a file", () => {
                rmSync(path(`${ CASE }/expected`), { recursive: true });
                write(`${ CASE }/expected`, '');
            }, [
                `${ CASE }/expected is a file, not a directory`,
            ] ],
            [ "a case's prompt.md is a directory", () => {
                rmSync(path(`${ CASE }/prompt.md`));
                mkdirSync(path(`${ CASE }/prompt.md`));
            }, [
                `${ CASE }/prompt.md is a directory, not a file`,
            ] ],
            [ "a project's project.json is a directory", () => {
                rmSync(path('projects/greeter/project.json'));
                mkdirSync(path('projects/greeter/project.json'));
            }, [
                'projects/greeter/project.json is a directory, not a file',
            ] ],
            [ "a rule's README.md is a directory", () => {
                rmSync(path('rules/descriptive-names/README.md'));
                mkdirSync(path('rules/descriptive-names/README.md'));
            }, [
                'rules/descriptive-names/README.md is a directory, not a file',
            ] ],
            [ "a rule's rule.yml is a directory", () => {
                rmSync(path('rules/strict-equality/rule.yml'));
                mkdirSync(path('rules/strict-equality/rule.yml'));
            }, [
                'rules/strict-equality/rule.yml is a directory, not a file',
            ] ],
            [ "a rule's pass/ is a file", () => {
                rmSync(path('rules/descriptive-names/pass'), { recursive: true });
                write('rules/descriptive-names/pass', '');
            }, [
                'rules/descriptive-names/pass is a file, not a directory',
                'rules/descriptive-names has no pass/ example: every rule has at least one pass/ and one fail/',
            ] ],
            [ "a judged rule's directory example has after as a file", () => {
                rmSync(path('rules/descriptive-names/fail/one-letter-names/after'), { recursive: true });
                write('rules/descriptive-names/fail/one-letter-names/after', '');
            }, [
                'rules/descriptive-names/fail/one-letter-names/after is a file, not a directory',
            ] ],
            [ "a directory example's reply.md is a directory", () => {
                rmSync(path('rules/descriptive-names/fail/one-letter-names/reply.md'));
                mkdirSync(path('rules/descriptive-names/fail/one-letter-names/reply.md'));
            }, [
                'rules/descriptive-names/fail/one-letter-names/reply.md is a directory, not a file',
            ] ],
            [ 'cases/ holds a file', () => write('cases/README.md', ''), [
                "cases/README.md isn't a case: cases/ holds a directory for each",
            ] ],
            [ "case.json isn't JSON", () => write(CASE_JSON, '{ "kind": '), [
                expect.stringMatching(new RegExp(`^${ CASE_JSON } isn't JSON: `)),
            ] ],
            [ 'case.json has wrong fields', () => editJson(CASE_JSON, json => {
                json.kind = 7;
                json.apis = [ 'weather' ];
                json.skills = [ 'SKILL.md' ];
                json.rule = 'strict-equality';
            }), [
                `${ CASE_JSON }: kind is 7, not a string`,
                `${ CASE_JSON }: skills[0] is "SKILL.md", not a skill file, as <package>/<skill>/<path>`,
                `${ CASE_JSON }: apis[0] is "weather", not one of mathjs, frankfurter`,
                `${ CASE_JSON }: rule isn't a field it takes: kind, project, rules, skills, apis`,
            ] ],
            [ 'case.json names a project and a rule there are none of', () => editJson(CASE_JSON, json => {
                json.project = 'shop';
                json.rules = [ 'strict-equality', 'no-semicolons' ];
            }), [
                `${ CASE_JSON }: project is "shop", which isn't in projects/`,
                `${ CASE_JSON }: rules[1] is "no-semicolons", which isn't in rules/`,
            ] ],
            [ 'a reference solution has two markers', () => edit(`${ CASE }/expected/src/greeting.ts`, content => content.replace("'Hello!'", "'Hello!'    // wrong: 'Hello!' => 'Hi!'")), [
                `${ CASE }/expected has 2 markers of its expected value, and may have one at most`,
            ] ],
            [ "a marker's value isn't on its line", () => edit(`${ CASE }/expected/spec/greeting.spec.ts`, content => content.replace("wrong: 'Hello, Ada!'", "wrong: 'Hello, Alan!'")), [
                `${ CASE }/expected/spec/greeting.spec.ts:7: the marker makes 'Hello, Alan!' wrong, but the code on its line doesn't have 'Hello, Alan!'`,
            ] ],
            [ "project.json's fields are wrong", () => editJson('projects/greeter/project.json', json => {
                delete (json.template as Record<string, unknown>).commit;
                json.directories = { VISITORS_DIR: 1 };
            }), [
                'projects/greeter/project.json: template.commit is missing',
                'projects/greeter/project.json: directories.VISITORS_DIR is 1, not a string',
            ] ],
            [ 'a project has no project.json', () => rmSync(path('projects/greeter/project.json')), [
                'projects/greeter/project.json is missing',
            ] ],
            [ 'a rule has no README', () => rmSync(path('rules/descriptive-names/README.md')), [
                'rules/descriptive-names/README.md is missing',
            ] ],
            [ 'a rule has something else', () => write('rules/descriptive-names/check.ts', ''), [
                "rules/descriptive-names/check.ts isn't part of a rule, which holds README.md, rule.yml, applies.yml, pass/, fail/ and n-a/",
            ] ],
            [ 'a README has no frontmatter', () => write('rules/descriptive-names/README.md', 'Names say what a value is for.\n'), [
                'rules/descriptive-names/README.md has no frontmatter: it starts with a line of ---, then the title and the source, then ---',
            ] ],
            [ "a README's frontmatter is wrong", () => edit('rules/strict-equality/README.md', content => content.replace('followsTheProject: file', 'followsTheProject: repository\nowner: me')), [
                'rules/strict-equality/README.md: followsTheProject is "repository", not one of file, project',
                "rules/strict-equality/README.md: owner isn't a field it takes: title, source, followsTheProject",
            ] ],
            [ "a README's source isn't a skill's section", () => edit('rules/strict-equality/README.md', content => content.replace('SKILL.md#comparing-values', 'SKILL.md')), [
                'rules/strict-equality/README.md: source is "@example/greetings/writing-greetings/SKILL.md", not a section of a skill file, as <package>/<skill>/<path>#<section>',
            ] ],
            [ 'a judged rule follows the project', () => edit('rules/descriptive-names/README.md', content => content.replace('title:', 'followsTheProject: file\ntitle:')), [
                "rules/descriptive-names/README.md: followsTheProject only applies to a rule.yml's violations, and the rule has no rule.yml",
            ] ],
            [ "rule.yml isn't what the harness takes", () => edit('rules/strict-equality/rule.yml', content => content
                .replace('id: strict-equality', 'id: loose-equality')
                .replace('language: TypeScript', 'language: JavaScript\nfix: $A === $B')), [
                'rules/strict-equality/rule.yml: id is "loose-equality", not strict-equality, the rule\'s directory',
                'rules/strict-equality/rule.yml: language is "JavaScript", not TypeScript',
                "rules/strict-equality/rule.yml: fix isn't allowed: a rule finds code, and changes none",
            ] ],
            [ "rule.yml isn't YAML", () => write('rules/strict-equality/rule.yml', 'id: [ strict-equality\n'), [
                expect.stringMatching(/^rules\/strict-equality\/rule\.yml isn't YAML: /),
            ] ],
            [ "ast-grep can't use a rule", () => edit('rules/strict-equality/applies.yml', content => content.replace('kind: binary_expression', 'kind: binary_expresion')), [
                expect.stringMatching(/^rules\/strict-equality\/applies\.yml: ast-grep can't use its rule: .*Kind `binary_expresion` is invalid/),
            ] ],
            [ "applies.yml's id isn't the rule's", () => edit('rules/strict-equality/applies.yml', content => content.replace('strict-equality.applies', 'strict-equality')), [
                'rules/strict-equality/applies.yml: id is "strict-equality", not strict-equality.applies, the rule\'s directory and .applies',
            ] ],
            [ 'applies.yml has no rule.yml', () => write('rules/descriptive-names/applies.yml', 'id: descriptive-names.applies\nlanguage: TypeScript\nrule:\n  kind: identifier\n'), [
                'rules/descriptive-names/applies.yml has no rule.yml next to it, whose violations it says where the rule applies',
            ] ],
            [ 'a rule has no fail/ example', () => rmSync(path('rules/descriptive-names/fail'), { recursive: true }), [
                'rules/descriptive-names has no fail/ example: every rule has at least one pass/ and one fail/',
            ] ],
            [ "an example isn't one", () => write('rules/descriptive-names/pass/notes.md', ''), [
                "rules/descriptive-names/pass/notes.md isn't an example: one is a .ts file, or a directory with after/",
            ] ],
            [ 'a directory example has no after/', () => rmSync(path('rules/descriptive-names/fail/one-letter-names/after'), { recursive: true }), [
                'rules/descriptive-names/fail/one-letter-names/after is missing',
            ] ],
            [ 'a directory example has something else', () => write('rules/descriptive-names/fail/one-letter-names/notes.md', ''), [
                "rules/descriptive-names/fail/one-letter-names/notes.md isn't part of an example, which holds before/, after/, request.md and reply.md",
            ] ],
            [ "a pattern rule's example gets another verdict", () => write('rules/strict-equality/pass/compares-strictly.ts', "export const isAnonymous = (name: string) => name != '';\n"), [
                "rules/strict-equality/pass/compares-strictly.ts: the rule's verdict is fail, from compares-strictly.ts:1: name != '', not pass",
            ] ],
            [ 'a rule without applies.yml has a pass/ example', () => rmSync(path('rules/strict-equality/applies.yml')), [
                "rules/strict-equality/pass/compares-strictly.ts: the rule's verdict is n/a, not pass; without applies.yml, the rule can't pass",
            ] ],
        ])('%s', (_, breakIt, problems) => {
            breakIt();

            expect(read(root).validate()).toEqual(problems);
        });

        it('lists every problem, in every file', () => {
            editJson(CASE_JSON, json => {
                json.kind = 7;
            });
            rmSync(path('rules/descriptive-names/README.md'));
            renameSync(path('rules/const-over-let/fail'), path('rules/const-over-let/pass/more'));

            expect(read(root).validate()).toEqual([
                `${ CASE_JSON }: kind is 7, not a string`,
                "rules/const-over-let/pass/more isn't an example: one is a .ts file, or a directory with after/",
                'rules/const-over-let has no fail/ example: every rule has at least one pass/ and one fail/',
                'rules/descriptive-names/README.md is missing',
            ]);
        });

        it('reads a README with Windows line endings, as a checkout with core.autocrlf has it', () => {
            edit('rules/strict-equality/README.md', content => content.replaceAll('\n', '\r\n'));

            const specs = read(root);

            expect(specs.validate()).toEqual([]);
            expect(specs.rules.get('strict-equality')!.frontmatter?.followsTheProject).toBe('file');
        });

        it("isn't judged: a judged rule's examples are only checked to be there", () => {
            write('rules/descriptive-names/pass/one-letter.ts', 'export const g = 1;\n');

            expect(read(root).validate()).toEqual([]);
        });
    });

    describe('--validate', () => {

        it('takes the specs directory, and nothing else: no results, template or checkout', () => {
            expect(parseArguments([ '--validate', '--specs', 'specs' ], '/work')).toMatchObject({ validateOnly: true, specs: '/work/specs' });
            expect(() => parseArguments([ '--validate' ], '/work')).toThrow('--validate and --specs <dir> go together');
            expect(() => parseArguments([ '--specs', 'specs', '--out', '/out' ], '/work')).toThrow('--validate and --specs <dir> go together');
            expect(() => parseArguments([ '--validate', '--specs', 'specs', '--pilot' ], '/work')).toThrow(/usage/);
        });

        it('says what it checked, when the specs are valid', () => {
            const logged: string[] = [];

            validateSpecs(FIXTURE, message => logged.push(message));

            expect(logged).toEqual([ `${ FIXTURE } is valid: 1 case, 1 project and 3 rules, with the patterns' 8 examples checked` ]);
        });

        it('fails with every problem, each with its file', () => {
            const root = mkdtempSync(join(tmpdir(), 'skill-layouts-validate-'));
            try {
                cpSync(FIXTURE, root, { recursive: true });
                rmSync(join(root, 'rules', 'descriptive-names', 'README.md'));
                rmSync(join(root, 'cases', 'greet-a-visitor', 'prompt.md'));

                expect(() => validateSpecs(root, () => undefined)).toThrow([
                    `${ root } has 2 problems:`,
                    '  cases/greet-a-visitor/prompt.md is missing',
                    '  rules/descriptive-names/README.md is missing',
                ].join('\n'));
            }
            finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
});
