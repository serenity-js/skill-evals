// This harness's skills: the directories its agents read skills from, as their adapters declare them, the skills/ of
// the packages it packs, and the names of the skills its layouts give those packages. The command line, and the older
// modules that score runs and write review packets, compose them here.
import { adapterOf, AGENTS } from './agents/index.ts';
import { allSkillsOf, evalRoot, LAYOUTS } from './layouts.ts';
import { PACKAGES } from './project.ts';
import { Blinding } from './review.ts';
import { SkillDirectories } from './skill-directories.ts';

/** Where the harness's agents, and the packages it packs, keep skills */
export function harnessSkillDirectories(): SkillDirectories {
    return SkillDirectories.readBy(AGENTS.map(agent => adapterOf(agent)), PACKAGES.map(name => `@serenity-js/${ name }`));
}

/** What hides the skills of every layout, in their directories and by their names, from the reviewer and the judge */
export function harnessBlinding(root: string = evalRoot): Blinding {
    return Blinding.of(harnessSkillDirectories(), [ ...new Set(LAYOUTS.flatMap(layout => allSkillsOf(layout, root))) ]);
}
