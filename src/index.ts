/**
 * Load variables from a 1Password Environment and resolve `op://` secret references,
 * so the result can be validated by t3-env.
 * @module
 */
import type { Client, createClient } from "@1password/sdk"

type ClientConfiguration = Parameters<typeof createClient>[0]

export type RuntimeEnv = Record<string, string | undefined>

/**
 * The subset of the 1Password SDK client used by this package.
 */
export type OnePasswordClient = Pick<Client, "environments" | "secrets">

/**
 * How to authenticate against 1Password.
 * - `{ serviceAccountToken }` for CI, servers and containers.
 * - `{ desktopAccount }` for local development through the 1Password desktop app.
 */
export type OnePasswordAuth = { serviceAccountToken: string } | { desktopAccount: string }

export interface LoadEnvOptions {
	/**
	 * The variables to pass through. Values that are `op://` references are resolved.
	 * @default process.env
	 */
	env?: RuntimeEnv

	/**
	 * The ID of the 1Password Environment to load variables from.
	 * @default env.OP_ENVIRONMENT_ID
	 */
	environmentId?: string

	/**
	 * How to authenticate. When omitted it is detected from `env`:
	 * `OP_SERVICE_ACCOUNT_TOKEN` selects a service account,
	 * `OP_ACCOUNT_NAME` (or `OP_ACCOUNT`) selects the desktop app.
	 */
	auth?: OnePasswordAuth

	/**
	 * Whether values from the 1Password Environment override variables already present in `env`.
	 * Matches the precedence of `op run --environment`.
	 * @default true
	 */
	override?: boolean

	/**
	 * Only load and resolve the variables whose name passes this filter.
	 * Other variables are passed through untouched.
	 * @default () => true
	 */
	include?: (name: string) => boolean

	/**
	 * Extra options for the SDK's `createClient`, e.g. `oidcFetcher` and `workloadDetails`
	 * for workload identity, or your own `integrationName`.
	 */
	clientOptions?: Partial<ClientConfiguration>

	/**
	 * Use an existing client instead of creating one.
	 */
	client?: OnePasswordClient
}

export interface PopulateEnvOptions extends LoadEnvOptions {
	/**
	 * Keep `OP_SERVICE_ACCOUNT_TOKEN` in the environment after loading.
	 * By default it is removed, so application code and child processes can't read it.
	 * @default false
	 */
	keepCredentials?: boolean
}

const REFERENCE_PREFIX = "op://"

/**
 * Set by `populateEnv` to the comma-separated names of the variables loaded from 1Password.
 * Its presence makes later calls in the same process, and in child processes, no-ops.
 */
export const LOADED_FLAG = "T3_ENV_1PASSWORD_LOADED"

/**
 * Variables holding 1Password credentials, removed by `populateEnv`.
 */
export const CREDENTIAL_VARIABLES: readonly string[] = ["OP_SERVICE_ACCOUNT_TOKEN"]

const clients = new Map<string, Promise<OnePasswordClient>>()

function isReference(value: string | undefined): value is string {
	return !!value?.startsWith(REFERENCE_PREFIX)
}

function detectAuth(env: RuntimeEnv): OnePasswordAuth | undefined {
	if (env.OP_SERVICE_ACCOUNT_TOKEN) return { serviceAccountToken: env.OP_SERVICE_ACCOUNT_TOKEN }
	const account = env.OP_ACCOUNT_NAME ?? env.OP_ACCOUNT
	if (account) return { desktopAccount: account }
	return undefined
}

function getClient(
	auth: OnePasswordAuth | undefined,
	clientOptions: Partial<ClientConfiguration> | undefined
): Promise<OnePasswordClient> {
	// Reuse clients so the desktop app only prompts for authorization once per process.
	const key = auth
		? "serviceAccountToken" in auth
			? `token:${auth.serviceAccountToken}`
			: `desktop:${auth.desktopAccount}`
		: "workload"
	let client = clients.get(key)
	if (!client) {
		client = (async () => {
			const sdk = await import("@1password/sdk")
			return sdk.createClient({
				integrationName: "t3-env-1password",
				integrationVersion: "v1",
				...clientOptions,
				auth: auth
					? "serviceAccountToken" in auth
						? auth.serviceAccountToken
						: new sdk.DesktopAuth(auth.desktopAccount)
					: clientOptions?.auth
			})
		})()
		// Don't cache failures, e.g. a dismissed desktop app prompt.
		client.catch(() => clients.delete(key))
		clients.set(key, client)
	}
	return client
}

