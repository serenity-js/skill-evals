// The layouts under evaluation, and where each keeps the text about each building block of a Serenity/JS test.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const evalRoot = import.meta.dirname.replace(/[/\\]src$/, '');

export const LAYOUTS = [ 'none', 'a', 'b', 'c' ] as const;
export type Layout = typeof LAYOUTS[number];

export const BUILDING_BLOCKS = [ 'tasks', 'interactions', 'abilities', 'questions', 'tests' ] as const;
export type BuildingBlock = typeof BUILDING_BLOCKS[number];

/** The packages whose tarballs get a layout's skills. */
export const PACKAGES_WITH_SKILLS = [ 'core', 'mocha' ] as const;
export type PackageWithSkills = typeof PACKAGES_WITH_SKILLS[number];

/**
 * The file that holds what each building block needs, as `<skill>/<file>`: the file an agent has to read
 * to have loaded the right skill for a request that needs that building block.
 */
export const FILES_FOR: Record<Exclude<Layout, 'none'>, Record<BuildingBlock, string>> = {
    a: {
        tasks:        'serenity-js-writing-tasks/SKILL.md',
        interactions: 'serenity-js-writing-interactions-and-abilities/SKILL.md',
        abilities:    'serenity-js-writing-interactions-and-abilities/SKILL.md',
        questions:    'serenity-js-writing-questions/SKILL.md',
        tests:        'serenity-js-writing-tests/SKILL.md',
    },
    b: {
        tasks:        'serenity-js-screenplay/references/tasks.md',
        interactions: 'serenity-js-screenplay/references/interactions-and-abilities.md',
        abilities:    'serenity-js-screenplay/references/interactions-and-abilities.md',
        questions:    'serenity-js-screenplay/references/questions.md',
        tests:        'serenity-js-writing-tests/SKILL.md',
    },
    c: {
        tasks:        'serenity-js-writing-tasks/SKILL.md',
        interactions: 'serenity-js-writing-interactions/SKILL.md',
        abilities:    'serenity-js-writing-abilities/SKILL.md',
        questions:    'serenity-js-writing-questions/SKILL.md',
        tests:        'serenity-js-writing-tests/SKILL.md',
    },
};

export function isLayout(value: string): value is Layout {
    return (LAYOUTS as readonly string[]).includes(value);
}

/** Where a layout keeps the skills of a package, e.g. `layouts/b/core`, or `undefined` for a package it gives no skills. */
export function skillsDirectoryOf(layout: Layout, pkg: PackageWithSkills, root: string = evalRoot): string | undefined {
    const directory = join(root, 'layouts', layout, pkg);
    return existsSync(directory) ? directory : undefined;
}

/** The names of the skills a layout gives a package, sorted. */
export function skillsOf(layout: Layout, pkg: PackageWithSkills, root: string = evalRoot): string[] {
    const directory = skillsDirectoryOf(layout, pkg, root);
    return directory
        ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
        : [];
}

/** Every skill of a layout, across packages: what `npx skills experimental_sync` should link. */
export function allSkillsOf(layout: Layout, root: string = evalRoot): string[] {
    return PACKAGES_WITH_SKILLS.flatMap(pkg => skillsOf(layout, pkg, root)).sort();
}
