/**
 * Preload module that loads 1Password variables into `process.env` before your app starts.
 *
 * @example
 * ```sh
 * node --import @otterlyspace/t3-env-1password/register server.js
 * ```
 * @module
 */
import { populateEnv } from "./index.ts"

await populateEnv()