async function resolveReferences(client: OnePasswordClient, env: RuntimeEnv, keys: string[]): Promise<RuntimeEnv> {
	const references = [...new Set(keys.map((key) => env[key]).filter(isReference))]
	if (references.length === 0) return env

	const { individualResponses } = await client.secrets.resolveAll(references)

	const resolved: RuntimeEnv = { ...env }
	const failures: string[] = []
	for (const key of keys) {
		const value = env[key]
		if (!isReference(value)) continue
		const response = individualResponses[value]
		if (response?.content) {
			resolved[key] = response.content.secret
		} else {
			const error = response?.error
			const reason = error ? (error.message ? `${error.type}: ${error.message}` : error.type) : "no response"
			failures.push(`  ${key} (${value}): ${reason}`)
		}
	}
	if (failures.length > 0) {
		throw new Error(`❌ Failed to resolve 1Password secret references:\n${failures.join("\n")}`)
	}
	return resolved
}

/**
 * Load environment variables from 1Password and report which ones came from it.
 * @internal
 */
export async function loadEnvWithSources(opts: LoadEnvOptions = {}): Promise<{ env: RuntimeEnv; loaded: string[] }> {
	const env = opts.env ?? process.env
	const environmentId = opts.environmentId ?? env.OP_ENVIRONMENT_ID
	const auth = opts.auth ?? detectAuth(env)
	const override = opts.override ?? true
	const include = opts.include ?? (() => true)

	const referenceKeys = Object.keys(env).filter((key) => include(key) && isReference(env[key]))
	if (!environmentId && referenceKeys.length === 0) return { env: { ...env }, loaded: [] }

	if (!opts.client && !auth && !opts.clientOptions?.auth && !opts.clientOptions?.oidcFetcher) {
		throw new Error(
			"❌ 1Password authentication is not configured. Set OP_SERVICE_ACCOUNT_TOKEN to use a service account, " +
				"or OP_ACCOUNT_NAME to use the 1Password desktop app."
		)
	}

	const client = opts.client ?? (await getClient(auth, opts.clientOptions))

	const merged: RuntimeEnv = { ...env }
	const loaded = new Set<string>()
	if (environmentId) {
		const { variables } = await client.environments.getVariables(environmentId)
		for (const { name, value } of variables) {
			if (!include(name) || (!override && env[name] !== undefined)) continue
			merged[name] = value
			loaded.add(name)
		}
	}

	const keys = Object.keys(merged).filter((key) => include(key) && isReference(merged[key]))
	for (const key of keys) loaded.add(key)

	return { env: await resolveReferences(client, merged, keys), loaded: [...loaded] }
}

/**
 * Load environment variables from 1Password.
 *
 * Returns a copy of `env` merged with the variables of the 1Password Environment,
 * where every `op://` reference has been resolved. If no Environment is configured
 * and there are no references, a copy of `env` is returned and the SDK is never loaded.
 *
 * @example
 * ```ts
 * export const env = createEnv({
 *   server: { DATABASE_URL: z.url() },
 *   runtimeEnv: await loadEnv(),
 * })
 * ```
 */
export async function loadEnv(opts: LoadEnvOptions = {}): Promise<RuntimeEnv> {
	return (await loadEnvWithSources(opts)).env
}

/**
 * Load environment variables from 1Password into `process.env` (or `opts.env`).
 *
 * Calls after the first one, in the same process or in child processes, are skipped.
 * Returns the names of the variables loaded from 1Password.
 */
export async function populateEnv(opts: PopulateEnvOptions = {}): Promise<string[]> {
	const target = opts.env ?? process.env
	const previous = target[LOADED_FLAG]
	if (previous !== undefined) return previous ? previous.split(",") : []

	const { env, loaded } = await loadEnvWithSources({ ...opts, env: target })
	Object.assign(target, env)
	target[LOADED_FLAG] = loaded.join(",")
	if (!opts.keepCredentials) {
		for (const name of CREDENTIAL_VARIABLES) delete target[name]
	}
	return loaded
}
