# skill-evals

Evaluations of the agent skills that [Serenity/JS](https://serenity-js.org) packages ship:
harnesses that give coding agents real requests, in real projects, with the skills installed, and score what the
agents do with them.

| Evaluation | What it answers |
|---|---|
| [`skill-layouts/`](skill-layouts/README.md) | How a package should split its skills. It chose one skill per package, and is now a regression check of `@serenity-js/core`'s skills |

## Getting started

You need Node.js 24 and pnpm. From the repository's root:

```bash
pnpm install
npx tsc --noEmit
npx vitest run
```

Each evaluation's README says what else it needs, and how to run it, such as `pnpm run eval:skill-layouts`.

## License

[Apache 2.0](LICENSE)
