# template cloudflare worker

A template for applications using [preact](https://preactjs.com/), [htm](https://github.com/developit/htm/tree/master), [typescript](https://www.typescriptlang.org/), and [cloudflare](https://www.cloudflare.com/) as host. Use
[tapout](https://github.com/substrate-system/tapout)
for tests in a browser environment.

See
[template-ts-preact-htm-app](https://github.com/nichoth/template-ts-preact-htm-app)
for the same thing, but not using cloudflare.

See [template-ts-preact-htm](https://github.com/nichoth/template-ts-preact-htm)
for something similar, but for dependency modules.

## Use

1. Use the template button in github. Or clone this then
   `rm -rf .git && git init`. 
2. Then `npm i && npm init`.
3. Edit the source code in `src/`.
4. Setup the environment variables:
   ```sh
   mv .dev.vars.example .dev.vars
   ```
5. Write docs &mdash; `mv README.example.md README.md` + edit the readme file

## _Featuring_

* `preversion` npm hook -- lint.
* `postversion` npm hook -- `git push && git push --tags`
* eslint via [eslint-config-standard](https://github.com/standard/eslint-config-standard) -- `npm run lint`
* test in a browser environment via `tape-run` -- see `npm test`.
  Includes `tap` testing tools &mdash;
  [tapzero](https://github.com/substrate-system/tapzero) and
  [tap-spec](https://www.npmjs.com/package/tap-spec)
* CI via github actions
* routing via
  [route-event](https://github.com/nichoth/route-event) and
  [@substrate-system/routes](https://github.com/substrate-system/routes)

## Develop

Use the vite Cloudflare plugin to start a local dev environment.

```sh
npm start
```

## Cloudflare

Use the Cloudflare GUI to import your repo.

Deploy from the CLI with `npx wrangler deploy`.

## Frontend Architecture

See
[this article](https://gomakethings.com/easier-state-management-with-preact-signals/)
for more details about application architecture.

We create application state and logic in the file
[./src/state.ts](./src/state.ts). This exports static functions, creates a
state object, and sets up URL routing.

In the view code, you would call the functions exposed in
[state](./src/state.ts) with a state instance in response to application events.

## Notes
