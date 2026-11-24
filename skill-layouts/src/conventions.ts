// The conventions checklist, and what AST patterns can decide about each item in the code a run added.
// A reviewer scores the same checklist for what the patterns can't decide, such as whether a task is named in the
// business domain; see review.ts.
import { posix } from 'node:path';

import { Lang, parse, type SgNode } from '@ast-grep/napi';

/** Who scores an item: the AST patterns, which the reviewer may overrule, or the reviewer only. */
export type ScoredBy = 'patterns' | 'reviewer';

/**
 * Defines a checklist item, so that the requests it names are checked for being requests of the evaluation, in
 * conventions.spec.ts, and its id stays a literal type.
 */
const item = <Id extends string>(definition: { id: Id, practice: string, scoredBy: ScoredBy, text: string, requests: string[] }) => definition;

/**
 * The checklist, built from the practices of the skills: 1 to 9 in @serenity-js/core's skills, and M1 to M7 in the
 * Mocha draft. Each item names the requests whose right answer exercises it; practices no request exercises, like
 * M7, no state shared between scenarios, or practice 8's interaction objects, have no item.
 */
export const CHECKLIST = [
    item({ id: 'actor-names', practice: '1', scoredBy: 'patterns',
        text: "the actors a change introduces are named after the role they play, from an enum or constants, not with a string in each scenario; a scenario added to a project that names its actors with strings, and follows it, is n/a",
        requests: [ '1-new-feature', '4-new-http-api', '9-new-interface', '10-check-each', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'one-action', practice: '2', scoredBy: 'reviewer',
        text: "an interaction is one action from the actor's point of view; steps that make sense apart are separate interactions, composed in a task",
        requests: [ '9-new-interface' ] }),
    item({ id: 'integrations-first', practice: '2', scoredBy: 'reviewer',
        text: 'uses the interactions and abilities the Serenity/JS modules provide before writing its own',
        requests: [ '1-new-feature', '2-step-that-does-several-things', '4-new-http-api', '6-duplication', '10-check-each', '11-add-to-messy-code', '13-new-feature' ] }),
    item({ id: 'clients-through-abilities', practice: '2', scoredBy: 'patterns',
        text: 'interactions and questions reach the system through an ability retrieved with Ability.as(actor), never through fs, fetch, axios, http or https directly',
        requests: [ '9-new-interface' ] }),
    item({ id: 'answerable-parameters', practice: '3', scoredBy: 'patterns',
        text: "every parameter of a task, an interaction or a question, and of the constructor of an interaction object, is Answerable<T>, so that a caller can pass a question as easily as a static value; an Answerable placed in an array or an object literal passed on as data fails it, unless it's wrapped in Question.fromObject or Question.fromArray, or answered inside a Question.about",
        requests: [ '2-step-that-does-several-things', '3-check-a-value', '6-duplication', '7-rename-a-concept', '9-new-interface', '11-add-to-messy-code' ] }),
    item({ id: 'answering', practice: '3', scoredBy: 'patterns',
        text: 'interactions and questions answer each Answerable into a constant, with await actor.answer(), rather than inline or in a chain of then calls',
        requests: [ '3-check-a-value', '9-new-interface' ] }),
    item({ id: 'names-without-the', practice: '4', scoredBy: 'patterns',
        text: 'the names of activities and questions leave out "the"; a name added to a file whose names have "the", and that follows them, is n/a',
        requests: [ '2-step-that-does-several-things', '3-check-a-value', '6-duplication', '7-rename-a-concept', '9-new-interface', '11-add-to-messy-code', '12-check-a-value' ] }),
    item({ id: 'question-names', practice: '4', scoredBy: 'reviewer',
        text: 'questions are named with nouns, and those with a yes-or-no answer as isX()',
        requests: [ '3-check-a-value', '9-new-interface', '12-check-a-value' ] }),
    item({ id: 'grouping', practice: '4', scoredBy: 'reviewer',
        text: 'questions and tasks about the same thing are grouped under one object, once more than one task or spec needs them',
        requests: [ '9-new-interface' ] }),
    item({ id: 'repeating', practice: '5', scoredBy: 'patterns',
        text: 'activities repeated for each item of a list use List.of(…).forEach, not Array.forEach with an async callback',
        requests: [ '10-check-each' ] }),
    item({ id: 'awaiting', practice: '5', scoredBy: 'patterns',
        text: 'every attemptsTo is awaited or returned',
        requests: [ '1-new-feature', '4-new-http-api', '9-new-interface', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'no-console-log', practice: '6', scoredBy: 'reviewer',
        text: 'no console.log added',
        requests: [ '5-step-that-does-not-wait', '9-new-interface' ] }),
    item({ id: 'no-debugging-left', practice: '6', scoredBy: 'reviewer',
        text: "nothing left behind that the change doesn't need: debugging code, or files its runs produced",
        requests: [ '5-step-that-does-not-wait', '9-new-interface' ] }),
    item({ id: 'waiting', practice: '7', scoredBy: 'patterns',
        text: 'waits use Wait.until, never setTimeout or a fixed pause such as Wait.for',
        requests: [ '5-step-that-does-not-wait', '9-new-interface' ] }),
    item({ id: 'waits-in-tasks', practice: '7', scoredBy: 'reviewer',
        text: 'a task waits for the outcome it causes, with Wait.until or Ensure.eventually inside the task; a Wait.until or Ensure.eventually in a scenario for an outcome a task caused fails it',
        requests: [ '5-step-that-does-not-wait', '9-new-interface' ] }),
    item({ id: 'consistent-actor-names', practice: '8', scoredBy: 'patterns',
        text: "the actors a change adds are named the way the project's specs already name theirs, or one new way across every spec, such as a shared Role enum every spec imports; never two ways side by side, such as a Role enum in one spec next to 'Apisitt' in the others",
        requests: [ '1-new-feature', '4-new-http-api', '9-new-interface', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'structure', practice: '8', scoredBy: 'reviewer',
        text: 'follows the structure the project already uses, or with nothing to follow, the simplest that fits, and restructures only the code the change touches; it fails a change that introduces a second way of doing what the project already does, and passes one that follows the project and suggests the new way, or one that applies the new way consistently across the project and says so',
        requests: [ '1-new-feature', '2-step-that-does-several-things', '3-check-a-value', '4-new-http-api', '5-step-that-does-not-wait', '6-duplication', '7-rename-a-concept', '9-new-interface', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'no-copied-abstractions', practice: '8', scoredBy: 'reviewer',
        text: "didn't copy poor abstractions into new code",
        requests: [ '6-duplication', '11-add-to-messy-code' ] }),
    item({ id: 'suggested-the-rest', practice: '8', scoredBy: 'reviewer',
        text: 'restructured only what the change touches, and suggested the rest',
        requests: [ '6-duplication', '11-add-to-messy-code' ] }),
    item({ id: 'checks', practice: '9', scoredBy: 'patterns',
        text: 'outcomes that are already there are checked with Ensure.that, and those that arrive later with Ensure.eventually, not a Wait.until followed by an Ensure.that',
        requests: [ '1-new-feature', '2-step-that-does-several-things', '3-check-a-value', '4-new-http-api', '5-step-that-does-not-wait', '6-duplication', '9-new-interface', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'scenario-names', practice: 'M1', scoredBy: 'reviewer',
        text: 'the describe is named after the feature, and the it after the behaviour, so the report reads as a specification',
        requests: [ '1-new-feature', '4-new-http-api', '7-rename-a-concept', '9-new-interface', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'tasks-for-steps', practice: 'M2', scoredBy: 'reviewer',
        text: "steps are tasks in the business domain's language, and the steps scenarios repeat are extracted into a task",
        requests: [ '2-step-that-does-several-things', '6-duplication', '11-add-to-messy-code' ] }),
    item({ id: 'cast', practice: 'M3', scoredBy: 'reviewer',
        text: 'actors get their abilities in the Cast, and the configuration a test environment needs comes from environment variables',
        requests: [ '4-new-http-api', '9-new-interface' ] }),
    item({ id: 'timeout', practice: 'M4', scoredBy: 'reviewer',
        text: "Mocha's timeout leaves time for every activity in a scenario, including its waits",
        requests: [ '5-step-that-does-not-wait' ] }),
    item({ id: 'expectations', practice: 'M5', scoredBy: 'patterns',
        text: 'checks compare answers with expectations from @serenity-js/assertions, rather than answering the question in the scenario',
        requests: [ '1-new-feature', '3-check-a-value', '10-check-each', '11-add-to-messy-code', '12-check-a-value', '13-new-feature' ] }),
    item({ id: 'no-clients-or-other-assertions', practice: 'M6', scoredBy: 'patterns',
        text: 'it() and describe() bodies reach clients only through abilities, outside the interactions and questions that clients-through-abilities checks, and no code uses an assertion library other than @serenity-js/assertions',
        requests: [ '1-new-feature', '4-new-http-api', '9-new-interface', '10-check-each', '11-add-to-messy-code', '13-new-feature' ] }),
];

export type ChecklistItem = typeof CHECKLIST[number]['id'];

export type Verdict = 'pass' | 'fail' | 'n/a';

export interface Check {
    item: ChecklistItem;
    verdict: Verdict;
    /** The code each finding comes from, as `<file>:<line>: <first line of the code>` */
    evidence: string[];
}

export interface SourceFile {
    /** Relative to the run's directory */
    path: string;
    content: string;
}

export interface ChangedFile extends SourceFile {
    /** The 1-based numbers of the lines the run added or changed */
    addedLines: Set<number>;
}

/**
 * The project's TypeScript files as the run found them, and as it left them, for the items about what the project
 * already does, such as how its specs name their actors.
 */
export interface ProjectFiles {
    before: SourceFile[];
    after: SourceFile[];
}

interface Finding {
    node: SgNode;
    file: ChangedFile;
}

const FUNCTIONS = [ 'arrow_function', 'function_declaration', 'function_expression', 'method_definition' ];
// the clients a scenario, an activity or a question should only reach through an ability: HTTP clients and the file system
const CLIENTS = new Set([ 'axios', 'node-fetch', 'undici', 'got', 'superagent', 'http', 'https', 'node:http', 'node:https', 'fs', 'fs/promises', 'node:fs', 'node:fs/promises' ]);

function isAdded(finding: Finding): boolean {
    const { start, end } = finding.node.range();
    for (let line = start.line + 1; line <= end.line + 1; line++) {
        if (finding.file.addedLines.has(line)) {
            return true;
        }
    }
    return false;
}

function evidence(finding: Finding): string {
    return `${ finding.file.path }:${ finding.node.range().start.line + 1 }: ${ finding.node.text().split('\n')[0].trim() }`;
}

function namedChildren(node: SgNode | null): SgNode[] {
    return node ? node.children().filter(child => child.isNamed()) : [];
}

/** The calls whose callee is written exactly as `callee`, e.g. `Task.where`. */
function callsTo(root: SgNode, callee: string): SgNode[] {
    return root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.text() === callee);
}

function classesThat(root: SgNode, heritage: RegExp): SgNode[] {
    return root.findAll({ rule: { kind: 'class_declaration' } })
        .filter(declaration => declaration.children().some(child => child.kind() === 'class_heritage' && heritage.test(child.text())));
}

/** `MakePhoneCalls.as(actor)`, but not `.as(Number)`, which maps an answer. */
function isAbilityRetrieval(call: SgNode): boolean {
    const callee = call.field('function');
    const [ argument ] = namedChildren(call.field('arguments'));
    return callee?.kind() === 'member_expression'
        && callee.field('property')?.text() === 'as'
        && /^[A-Z]/.test(callee.field('object')?.kind() === 'identifier' ? callee.field('object')!.text() : '')
        && argument?.kind() === 'identifier' && /^[a-z]/.test(argument.text());
}

function isWaitUntil(call: SgNode): boolean {
    return /^Wait(\.upTo\([\s\S]*\))?\.until$/.test(call.field('function')?.text() ?? '');
}

/** The names an import statement binds: `axios` in `import axios from 'axios'`, `http` in `import * as http from 'http'`. */
function namesBoundBy(statement: SgNode): string[] {
    return statement.findAll({ rule: { any: [
        { kind: 'identifier', inside: { kind: 'import_clause' } },
        { kind: 'identifier', inside: { kind: 'namespace_import' } },
        { kind: 'identifier', inside: { kind: 'import_specifier' } },
    ] } })
        .filter(identifier => ! (String(identifier.parent()?.kind()) === 'import_specifier' && identifier.parent()?.field('alias') && identifier.parent()?.field('name')?.range().start.index === identifier.range().start.index))
        .map(identifier => identifier.text());
}

/** Where the code uses a client it imported: the call, like `axios.get('/latest')` or `writeFileSync(…)`, or the name itself. */
function usesOfClients(root: SgNode): SgNode[] {
    const names = new Set(root.findAll({ rule: { kind: 'import_statement' } })
        .filter(statement => CLIENTS.has(statement.field('source')?.text().slice(1, -1) ?? ''))
        .flatMap(namesBoundBy));
    return root.findAll({ rule: { kind: 'identifier' } })
        .filter(identifier => names.has(identifier.text()) && ! identifier.ancestors().some(ancestor => String(ancestor.kind()) === 'import_statement'))
        .map(identifier => {
            const parent = identifier.parent();
            const call = String(parent?.kind()) === 'member_expression' ? parent?.parent() : parent;
            return call && String(call.kind()) === 'call_expression' ? call : identifier;
        });
}

const ACTIVITIES = new Set([ 'Task.where', 'Interaction.where', 'Question.about' ]);
const SCENARIOS = /^(it|describe|context|specify)(\.(only|skip))?$/;

function insideCallTo(node: SgNode, callee: (name: string) => boolean): boolean {
    return node.ancestors().some(ancestor => String(ancestor.kind()) === 'call_expression' && callee(ancestor.field('function')?.text() ?? ''));
}

/** In a task, an interaction or a question: among its activities, or in its callback. */
const insideActivity = (node: SgNode) => insideCallTo(node, name => ACTIVITIES.has(name));

/** In a Mocha scenario or suite, including its hooks. */
const insideScenario = (node: SgNode) => insideCallTo(node, name => SCENARIOS.test(name));

/** A function's declared return type, e.g. `Task` for `(): Task => …` */
const returnTypeOf = (fn: SgNode) => fn.field('return_type')?.text().replace(/^:\s*/, '') ?? '';

const ACTIVITY_TYPES = /^(Activity|Interaction|Task|Question|QuestionAdapter|MetaQuestion|MetaQuestionAdapter)\b/;

/** What a function returns: its body, for an arrow function with an expression body, or what its own return statements return. */
function returnedBy(fn: SgNode): SgNode[] {
    const body = fn.field('body');
    if (! body) {
        return [];
    }
    if (String(body.kind()) !== 'statement_block') {
        return [ body ];
    }
    return body.findAll({ rule: { kind: 'return_statement' } })
        .filter(statement => statement.ancestors().find(ancestor => FUNCTIONS.includes(String(ancestor.kind())))?.range().start.index === fn.range().start.index)
        .flatMap(statement => namedChildren(statement).slice(0, 1));
}

/**
 * Whether an expression is a task, an interaction or a question: a call to `Task.where`, `Interaction.where` or
 * `Question.about`, or a question transformed with `.as(…)` or `.describedAs(…)`, anywhere along its chain of calls.
 */
function isActivityOrQuestion(expression: SgNode): boolean {
    let current: SgNode | null = expression;
    while (current && [ 'call_expression', 'member_expression', 'subscript_expression', 'parenthesized_expression', 'await_expression' ].includes(String(current.kind()))) {
        if (String(current.kind()) === 'call_expression') {
            const callee: SgNode | null = current.field('function');
            if (ACTIVITIES.has(callee?.text() ?? '')
                || (String(callee?.kind()) === 'member_expression' && [ 'as', 'describedAs' ].includes(callee?.field('property')?.text() ?? '') && ! isAbilityRetrieval(current))) {
                return true;
            }
            current = callee;
        }
        else if (String(current.kind()) === 'parenthesized_expression' || String(current.kind()) === 'await_expression') {
            current = namedChildren(current)[0] ?? null;
        }
        else {
            current = current.field('object');
        }
    }
    return false;
}

/** A function that returns a task, an interaction or a question, by its declared type or by what it returns. */
const isActivityFactory = (fn: SgNode) => ACTIVITY_TYPES.test(returnTypeOf(fn)) || returnedBy(fn).some(isActivityOrQuestion);

/** The parameters of a function that declare a type: `phoneNumber: Answerable<string>`, or `private readonly phoneNumber: string` in a constructor. */
function typedParametersOf(fn: SgNode): SgNode[] {
    return namedChildren(fn.field('parameters'))
        .filter(parameter => [ 'required_parameter', 'optional_parameter' ].includes(String(parameter.kind())))
        .filter(parameter => parameter.children().some(child => String(child.kind()) === 'type_annotation'));
}

/**
 * Whether a type is `Answerable<T>` itself, as in `core.Answerable<T>`, or `Answerable<T> | undefined`, but not a type
 * that only holds Answerables, like `Answerable<string>[]`, since a caller can't pass a question about the whole of it.
 */
function isAnswerableType(type: SgNode): boolean {
    switch (String(type.kind())) {
        case 'generic_type':
            return /(^|\.)Answerable$/.test(type.field('name')?.text() ?? '');
        case 'union_type':
        case 'parenthesized_type':
            return namedChildren(type).some(isAnswerableType);
        default:
            return false;
    }
}

const isAnswerable = (parameter: SgNode) =>
    namedChildren(parameter.children().find(child => String(child.kind()) === 'type_annotation') ?? null).some(isAnswerableType);

/** The names a function's parameters bind: `data` in `data => …`, and `a` and `b` in `(a: string, b = 1) => …`. */
function parametersOf(fn: SgNode): string[] {
    const parameters = fn.field('parameters') ?? fn.field('parameter');
    if (! parameters) {
        return [];
    }
    if (String(parameters.kind()) === 'identifier') {
        return [ parameters.text() ];
    }
    return namedChildren(parameters).flatMap(parameter => {
        const pattern = parameter.field('pattern') ?? parameter;
        return String(pattern.kind()) === 'identifier' ? [ pattern.text() ] : [];
    });
}

const ANSWERS_EVERY_PART = /^Question\.(fromObject|fromArray)$/;

/**
 * The array and object literals that pass a function's Answerables on as data, unanswered, such as
 * `{ expr: [ expression ], precision }` in `PostRequest.to('/v4').with({ expr: [ expression ], precision })`:
 * `actor.answer()` answers only a question or a promise at the top level, so the Answerables inside reach the activity
 * as they are, whether the literal is passed on where it's written, or assigned to a constant that is. A literal given
 * to `Question.fromObject` or `Question.fromArray` is answered part by part, and an Answerable given to
 * `actor.answer()` is answered where it is, so neither counts.
 */
function literalsPassingOn(scope: SgNode, isReference: (node: SgNode) => boolean): SgNode[] {
    const references = scope.findAll({ rule: { any: [ { kind: 'identifier' }, { kind: 'shorthand_property_identifier' }, { kind: 'member_expression' } ] } })
        .filter(isReference);
    const passesOnUnanswered = (argumentsNode: SgNode) => {
        const callee = argumentsNode.parent()?.field('function');
        return ! ANSWERS_EVERY_PART.test(callee?.text() ?? '') && callee?.field('property')?.text() !== 'answer';
    };
    // a literal assigned to a constant first, `const data = { expr: [ expression ] }`, is passed on where the constant is,
    // but not where a function in between has a parameter of the same name, as `data => JSON.stringify(data)` does
    const isPassedOnByName = (declarator: SgNode) => {
        const name = declarator.field('name');
        if (String(name?.kind()) !== 'identifier') {
            return false;
        }
        const declaredIn = declarator.ancestors().find(ancestor => FUNCTIONS.includes(String(ancestor.kind())));
        const isTheConstant = (use: SgNode) => ! use.ancestors()
            .filter(ancestor => FUNCTIONS.includes(String(ancestor.kind())))
            .filter(fn => ! declaredIn || fn.range().start.index > declaredIn.range().start.index)
            .some(fn => parametersOf(fn).includes(name!.text()));
        return scope.findAll({ rule: { kind: 'identifier' } })
            .filter(use => use.text() === name!.text() && use.range().start.index !== name!.range().start.index)
            .filter(isTheConstant)
            .some(use => String(use.parent()?.kind()) === 'arguments' && passesOnUnanswered(use.parent()!));
    };
    const literals = references.flatMap(reference => {
        let outermost: SgNode | undefined;
        for (let node = reference.parent(); node; node = node.parent()) {
            const kind = String(node.kind());
            if (kind === 'array' || kind === 'object') {
                outermost = node;
            }
            else if (kind === 'arguments') {
                return outermost && passesOnUnanswered(node) ? [ outermost ] : [];
            }
            else if (kind === 'variable_declarator') {
                return outermost && isPassedOnByName(node) ? [ outermost ] : [];
            }
            else if (kind !== 'pair' && kind !== 'spread_element') {
                return [];
            }
        }
        return [];
    });
    return [ ...new Map(literals.map(literal => [ literal.range().start.index, literal ])).values() ];
}

const nameOf = (parameter: SgNode) => parameter.field('pattern')?.text() ?? '';

/** The constructors of interaction objects: classes with a method, or a field, that returns a task, an interaction or a question. */
function interactionObjectConstructors(root: SgNode): SgNode[] {
    return root.findAll({ rule: { kind: 'class_body' } }).flatMap(body => {
        const members = namedChildren(body);
        const functions = members.flatMap(member => String(member.kind()) === 'method_definition' ? [ member ] : namedChildren(member).filter(child => FUNCTIONS.includes(String(child.kind()))));
        const constructor = members.find(member => String(member.kind()) === 'method_definition' && member.field('name')?.text() === 'constructor');
        return constructor && functions.some(fn => fn !== constructor && fn.field('name')?.text() !== 'constructor' && isActivityFactory(fn)) ? [ constructor ] : [];
    });
}

/** What the project does, before the run and after it, by the ways its specs name their actors. */
interface ProjectConventions {
    actorNamesBefore: Set<string>;
    actorNamesAfter: Set<string>;
}

/** What a rule finds done right and done wrong in a file; `file` says which of its lines the run added. */
type Rule = (root: SgNode, file: ChangedFile, project: ProjectConventions) => { good: SgNode[], bad: SgNode[] };

/** Whether the file had any of `nodes` before the run, on lines it didn't add: what the file already does. */
const alreadyIn = (file: ChangedFile, nodes: SgNode[]) => nodes.some(node => ! isAdded({ node, file }));

/** `actorCalled('Alice')`, with the name written in the scenario, rather than taken from an enum or a constant. */
function namesItsActorInPlace(call: SgNode): boolean {
    const [ name ] = namedChildren(call.field('arguments'));
    return [ 'string', 'template_string' ].includes(String(name?.kind()));
}

const NAMES_IN_PLACE = 'names written in place';

/**
 * How an `actorCalled` names its actor: with a string written in place, or from the enum or constant it names, by
 * where that comes from: `Role imported from src/Role` for every spec that imports the shared one, or
 * `Role declared in spec/units.spec.ts` for an enum of the spec's own.
 */
function actorNamingOf(call: SgNode, path: string, root: SgNode): string | undefined {
    const [ name ] = namedChildren(call.field('arguments'));
    if (! name) {
        return undefined;
    }
    if (namesItsActorInPlace(call)) {
        return NAMES_IN_PLACE;
    }
    let base: SgNode = name;
    while ([ 'member_expression', 'subscript_expression', 'call_expression' ].includes(String(base.kind()))) {
        base = base.field(String(base.kind()) === 'call_expression' ? 'function' : 'object')!;
    }
    const identifier = base.text();
    const imported = root.findAll({ rule: { kind: 'import_statement' } }).find(statement => namesBoundBy(statement).includes(identifier));
    if (! imported) {
        return `${ identifier } declared in ${ path }`;
    }
    const source = imported.field('source')?.text().slice(1, -1) ?? '';
    const module = source.startsWith('.') ? posix.join(posix.dirname(path), source).replace(/\.[cm]?[jt]s$/, '') : source;
    return `${ identifier } imported from ${ module }`;
}

/** The ways the files name their actors, leaving out the calls on the lines `isLeftOut` says, such as the lines a run added. */
function actorNamingsIn(files: SourceFile[], isLeftOut: (node: SgNode, file: SourceFile) => boolean = () => false): Set<string> {
    return new Set(files.filter(file => file.path.endsWith('.ts')).flatMap(file => {
        const root = parse(Lang.TypeScript, file.content).root();
        return callsTo(root, 'actorCalled').filter(call => ! isLeftOut(call, file)).flatMap(call => actorNamingOf(call, file.path, root) ?? []);
    }));
}

/**
 * What the project does: the ways its files named their actors before the run, including the lines of the files it
 * changed that it didn't add, and the ways they name them after it, with the changed files as the run left them.
 */
function conventionsOf(files: ChangedFile[], project: ProjectFiles): ProjectConventions {
    const changed = new Set(files.map(file => file.path));
    const before = actorNamingsIn(project.before);
    for (const naming of actorNamingsIn(files, (node, file) => isAdded({ node, file: file as ChangedFile }))) {
        before.add(naming);
    }
    return {
        actorNamesBefore: before,
        actorNamesAfter: actorNamingsIn([ ...project.after.filter(file => ! changed.has(file.path)), ...files ]),
    };
}

/** `await actor.answer(x)` as the value of a constant, or of a variable, of its own. */
function isAnsweredIntoAConstant(answer: SgNode): boolean {
    const awaited = answer.parent();
    return String(awaited?.kind()) === 'await_expression' && String(awaited?.parent()?.kind()) === 'variable_declarator';
}

const THE = /(^|[a-z0-9])The([A-Z0-9_]|$)|^the[A-Z0-9_]/;

/** The names an activity or a question is known by: the constant, field or property it's assigned to, and those around it. */
function namesOf(activity: SgNode): SgNode[] {
    return activity.ancestors()
        .filter(ancestor => [ 'variable_declarator', 'pair', 'public_field_definition', 'method_definition' ].includes(String(ancestor.kind())))
        .flatMap(ancestor => {
            const name = ancestor.field('name') ?? ancestor.field('key');
            return name ? [ name ] : [];
        });
}

function isAsync(callback: SgNode | undefined): boolean {
    return callback !== undefined && FUNCTIONS.includes(String(callback.kind())) && callback.text().startsWith('async');
}

/** `List.of(…).forEach(…)` */
function isListForEach(call: SgNode): boolean {
    return /^List\.of\([\s\S]*\)\.forEach$/.test(call.field('function')?.text() ?? '');
}

/** An `attemptsTo` whose promise someone waits for: awaited, returned, or the body of an arrow function. */
function isWaitedFor(call: SgNode): boolean {
    const parent = call.parent();
    const kind = String(parent?.kind());
    return kind === 'await_expression' || kind === 'return_statement'
        || (kind === 'arrow_function' && parent?.field('body')?.range().start.index === call.range().start.index);
}

/** The whole expression a call is part of, e.g. `Wait.until(…).pollingEvery(…)` for its `Wait.until(…)`. */
function outermostChainOf(call: SgNode): SgNode {
    let current = call;
    while ([ 'member_expression', 'call_expression' ].includes(String(current.parent()?.kind()))) {
        current = current.parent()!;
    }
    return current;
}

/** A wait that the very next activity in the same list follows with an `Ensure.that`, which `Ensure.eventually` does in one. */
function isFollowedByEnsureThat(wait: SgNode): boolean {
    const activity = outermostChainOf(wait);
    if (String(activity.parent()?.kind()) !== 'arguments') {
        return false;
    }
    const siblings = namedChildren(activity.parent());
    const next = siblings[siblings.findIndex(sibling => sibling.range().start.index === activity.range().start.index) + 1];
    return next?.kind() === 'call_expression' && next.field('function')?.text() === 'Ensure.that';
}

const ENSURES = (root: SgNode) => [ ...callsTo(root, 'Ensure.that'), ...callsTo(root, 'Ensure.eventually') ];
const answersIn = (root: SgNode) => root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.field('property')?.text() === 'answer');

const RULES: Record<ChecklistItem, Rule> = {
    'actor-names': (root, file, project) => {
        const actors = callsTo(root, 'actorCalled');
        const inPlace = actors.filter(namesItsActorInPlace);
        // practice 8: a scenario added to a project that already names its actors with strings follows the project's
        // way, so the item only applies where a change introduces its own way of naming actors
        const followsTheProject = alreadyIn(file, inPlace) || project.actorNamesBefore.has(NAMES_IN_PLACE);
        return { good: actors.filter(call => ! namesItsActorInPlace(call)), bad: followsTheProject ? [] : inPlace };
    },
    'consistent-actor-names': (root, file, project) => {
        const actors = callsTo(root, 'actorCalled').filter(call => actorNamingOf(call, file.path, root) !== undefined);
        // practice 8: one way across the project, whether it's the project's or a new one applied to every spec
        if (project.actorNamesAfter.size <= 1) {
            return { good: actors, bad: [] };
        }
        const isTheProjects = (call: SgNode) => project.actorNamesBefore.has(actorNamingOf(call, file.path, root)!);
        return { good: actors.filter(isTheProjects), bad: actors.filter(call => ! isTheProjects(call)) };
    },
    'answerable-parameters': root => {
        const factories = root.findAll({ rule: { any: FUNCTIONS.map(kind => ({ kind })) } }).filter(isActivityFactory);
        const constructors = interactionObjectConstructors(root);
        const parameters = [ ...factories, ...constructors ].flatMap(typedParametersOf);
        const answerablesOf = (fn: SgNode) => new Set(typedParametersOf(fn).filter(isAnswerable).map(nameOf));
        // an interaction object's methods use its constructor's parameters as fields, `this.phoneNumber`
        const fieldsOf = (constructor: SgNode) => answerablesOf(constructor);
        const isThisField = (fields: Set<string>) => (node: SgNode) => String(node.kind()) === 'member_expression'
            && node.field('object')?.text() === 'this' && fields.has(node.field('property')?.text() ?? '');
        const literals = [
            ...factories.flatMap(fn => {
                const names = answerablesOf(fn);
                return fn.field('body') ? literalsPassingOn(fn.field('body')!, node => String(node.kind()) !== 'member_expression' && names.has(node.text())) : [];
            }),
            ...constructors.flatMap(constructor => literalsPassingOn(constructor.parent()!, isThisField(fieldsOf(constructor)))),
        ];
        return { good: parameters.filter(isAnswerable), bad: [ ...parameters.filter(parameter => ! isAnswerable(parameter)), ...literals ] };
    },
    'clients-through-abilities': root => {
        const inInteractionOrQuestion = (node: SgNode) => insideCallTo(node, name => name === 'Interaction.where' || name === 'Question.about');
        return {
            good: root.findAll({ rule: { kind: 'call_expression' } }).filter(isAbilityRetrieval).filter(inInteractionOrQuestion),
            bad: [ ...callsTo(root, 'fetch'), ...usesOfClients(root) ].filter(inInteractionOrQuestion),
        };
    },
    'answering': root => {
        const answers = answersIn(root).filter(answer => insideCallTo(answer, name => name === 'Interaction.where' || name === 'Question.about'));
        return { good: answers.filter(isAnsweredIntoAConstant), bad: answers.filter(answer => ! isAnsweredIntoAConstant(answer)) };
    },
    'names-without-the': (root, file) => {
        // activities and questions, including questions made by transforming another, like `LastResponse.body().as(…)`
        const transformations = root.findAll({ rule: { kind: 'call_expression' } })
            .filter(call => [ 'as', 'describedAs' ].includes(call.field('function')?.field('property')?.text() ?? ''))
            .filter(call => ! isAbilityRetrieval(call));
        const names = [ ...[ 'Task.where', 'Interaction.where', 'Question.about' ].flatMap(callee => callsTo(root, callee)), ...transformations ]
            .flatMap(namesOf);
        const unique = [ ...new Map(names.map(name => [ name.range().start.index, name ])).values() ];
        const withThe = unique.filter(name => THE.test(name.text()));
        // practice 8: a name added to a file whose names already have "the" follows the file's naming style
        return { good: unique.filter(name => ! THE.test(name.text())), bad: alreadyIn(file, withThe) ? [] : withThe };
    },
    'repeating': root => {
        const loops = root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.field('property')?.text() === 'forEach');
        return {
            good: loops.filter(isListForEach),
            bad: loops.filter(loop => ! isListForEach(loop) && isAsync(namedChildren(loop.field('arguments'))[0])),
        };
    },
    'awaiting': root => {
        const performances = root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.field('property')?.text() === 'attemptsTo');
        return { good: performances.filter(isWaitedFor), bad: performances.filter(call => ! isWaitedFor(call)) };
    },
    'waiting': root => ({
        good: root.findAll({ rule: { kind: 'call_expression' } }).filter(isWaitUntil),
        // an ability, or the system under test, may use setTimeout for its own reasons
        bad: [ ...callsTo(root, 'setTimeout').filter(node => insideActivity(node) || insideScenario(node)), ...callsTo(root, 'Wait.for') ],
    }),
    'checks': root => ({
        good: ENSURES(root),
        bad: root.findAll({ rule: { kind: 'call_expression' } }).filter(isWaitUntil).filter(isFollowedByEnsureThat),
    }),
    'expectations': root => ({
        good: ENSURES(root),
        // answering a question in a scenario, to compare the answer, rather than in an interaction, which uses it
        bad: answersIn(root).filter(answer => insideScenario(answer) && ! insideActivity(answer)),
    }),
    'no-clients-or-other-assertions': root => ({
        // defining an ability, giving one to an actor, or retrieving one with as, and checking with Ensure
        good: [
            ...classesThat(root, /\bextends\s+Ability\b/),
            ...root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.field('property')?.text() === 'whoCan'),
            ...root.findAll({ rule: { kind: 'call_expression' } }).filter(isAbilityRetrieval),
            ...ENSURES(root),
        ],
        // reaching a client from a Mocha scenario or suite, outside the interactions and questions that
        // clients-through-abilities checks, so that one client fails one item; checking without Serenity/JS, anywhere;
        // and retrieving an ability with abilityTo rather than as
        bad: [
            ...root.findAll({ rule: { kind: 'call_expression' } }).filter(call => call.field('function')?.field('property')?.text() === 'abilityTo'),
            ...[ ...callsTo(root, 'fetch'), ...usesOfClients(root) ]
                .filter(node => insideScenario(node) && ! insideCallTo(node, name => name === 'Interaction.where' || name === 'Question.about')),
            ...callsTo(root, 'expect'),
            ...callsTo(root, 'assert'),
            ...root.findAll({ rule: { kind: 'call_expression' } }).filter(call => /^assert\.\w+$/.test(call.field('function')?.text() ?? '')),
        ],
    }),
    // the reviewer scores these; the AST patterns leave them n/a
    'one-action': () => ({ good: [], bad: [] }),
    'integrations-first': () => ({ good: [], bad: [] }),
    'question-names': () => ({ good: [], bad: [] }),
    'waits-in-tasks': () => ({ good: [], bad: [] }),
    'grouping': () => ({ good: [], bad: [] }),
    'no-console-log': () => ({ good: [], bad: [] }),
    'no-debugging-left': () => ({ good: [], bad: [] }),
    'structure': () => ({ good: [], bad: [] }),
    'no-copied-abstractions': () => ({ good: [], bad: [] }),
    'suggested-the-rest': () => ({ good: [], bad: [] }),
    'scenario-names': () => ({ good: [], bad: [] }),
    'tasks-for-steps': () => ({ good: [], bad: [] }),
    'cast': () => ({ good: [], bad: [] }),
    'timeout': () => ({ good: [], bad: [] }),
};

/**
 * What the AST patterns decide about each item of the checklist, in the lines a run added to TypeScript files, given
 * the project's files before and after the run, for the items about what the project already does.
 */
export function checkConventions(files: ChangedFile[], project: ProjectFiles = { before: [], after: [] }): Check[] {
    const roots = files
        .filter(file => file.path.endsWith('.ts'))
        .map(file => ({ file, root: parse(Lang.TypeScript, file.content).root() }));
    const conventions = conventionsOf(files, project);

    return CHECKLIST.map(({ id }) => {
        const found = (side: 'good' | 'bad') => roots
            .flatMap(({ file, root }) => RULES[id](root, file, conventions)[side].map(node => ({ node, file })))
            .filter(isAdded);
        const bad = found('bad');
        const good = found('good');
        const verdict: Verdict = bad.length > 0 ? 'fail' : (good.length > 0 ? 'pass' : 'n/a');
        return { item: id, verdict, evidence: (bad.length > 0 ? bad : good).map(evidence) };
    });
}

/**
 * Whether a request's right answer exercises an item of the checklist: what the brief's table, the review packets and
 * --compare group the items by. The checks don't depend on it: every item that applies to the code a run added is scored.
 */
export function exercises(request: string, item: ChecklistItem): boolean {
    return CHECKLIST.some(definition => definition.id === item && definition.requests.includes(request));
}

/** The items that apply to a run, and how many of them pass. */
export function conventionsScore(checks: Array<Pick<Check, 'item' | 'verdict'>>): { passed: number, applicable: number } {
    return {
        passed: checks.filter(check => check.verdict === 'pass').length,
        applicable: checks.filter(check => check.verdict !== 'n/a').length,
    };
}
