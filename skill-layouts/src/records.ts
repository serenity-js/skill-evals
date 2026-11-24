// Reading the files the harness writes and reads back: mapping.json, each run's result.json, the reviewer's
// scores.json, and config.json. Each is checked where it's read, so a missing or wrong field stops the harness with
// the field's name and the file, rather than with a TypeError somewhere further on, or a wrong summary.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LAYOUTS } from './layouts.ts';
import { AGENTS, type Agent, type PlannedRun, type ReviewScores } from './review.ts';
import type { Config, RunRecord } from './runs.ts';

/** Checks a value, at a path in a file, and throws, naming both, when it isn't what the harness expects. */
type Check = (value: unknown, path: string, file: string) => void;

const shown = (value: unknown) => {
    const json = JSON.stringify(value);
    return json.length > 60 ? `${ json.slice(0, 60) }…` : json;
};

function invalid(file: string, path: string, value: unknown, expected: string): never {
    throw new Error(value === undefined
        ? `${ file }: ${ path } is missing`
        : `${ file }: ${ path } is ${ shown(value) }, not ${ expected }`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && ! Array.isArray(value);

const expecting = (expected: string, ok: (value: unknown) => boolean): Check => (value, path, file) => {
    if (! ok(value)) {
        invalid(file, path, value, expected);
    }
};

const aString = expecting('a string', value => typeof value === 'string');
const aNumber = expecting('a number', value => typeof value === 'number' && Number.isFinite(value));
const aBoolean = expecting('true or false', value => typeof value === 'boolean');
const minutes = expecting('a number of minutes, more than 0', value => typeof value === 'number' && value > 0);
const aPort = expecting('a port, 1 to 65535', value => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535);
const aRepeat = expecting('a whole number, 1 or more', value => Number.isInteger(value) && (value as number) >= 1);
const oneOf = (values: readonly string[]) =>
    expecting(`one of ${ values.join(', ') }`, value => typeof value === 'string' && values.includes(value));

const at = (path: string, key: string) => path ? `${ path }.${ key }` : key;

function listOf(check: Check): Check {
    return (value, path, file) => {
        if (! Array.isArray(value)) {
            invalid(file, path || 'the file', value, 'a list');
        }
        value.forEach((item, index) => check(item, `${ path }[${ index }]`, file));
    };
}

/** An object with the required fields, and the optional ones, which are checked when they're there. */
function fields(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
    return (value, path, file) => {
        if (! isObject(value)) {
            invalid(file, path || 'the file', value, 'an object');
        }
        for (const [ key, check ] of Object.entries(required)) {
            check(value[key], at(path, key), file);
        }
        for (const [ key, check ] of Object.entries(optional)) {
            if (value[key] !== undefined) {
                check(value[key], at(path, key), file);
            }
        }
    };
}

/** An object whose keys are anything, such as run IDs, and whose values each pass the check. */
function entriesOf(check: Check): Check {
    return (value, path, file) => {
        if (! isObject(value)) {
            invalid(file, path || 'the file', value, 'an object');
        }
        for (const [ key, entry ] of Object.entries(value)) {
            check(entry, at(path, key), file);
        }
    };
}

function readJson(file: string): unknown {
    const text = readFileSync(file, 'utf8');
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw new Error(`${ file } isn't JSON: ${ (error as Error).message }`);
    }
}

function read<T>(file: string, check: Check): T {
    const value = readJson(file);
    check(value, '', file);
    return value as T;
}

const PLAN = listOf(fields({ id: aString, agent: oneOf(AGENTS), layout: oneOf(LAYOUTS), request: aString, repeat: aRepeat }));

const OUTCOMES = [ 'correct', 'incorrect', 'network-failure', 'agent-failure' ] as const;
const VERDICTS = [ 'pass', 'fail', 'n/a' ] as const;
const names = listOf(aString);
const aCount = fields({ agent: aNumber, checks: aNumber });

// the fields every result.json has, from the first pilot's on, and those results scored by earlier versions of the
// harness may not have, or that only some runs have
const RECORD = fields(
    {
        id: aString,
        outcome: oneOf(OUTCOMES),
        checks: listOf(fields({ item: aString, verdict: oneOf(VERDICTS) })),
        skillReads: listOf(fields({ file: aString })),
        tokens: fields({ input: aNumber, cacheRead: aNumber, cacheWrite: aNumber, output: aNumber }),
        durationMs: aNumber,
        timedOut: aBoolean,
        modelUnreported: aBoolean,
    },
    {
        loading: fields({ right: aBoolean }),
        costUsd: aNumber,
        tokensReported: aBoolean,
        credits: aNumber,
        premiumRequests: aNumber,
        autoMode: fields({ availableModels: names }),
        completedToolCalls: aNumber,
        shellCommands: names,
        checksSandboxed: aBoolean,
        agentEnvironment: names,
        serverRequests: aCount,
        models: names,
        modelAnswered: aBoolean,
        model: aString,
    },
);

const SCORES = entriesOf(entriesOf(aString));

const CONFIG = fields({
    models: fields(Object.fromEntries(AGENTS.map(agent => [ agent, aString ]))),
    template: fields({ commit: aString }),
    apiServer: fields({ port: aPort }),
    runTimeoutMinutes: minutes,
    testTimeoutMinutes: minutes,
});

/** The runs planned in a mode's results, in its mapping.json, of the given agents only. */
export function readPlan(results: string, agents: readonly Agent[] = AGENTS): PlannedRun[] {
    return read<PlannedRun[]>(join(results, 'mapping.json'), PLAN).filter(run => agents.includes(run.agent));
}

/** A run's result.json. */
export function readRecord(file: string): RunRecord {
    return read<RunRecord>(file, RECORD);
}

/** The reviewer's scores.json, or no scores, before there is one. Whether each is a verdict is the summary's to say. */
export function readScores(file: string): ReviewScores {
    return existsSync(file) ? read<ReviewScores>(file, SCORES) : {};
}

/** The evaluation's config.json. */
export function readConfig(file: string): Config {
    return read<Config>(file, CONFIG);
}
