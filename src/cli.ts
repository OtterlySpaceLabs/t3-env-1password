#!/usr/bin/env node
/**
 * Run a command with variables loaded from 1Password.
 *
 * @example
 * ```sh
 * t3-env-1password run -- node server.js
 * t3-env-1password run --environment <id> --account my-team -- pnpm dev
 * ```
 * @module
 */
import { spawn } from "node:child_process"
import { parseArgs } from "node:util"

import { populateEnv } from "./index.ts"

const USAGE = `Usage: t3-env-1password run [options] -- <command> [...args]

Options:
  --environment <id>   1Password Environment ID (default: $OP_ENVIRONMENT_ID)
  --account <name>     Authenticate with the 1Password desktop app (default: $OP_ACCOUNT_NAME)
  --no-override        Keep existing environment variables over 1Password values
  --keep-credentials   Pass OP_SERVICE_ACCOUNT_TOKEN on to the command
  -h, --help           Show this message`

const { values, positionals } = parseArgs({
	allowPositionals: true,
	allowNegative: true,
	options: {
		environment: { type: "string" },
		account: { type: "string" },
		override: { type: "boolean", default: true },
		"keep-credentials": { type: "boolean", default: false },
		help: { type: "boolean", short: "h" }
	}
})

const [subcommand, command, ...args] = positionals
if (values.help || subcommand !== "run" || !command) {
	console.log(USAGE)
	process.exit(values.help ? 0 : 1)
}

const env = { ...process.env }
try {
	await populateEnv({
		env,
		environmentId: values.environment,
		auth: values.account ? { desktopAccount: values.account } : undefined,
		override: values.override,
		keepCredentials: values["keep-credentials"]
	})
} catch (error) {
	console.error(error instanceof Error ? error.message : error)
	process.exit(1)
}

const child = spawn(command, args, { stdio: "inherit", env, shell: process.platform === "win32" })
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => child.kill(signal))
}
child.on("exit", (code, signal) => {
	if (!signal) process.exit(code ?? 1)
	// Exit with the same signal as the child.
	process.removeAllListeners(signal)
	process.kill(process.pid, signal)
})
