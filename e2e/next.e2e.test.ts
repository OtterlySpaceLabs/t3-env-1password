/**
 * End-to-end tests against a real Next.js app, using the packed package and a fake 1Password SDK.
 * Checks that variables are loaded at build time and at runtime, and that no secret ends up in the build output.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, test } from "vitest"

const root = join(import.meta.dirname, "..")
const tmp = join(import.meta.dirname, ".tmp")
const app = join(tmp, "next-app")
const dataFile = join(tmp, "data.json")
const logFile = join(tmp, "log.jsonl")

const TOKEN = "ops_e2e_fake_token_123456"
const PUBLIC_VALUE = "otterly-public-site"
const ENVIRONMENT_ID = "env-e2e"

function secrets(version: string) {
	return { secret: `server-secret-${version}-xyz`, databaseUrl: `postgres://secret-db-host-${version}/db` }
}

/** Serve version `version` of the secrets from the fake 1Password. */
async function writeData(version: string) {
	const { secret, databaseUrl } = secrets(version)
	await writeFile(
		dataFile,
		JSON.stringify({
			token: TOKEN,
			environments: {
				[ENVIRONMENT_ID]: {
					NEXT_PUBLIC_SITE_NAME: PUBLIC_VALUE,
					SERVER_SECRET: secret,
					DATABASE_URL: "op://vault/db/url"
				}
			},
			secrets: { "op://vault/db/url": databaseUrl }
		})
	)
}

async function calls(): Promise<string[]> {
	const log = await readFile(logFile, "utf8").catch(() => "")
	return log
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const entry: unknown = JSON.parse(line)
			return typeof entry === "object" && entry && "call" in entry ? String(entry.call) : ""
		})
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NEXT_TELEMETRY_DISABLED: "1",
		OP_SERVICE_ACCOUNT_TOKEN: TOKEN,
		OP_ENVIRONMENT_ID: ENVIRONMENT_ID,
		FAKE_OP_DATA: dataFile,
		FAKE_OP_LOG: logFile,
		...extra
	}
	// Next.js sets NODE_ENV itself.
	Reflect.deleteProperty(env, "NODE_ENV")
	return env
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = app): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env })
		let output = ""
		child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
		child.on("error", reject)
		child.on("exit", (code) =>
			code === 0
				? resolve(output)
				: reject(new Error(`${command} ${args.join(" ")} exited with ${code}:\n${output}`))
		)
	})
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.on("error", reject)
		server.listen(0, () => {
			const address = server.address()
			server.close(() => resolve(typeof address === "object" && address ? address.port : 0))
		})
	})
}

const servers: ChildProcess[] = []

async function serve(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	const port = await freePort()
	const child = spawn(command, args, {
		cwd: app,
		env: { ...env, PORT: String(port), HOSTNAME: "127.0.0.1" },
		detached: true
	})
	servers.push(child)
	let output = ""
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))

	const url = `http://127.0.0.1:${port}`
	const deadline = Date.now() + 60_000
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}:\n${output}`)
		try {
			const response = await fetch(`${url}/api/secret`)
			if (response.ok) return url
		} catch {
			// Not listening yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	throw new Error(`Server did not start:\n${output}`)
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		if (server.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM")
	}
	await rm(logFile, { force: true })
})

/** Paths of the files under `dir` containing `value`. */
async function filesContaining(dir: string, value: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true })
	const matches: string[] = []
	for (const entry of entries) {
		if (!entry.isFile()) continue
		const path = join(entry.parentPath, entry.name)
		if ((await readFile(path, "utf8")).includes(value)) matches.push(path)
	}
	return matches
}

async function expectNoSecretsIn(dir: string, version: string) {
	for (const value of [TOKEN, ...Object.values(secrets(version))]) {
		expect({ value, files: await filesContaining(dir, value) }).toEqual({ value, files: [] })
	}
}

async function getSecret(url: string): Promise<unknown> {
	return (await fetch(`${url}/api/secret`)).json()
}

const next = join(app, "node_modules", ".bin", "next")

beforeAll(async () => {
	await rm(tmp, { recursive: true, force: true })
	await mkdir(tmp, { recursive: true })
	await run("pnpm", ["run", "build"], process.env, root)
	await run("pnpm", ["pack", "--out", join(tmp, "package.tgz")], process.env, root)
	await cp(join(import.meta.dirname, "fake-1password-sdk"), join(tmp, "fake-1password-sdk"), { recursive: true })
	await cp(join(import.meta.dirname, "next-app"), app, { recursive: true })
	await run("pnpm", ["install", "--ignore-workspace", "--no-frozen-lockfile"], process.env)
})

describe("next build (all variables) + next start", () => {
	beforeAll(async () => {
		await writeData("v1")
		await rm(join(app, ".next"), { recursive: true, force: true })
		await run(next, ["build"], baseEnv())
	})

	test("validates and inlines public variables without leaking secrets into the build output", async () => {
		expect(await filesContaining(join(app, ".next", "static"), PUBLIC_VALUE)).not.toEqual([])
		await expectNoSecretsIn(join(app, ".next"), "v1")
	})

	test("loads secrets when the server starts, and removes the token", async () => {
		await writeData("v2")
		const url = await serve(next, ["start"], baseEnv())

		expect(await getSecret(url)).toEqual({ ...secrets("v2"), hasToken: false })
		expect(await (await fetch(url)).text()).toContain(PUBLIC_VALUE)
		expect(await calls()).toEqual(["createClient", "getVariables", "resolveAll"])
	})
})

describe('next build (build: "public") + standalone server', () => {
	beforeAll(async () => {
		await writeData("v1")
		await rm(join(app, ".next"), { recursive: true, force: true })
		await run(next, ["build"], baseEnv({ E2E_BUILD_MODE: "public", E2E_STANDALONE: "1" }))
		await cp(join(app, ".next", "static"), join(app, ".next", "standalone", ".next", "static"), {
			recursive: true
		})
	})

	test("never loads server variables during the build", async () => {
		expect(await filesContaining(join(app, ".next", "static"), PUBLIC_VALUE)).not.toEqual([])
		await expectNoSecretsIn(join(app, ".next"), "v1")
	})

	test("loads secrets from instrumentation.ts when the standalone server starts", async () => {
		await writeData("v2")
		const url = await serve("node", [join(app, ".next", "standalone", "server.js")], baseEnv())

		expect(await getSecret(url)).toEqual({ ...secrets("v2"), hasToken: false })
		expect(await (await fetch(url)).text()).toContain(PUBLIC_VALUE)
	})
})

test("next dev loads every variable", async () => {
	await writeData("v1")
	const url = await serve(next, ["dev"], baseEnv())
	expect(await getSecret(url)).toEqual({ ...secrets("v1"), hasToken: false })
	expect(await (await fetch(url)).text()).toContain(PUBLIC_VALUE)
})

test("t3-env-1password run passes variables to the command", async () => {
	await writeData("v1")
	const script =
		"console.log(JSON.stringify([process.env.SERVER_SECRET, process.env.DATABASE_URL, process.env.OP_SERVICE_ACCOUNT_TOKEN ?? null]))"
	const output = await run(
		join(app, "node_modules", ".bin", "t3-env-1password"),
		["run", "--", "node", "-e", script],
		baseEnv()
	)
	expect(JSON.parse(output)).toEqual([...Object.values(secrets("v1")), null])
})
