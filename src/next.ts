/**
 * Next.js integration: load 1Password variables before Next.js reads `process.env`,
 * for `next dev`, `next build` and `next start`.
 * @module
 */
import type { NextConfig } from "next"

import { CREDENTIAL_VARIABLES, type PopulateEnvOptions, populateEnv } from "./index.ts"
import { PUBLIC_BUILD_FLAG } from "./phase.ts"

const PUBLIC_PREFIX = "NEXT_PUBLIC_"

// The SDK loads a WASM file and the desktop app's native library from disk, so it must not be bundled.
const SERVER_EXTERNAL_PACKAGES = ["@1password/sdk", "@1password/sdk-core", "@otterlyspace/t3-env-1password"]

// Secrets shorter than this are not matched by value, to avoid false positives like "true".
const MIN_SECRET_LENGTH = 8

type NextConfigFactory = (phase: string, context: { defaultConfig: NextConfig }) => NextConfig | Promise<NextConfig>

export interface WithOnePasswordOptions extends Omit<PopulateEnvOptions, "env" | "include"> {
	/**
	 * Which variables `next build` loads from 1Password.
	 * - `"all"`: every variable, so the whole schema is validated during the build.
	 * - `"public"`: only `NEXT_PUBLIC_` variables, which Next.js inlines into the client bundle.
	 *   Server variables never reach the build and are loaded when the server starts.
	 *   Use `isPublicBuild()` from `@otterlyspace/t3-env-1password/phase` in your env file.
	 * @default "all"
	 */
	build?: "all" | "public"

	/**
	 * Called after the variables are loaded, to validate them with your env file.
	 * Replaces a top-level `import "./src/env"`, which would run before anything is loaded.
	 * @example () => import("./src/env")
	 */
	validate?: () => Promise<unknown>
}

function isPublic(name: string): boolean {
	return name.startsWith(PUBLIC_PREFIX)
}

/**
 * Throw if the `env` option of the Next.js config, which is inlined into the client bundle,
 * contains a server variable loaded from 1Password or a 1Password credential.
 */
function assertNoClientLeaks(config: NextConfig, loaded: string[], credentials: (string | undefined)[]): void {
	const secretNames = new Set(loaded.filter((name) => !isPublic(name)))
	const secretValues = new Set(
		[...[...secretNames].map((name) => process.env[name]), ...credentials].filter(
			(value): value is string => !!value && value.length >= MIN_SECRET_LENGTH
		)
	)
	const leaks = Object.entries(config.env ?? {})
		.filter(([key, value]) => secretNames.has(key) || (value !== undefined && secretValues.has(value)))
		.map(([key]) => key)
	if (leaks.length > 0) {
		throw new Error(
			`❌ The \`env\` option of your Next.js config exposes server secrets from 1Password to the browser: ${leaks.join(", ")}. ` +
				`Rename them with the ${PUBLIC_PREFIX} prefix if they are meant to be public.`
		)
	}
}

/**
 * Wrap your Next.js config to load variables from 1Password.
 *
 * - `next dev` and `next start` load every variable when the config is read.
 * - `next build` loads every variable, or only public ones with `build: "public"`.
 * - The 1Password SDK is added to `serverExternalPackages`.
 *
 * For standalone output and serverless platforms, where the config isn't read at runtime,
 * also import `@otterlyspace/t3-env-1password/register` from `instrumentation.ts`.
 *
 * @example
 * ```ts
 * export default withOnePassword(nextConfig, { validate: () => import("./src/env") })
 * ```
 */
export function withOnePassword(
	config: NextConfig | NextConfigFactory,
	options: WithOnePasswordOptions = {}
): NextConfigFactory {
	const { build = "all", validate, ...populateOptions } = options

	return async (phase, context) => {
		const credentials = CREDENTIAL_VARIABLES.map((name) => process.env[name])
		let loaded: string[] = []

		// `next info` only prints system information.
		if (phase !== "phase-info") {
			const isBuild = phase === "phase-production-build" || phase === "phase-export"
			const publicOnly = isBuild && build === "public"
			if (publicOnly) process.env[PUBLIC_BUILD_FLAG] = "1"

			loaded = await populateEnv({ ...populateOptions, include: publicOnly ? isPublic : undefined })
			if (publicOnly && loaded.some((name) => !isPublic(name))) {
				console.warn(
					"⚠️ 1Password server variables were loaded before `next build`, e.g. by `t3-env-1password run`. " +
						'They are available to the build despite `build: "public"`.'
				)
			}
			await validate?.()
		}

		const resolved = typeof config === "function" ? await config(phase, context) : config
		assertNoClientLeaks(resolved, loaded, credentials)
		return {
			...resolved,
			serverExternalPackages: [
				...new Set([...(resolved.serverExternalPackages ?? []), ...SERVER_EXTERNAL_PACKAGES])
			]
		}
	}
}
