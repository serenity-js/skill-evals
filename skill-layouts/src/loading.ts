// Whether a run read the skills its request needs, against the table of which building blocks each request needs.
import { type BuildingBlock, FILES_FOR, type Layout } from './layouts.ts';
import type { SkillRead } from './streams.ts';

export interface LoadingScore {
    /** The files that hold the building blocks the request needs, in this layout */
    needed: string[];
    /** The skill files the run read, once each */
    read: string[];
    missing: string[];
    /** Every needed file read; for the control, which needs none, no skill read at all */
    right: boolean;
}

/** How a run loaded skills, or `undefined` for the layout without skills, where there's nothing to load. */
export function scoreLoading(layout: Layout, needs: BuildingBlock[], reads: SkillRead[]): LoadingScore | undefined {
    if (layout === 'none') {
        return undefined;
    }
    const needed = [ ...new Set(needs.map(block => FILES_FOR[layout][block])) ].sort();
    const read = [ ...new Set(reads.map(skillRead => skillRead.file)) ].sort();
    const missing = needed.filter(file => ! read.includes(file));

    return {
        needed,
        read,
        missing,
        right: needed.length === 0 ? read.length === 0 : missing.length === 0,
    };
}
