// The conditions an evaluation's runs are made under, in conditions.json: the shared ones, saved before the first run,
// and each agent's model and version, recorded when that agent's first run starts, so the pilot can run one agent at
// a time. A resumed evaluation that would run under other conditions, such as another build of the framework, another
// model, or different requests or skills, is refused, so the summary never mixes runs from different experiments.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { evalRoot, type Layout } from './layouts.ts';
import { readConditions } from './records.ts';
import { Results, writeJson } from './results.ts';
import type { Agent } from './review.ts';

/** What every run of the evaluation shares, whichever agent it's of. */
export interface SharedConditions {
    template: { commit: string };
    serenityJs: { commit: string };
    /** The hash of requests.json */
    requests: string;
    /** The hash of each layout's skills, the files of `layouts/<layout>/` */
    skills: Partial<Record<Layout, string>>;
    /** The hash of the lockfile saved for each layout the first time it was prepared for this --out */
    lockfiles: Partial<Record<Layout, string>>;
    /** The port of the local API server, which the runs' test scripts and code name */
    apiServer: { port: number };
    /** The hash of each fixture in `fixtures/` the planned requests start from */
    fixtures: Record<string, string>;
}

/** What an agent's runs share: recorded when its first run starts, so its pin can change until then. */
export interface AgentConditions {
    model: string;
    version: string;
}

export interface Conditions {
    shared: SharedConditions;
    agents: Partial<Record<Agent, AgentConditions>>;
}

/** A SHA-256 of a file, or of a directory's files: their paths, relative to it, and their contents. */
export function hashOf(path: string): string {
    const hash = createHash('sha256');
    if (existsSync(path) && statSync(path).isFile()) {
        hash.update(readFileSync(path));
    }
    else if (existsSync(path)) {
        const files = readdirSync(path, { recursive: true, withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => join(entry.parentPath, entry.name))
            .sort();
        for (const file of files) {
            hash.update(relative(path, file).split(sep).join('/')).update('\0').update(readFileSync(file)).update('\0');
        }
    }
    return `sha256:${ hash.digest('hex') }`;
}

/** The hash of each fixture the planned requests start from, once each, by its name in `fixtures/`. */
export function fixtureHashes(fixtures: Array<string | undefined>, root: string = join(evalRoot, 'fixtures')): Record<string, string> {
    return Object.fromEntries([ ...new Set(fixtures.filter((fixture): fixture is string => fixture !== undefined)) ]
        .sort()
        .map(fixture => [ fixture, hashOf(join(root, fixture)) ]));
}

function leaves(value: unknown, prefix = ''): Map<string, string> {
    if (value === null || typeof value !== 'object') {
        return new Map([ [ prefix, String(value) ] ]);
    }
    return new Map(Object.entries(value as Record<string, unknown>).flatMap(([ key, nested ]) =>
        [ ...leaves(nested, prefix ? `${ prefix }.${ key }` : key) ]));
}

/** Each condition that differs, as `<name>: <saved>, now <current>`. */
export function changedConditions(saved: object, now: object, prefix = ''): string[] {
    const before = leaves(saved, prefix);
    const after = leaves(now, prefix);
    return [ ...new Set([ ...before.keys(), ...after.keys() ]) ]
        .filter(name => before.get(name) !== after.get(name))
        .map(name => `${ name }: ${ before.get(name) ?? 'none' }, now ${ after.get(name) ?? 'none' }`);
}

const read = readConditions;
const write = (file: string, conditions: Conditions) => writeJson(file, conditions);

/**
 * Saves the shared conditions the first time, and refuses to go on under other conditions after that: other shared
 * conditions, other conditions of an agent that's running and already has runs, or another pin of an agent that has
 * runs, though it isn't running. An agent without runs has no recorded conditions, so its pin can still change.
 *
 * `running` holds the conditions of the agents about to run; `pins`, every agent's pin in config.json.
 */
export function checkConditions(
    file: string,
    shared: SharedConditions,
    running: Partial<Record<Agent, AgentConditions>>,
    pins: Partial<Record<Agent, string>> = Object.fromEntries(Object.entries(running).map(([ agent, conditions ]) => [ agent, conditions!.model ])),
): void {
    if (! existsSync(file)) {
        write(file, { shared, agents: {} });
        return;
    }
    const saved = read(file);
    // a lockfile saved since the shared conditions were, for a layout not prepared until then, isn't a change
    const recorded = { ...saved.shared, lockfiles: { ...saved.shared.lockfiles } };
    const now = { ...shared, lockfiles: Object.fromEntries(Object.entries(shared.lockfiles).filter(([ layout ]) => layout in recorded.lockfiles)) };
    const changed = [
        ...changedConditions(recorded, now),
        ...(Object.entries(saved.agents) as Array<[ Agent, AgentConditions ]>).flatMap(([ agent, recorded ]) =>
            running[agent]
                ? changedConditions(recorded, running[agent]!, agent)
                : (pins[agent] !== undefined ? changedConditions({ model: recorded.model }, { model: pins[agent] }, agent) : [])),
    ];
    if (changed.length > 0) {
        throw new Error(`the runs in ${ dirname(file) } were made under other conditions, so they can't be resumed:\n${ changed.map(change => `  ${ change }`).join('\n') }\nput the conditions back, or pass another --out to start again`);
    }
}

/** Records an agent's conditions when its first run starts; after that, they stay as they were. */
export function recordAgentConditions(file: string, agent: Agent, conditions: AgentConditions): void {
    const saved = read(file);
    if (! saved.agents[agent]) {
        write(file, { ...saved, agents: { ...saved.agents, [agent]: conditions } });
    }
}

/** Where the lockfile npm generated the first time a layout was prepared for an --out is saved, in its results. */
export function savedLockfileOf(results: string, layout: Layout): string {
    return new Results(results).savedLockfile(layout);
}

/** The hash of each layout's saved lockfile, leaving out the layouts that haven't been prepared for this --out yet. */
export function lockfileHashes(results: string, layouts: Layout[]): Partial<Record<Layout, string>> {
    return Object.fromEntries(layouts
        .filter(layout => existsSync(savedLockfileOf(results, layout)))
        .map(layout => [ layout, hashOf(savedLockfileOf(results, layout)) ]));
}

/** Records the hashes of lockfiles saved since the shared conditions were; a lockfile recorded once stays as it was. */
export function recordLockfiles(file: string, hashes: Partial<Record<Layout, string>>): void {
    const saved = read(file);
    write(file, { ...saved, shared: { ...saved.shared, lockfiles: { ...hashes, ...saved.shared.lockfiles } } });
}
