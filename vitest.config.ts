import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [ '*/spec/**/*.spec.ts' ],
        // the projects the specs read, such as a run's working copy, have spec files of their own
        exclude: [ ...configDefaults.exclude, '*/spec/fixtures/**' ],
    },
});
