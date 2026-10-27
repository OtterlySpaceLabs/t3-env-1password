/**
 * Build phase helpers. This module has no dependencies, so it is safe to import from an
 * `env.ts` file that is also bundled for the browser.
 * @module
 */

/**
 * Set by `withOnePassword` while `next build` runs with `build: "public"`.
 */
export const PUBLIC_BUILD_FLAG = "T3_ENV_1PASSWORD_PUBLIC_BUILD"

/**
 * Whether this is a `next build` that only loaded public variables from 1Password.
 * Server variables are not available until the server starts.
 *
 * @example
 * ```ts
 * export const env = createEnv({
 *   // Only validate client variables during a public build. Reading a server
 *   // variable while prerendering throws instead of baking it into the output.
 *   isServer: isPublicBuild() ? false : undefined,
 *   ...
 * })
 * ```
 */
export function isPublicBuild(): boolean {
	return typeof process !== "undefined" && process.env?.[PUBLIC_BUILD_FLAG] === "1"
}
