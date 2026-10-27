# @otterlyspace/t3-env-1password

Load variables from [1Password Environments](https://www.1password.dev/environments) and resolve `op://` secret references for [t3-env](https://env.t3.gg), at build time and at runtime.

- **Configured with environment variables.** Your t3-env schema stays the same.
- **Service accounts** for CI and production, and the **1Password desktop app** for local development.
- **Passthrough**: existing variables are kept, and any `op://vault/item/field` value is replaced with its secret.
- **Next.js support** for `next dev`, `next build`, `next start`, standalone output and serverless platforms. Secrets are loaded when the server starts, and only public variables are inlined into the client bundle.

> [!WARNING]
> **Early release, not certified for production use.**
>
> - This package is new and its API may change in any release. It has not been independently audited, and it has not yet been tested against every 1Password account setup or hosting platform.
> - It handles secrets. Review the code and test it in your own environment, including your build output, before relying on it. You are responsible for how it is used in your projects.
> - It is provided "as is", without warranty of any kind, under the [MIT License](./LICENSE). The authors and OtterlySpace are not liable for any claim, damage or loss arising from its use, including leaked secrets, outages or data loss.
> - It is a community project, not affiliated with or endorsed by 1Password (AgileBits Inc.) or T3 OSS. 1Password is a trademark of AgileBits Inc.
>
> Please report security issues privately through [GitHub security advisories](https://github.com/OtterlySpaceLabs/t3-env-1password/security/advisories/new), not in public issues.

```bash
pnpm add @otterlyspace/t3-env-1password @1password/sdk
```

Requires Node.js 22.12 or later. The 1Password SDK only runs on Node.js, not in Edge runtimes or browsers.

## Configuration

| Variable                   | Purpose                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `OP_ENVIRONMENT_ID`        | The Environment to load. In the desktop app: Developer › View Environments › Copy ID.                                    |
| `OP_SERVICE_ACCOUNT_TOKEN` | Authenticate with a [service account](https://developer.1password.com/docs/service-accounts/) (CI, servers, containers). |
| `OP_ACCOUNT_NAME`          | Authenticate with the desktop app (local development). `OP_ACCOUNT` works too.                                           |

How variables are loaded:

- Values from the Environment override existing variables, the same precedence as `op run --environment`. Pass `override: false` (or `--no-override`) to keep existing values.
- With no `OP_ENVIRONMENT_ID` and no `op://` values, nothing is contacted and the SDK is never loaded.
- `OP_SERVICE_ACCOUNT_TOKEN` is removed from `process.env` once the variables are loaded, so application code and child processes can't read it. Pass `keepCredentials: true` (or `--keep-credentials`) to keep it.
- Variables are loaded once per process. Child processes, such as Next.js build workers, inherit them and don't fetch them again.

**Desktop app:** turn on **Settings › Developer › Integrate with other apps**. The app asks you to authorize once per process.

## Next.js

### 1. Wrap your config

```ts
// next.config.ts
import { withOnePassword } from "@otterlyspace/t3-env-1password/next"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {}

export default withOnePassword(nextConfig, {
	// Validate your env file once the variables are loaded.
	validate: () => import("./src/env.ts")
})
```

This replaces the usual top-level `import "./src/env"`, which would run before anything is loaded. Use `./src/env.js` for a JavaScript env file, like create-t3-app's. Importing a `.ts` file needs Node.js 22.18 or later. Your env file and `experimental__runtimeEnv` don't change.

`withOnePassword` loads variables whenever Next.js reads its config: during `next dev`, `next build` and `next start`. It also adds the 1Password SDK to `serverExternalPackages`.

### 2. Load at runtime when the config isn't read

Standalone output (`node .next/standalone/server.js`) and serverless platforms like Vercel don't read `next.config.ts` when the server starts. Load the variables from [`instrumentation.ts`](https://nextjs.org/docs/app/guides/instrumentation) instead:

```ts
// instrumentation.ts (or src/instrumentation.ts)
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("@otterlyspace/t3-env-1password/register")
	}
}
```

This is safe to add everywhere. When the config has already loaded the variables, it does nothing.

### What ends up where

| Variables                  | Build time                                            | Runtime (server start)      |
| -------------------------- | ----------------------------------------------------- | --------------------------- |
| `NEXT_PUBLIC_*`            | Loaded, validated and inlined into the client bundle. | Loaded                      |
| Server variables           | Loaded and validated (`build: "all"`, default)        | Loaded fresh from 1Password |
| `OP_SERVICE_ACCOUNT_TOKEN` | Removed after loading                                 | Removed after loading       |

How secrets are kept out of the browser:

- Next.js only inlines `NEXT_PUBLIC_*` variables and the config's `env` option into client code.
- `withOnePassword` fails the build if the `env` option exposes a server variable or the service account token, whether by name or by value.
- The end-to-end tests build a real Next.js app and check that no server secret or token is anywhere in `.next`.

Secrets only reach the output if your code renders them into a page that is prerendered at build time.

### Public-only builds

To keep server secrets out of the build entirely, only load public variables during `next build`:

```ts
export default withOnePassword(nextConfig, { build: "public", validate: () => import("./src/env.ts") })
```

Server variables are then only available once the server starts, so validate only client variables during the build:

```ts
// src/env.ts
import { isPublicBuild } from "@otterlyspace/t3-env-1password/phase"

export const env = createEnv({
	// ...
	isServer: isPublicBuild() ? false : undefined
})
```

As a bonus, prerendering a page that reads a server variable now fails the build instead of baking the secret into the HTML. `@otterlyspace/t3-env-1password/phase` has no dependencies, so it is safe in env files that are bundled for the browser.

## Any framework or Node.js server

**Wrap a command.** Secrets are in `process.env` before the command starts:

```jsonc
// package.json
"scripts": {
	"dev": "t3-env-1password run -- vite dev",
	"start": "t3-env-1password run -- node server.js"
}
```

Options: `--environment <id>`, `--account <name>`, `--no-override`, `--keep-credentials`. If you have the 1Password CLI (v2.41+), `op run --environment <id> -- <command>` works too.

**Preload in Node.js:**

```bash
node --import @otterlyspace/t3-env-1password/register server.js
```

**In code**, in modules that only run on the server:

```ts
import { loadEnv } from "@otterlyspace/t3-env-1password"
import { createEnv } from "@t3-oss/env-core"

export const env = createEnv({
	server: { DATABASE_URL: z.url() },
	runtimeEnv: await loadEnv()
})
```

`loadEnv` returns a copy of `process.env` merged with the 1Password values. `populateEnv` writes them into `process.env` instead.

Both modes start before your app runs, so they only see `.env` files loaded before them, e.g. with `node --env-file=.env`. Frameworks that load `.env` files themselves load them too late for the CLI or the preload to resolve `op://` values in them. The Next.js integration doesn't have this problem, because Next.js loads `.env` files before it reads the config.

## API

`loadEnv(options)`, `populateEnv(options)` and `withOnePassword(config, options)` accept:

| Option            | Default              | Description                                                                                            |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `env`             | `process.env`        | Variables to pass through and resolve. Not available for `withOnePassword`.                            |
| `environmentId`   | `$OP_ENVIRONMENT_ID` | The Environment to load.                                                                               |
| `auth`            | detected from env    | `{ serviceAccountToken }` or `{ desktopAccount }`.                                                     |
| `override`        | `true`               | Whether Environment values override existing variables.                                                |
| `include`         | all                  | Only load and resolve variables whose name passes this filter. Not available for `withOnePassword`.    |
| `clientOptions`   |                      | Forwarded to the SDK's `createClient`, e.g. `oidcFetcher` and `workloadDetails` for workload identity. |
| `client`          |                      | Use your own SDK client.                                                                               |
| `keepCredentials` | `false`              | `populateEnv` and `withOnePassword` only: keep `OP_SERVICE_ACCOUNT_TOKEN`.                             |

`withOnePassword` also accepts `build` (`"all"` or `"public"`) and `validate`.

## Limitations

- **Edge runtime.** Reading Environments from an Edge function isn't supported, because the SDK is Node.js only. Self-hosted Next.js passes the server's `process.env` to Edge functions.
- **SDK beta.** Reading Environments through the 1Password SDK is in beta.
- **No CLI login reuse.** The SDK can't use a 1Password CLI session. Use the desktop app, or `op run`.

## Development

```bash
pnpm install
pnpm test        # unit tests
pnpm test:e2e    # builds and runs a Next.js app against a fake 1Password SDK
pnpm lint && pnpm fmt:check && pnpm typecheck
```

Releases are automated with [semantic-release](https://semantic-release.gitbook.io) from [Conventional Commits](https://www.conventionalcommits.org) on `main` (and prereleases on `beta`).
