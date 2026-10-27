import { createEnv } from "@t3-oss/env-core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import * as z from "zod"

import { LOADED_FLAG, type RuntimeEnv, loadEnv, populateEnv } from "../src/index.ts"
import { fakeClient } from "./helpers.ts"

const sdk = vi.hoisted(() => ({
	createClient: vi.fn<(config: { auth?: unknown }) => Promise<unknown>>(),
	DesktopAuth: class DesktopAuth {
		accountName: string
		constructor(accountName: string) {
			this.accountName = accountName
		}
	}
}))
vi.mock("@1password/sdk", () => sdk)

beforeEach(() => {
	sdk.createClient.mockReset()
})

describe("passthrough", () => {
	test("returns env unchanged without loading the SDK when nothing is configured", async () => {
		await expect(loadEnv({ env: { PORT: "3000" } })).resolves.toEqual({ PORT: "3000" })
		expect(sdk.createClient).not.toHaveBeenCalled()
	})

	test("does not mutate the input", async () => {
		const env = { OP_ENVIRONMENT_ID: "env", A: "1" }
		await loadEnv({ env, client: fakeClient({ B: "2" }).client })
		expect(env).toEqual({ OP_ENVIRONMENT_ID: "env", A: "1" })
	})
})

describe("environments", () => {
	test("merges environment variables over env", async () => {
		const { client, getVariables } = fakeClient({ SECRET: "from-1p", SHARED: "from-1p" })
		const env = { OP_ENVIRONMENT_ID: "env-id", SHARED: "local", PORT: "3000" }

		await expect(loadEnv({ env, client })).resolves.toEqual({
			OP_ENVIRONMENT_ID: "env-id",
			SECRET: "from-1p",
			SHARED: "from-1p",
			PORT: "3000"
		})
		expect(getVariables).toHaveBeenCalledWith("env-id")
	})

	test("keeps existing variables with override: false", async () => {
		const { client } = fakeClient({ SHARED: "from-1p" })
		const result = await loadEnv({ env: { SHARED: "local" }, environmentId: "env-id", override: false, client })
		expect(result.SHARED).toBe("local")
	})

	test("only loads variables passing the include filter", async () => {
		const { client, resolveAll } = fakeClient(
			{ NEXT_PUBLIC_URL: "https://example.com", SECRET: "from-1p" },
			{ "op://v/public/f": "public-value" }
		)
		const result = await loadEnv({
			env: { OP_ENVIRONMENT_ID: "env-id", NEXT_PUBLIC_KEY: "op://v/public/f", DATABASE_URL: "op://v/db/url" },
			include: (name) => name.startsWith("NEXT_PUBLIC_"),
			client
		})
		expect(result).toEqual({
			OP_ENVIRONMENT_ID: "env-id",
			NEXT_PUBLIC_URL: "https://example.com",
			NEXT_PUBLIC_KEY: "public-value",
			DATABASE_URL: "op://v/db/url"
		})
		expect(resolveAll).toHaveBeenCalledWith(["op://v/public/f"])
	})
})

describe("secret references", () => {
	test("resolves op:// references from env and the environment", async () => {
		const { client } = fakeClient(
			{ API_KEY: "op://vault/api/key" },
			{ "op://vault/db/url": "postgres://db", "op://vault/api/key": "sk_123" }
		)
		const result = await loadEnv({
			env: { OP_ENVIRONMENT_ID: "env-id", DATABASE_URL: "op://vault/db/url", PORT: "3000" },
			client
		})
		expect(result).toMatchObject({ DATABASE_URL: "postgres://db", API_KEY: "sk_123", PORT: "3000" })
	})

	test("deduplicates references", async () => {
		const { client, resolveAll } = fakeClient({}, { "op://v/i/f": "secret" })
		const result = await loadEnv({ env: { A: "op://v/i/f", B: "op://v/i/f" }, client })
		expect(result).toEqual({ A: "secret", B: "secret" })
		expect(resolveAll).toHaveBeenCalledWith(["op://v/i/f"])
	})

	test("reports every failed reference without leaking resolved values", async () => {
		const { client } = fakeClient({}, { "op://v/ok/f": "super-secret" })
		const promise = loadEnv({ env: { OK: "op://v/ok/f", A: "op://v/a/f", B: "op://v/b/f" }, client })
		await expect(promise).rejects.toThrow(/A \(op:\/\/v\/a\/f\): itemNotFound\n.*B \(op:\/\/v\/b\/f\)/)
		await expect(promise).rejects.not.toThrow(/super-secret/)
	})
})

describe("authentication", () => {
	test("throws a helpful error when 1Password is needed but auth is missing", async () => {
		await expect(loadEnv({ env: { OP_ENVIRONMENT_ID: "env-id" } })).rejects.toThrow(
			/OP_SERVICE_ACCOUNT_TOKEN.*OP_ACCOUNT_NAME/
		)
	})

	test("uses a service account token from env", async () => {
		sdk.createClient.mockResolvedValue(fakeClient({ A: "1" }).client)
		await loadEnv({ env: { OP_ENVIRONMENT_ID: "env-id", OP_SERVICE_ACCOUNT_TOKEN: "ops_token" } })
		expect(sdk.createClient).toHaveBeenCalledWith(
			expect.objectContaining({ auth: "ops_token", integrationName: "t3-env-1password" })
		)
	})

	test("uses the desktop app with OP_ACCOUNT_NAME", async () => {
		sdk.createClient.mockResolvedValue(fakeClient().client)
		await loadEnv({ env: { OP_ENVIRONMENT_ID: "env-id", OP_ACCOUNT_NAME: "my-team" } })
		expect(sdk.createClient.mock.calls[0]?.[0].auth).toStrictEqual(new sdk.DesktopAuth("my-team"))
	})

	test("reuses the client across calls", async () => {
		sdk.createClient.mockResolvedValue(fakeClient().client)
		const env = { OP_ENVIRONMENT_ID: "env-id", OP_ACCOUNT_NAME: "reuse" }
		await loadEnv({ env })
		await loadEnv({ env })
		expect(sdk.createClient).toHaveBeenCalledTimes(1)
	})

	test("retries client creation after a failure", async () => {
		sdk.createClient.mockRejectedValueOnce(new Error("denied")).mockResolvedValue(fakeClient().client)
		const env = { OP_ENVIRONMENT_ID: "env-id", OP_ACCOUNT_NAME: "retry" }
		await expect(loadEnv({ env })).rejects.toThrow("denied")
		await expect(loadEnv({ env })).resolves.toBeDefined()
	})
})

describe("populateEnv", () => {
	test("writes into the target once and records the loaded names", async () => {
		const { client, getVariables } = fakeClient({ A: "1" }, { "op://v/b/f": "2" })
		const env: RuntimeEnv = { OP_ENVIRONMENT_ID: "env-id", B: "op://v/b/f" }

		await expect(populateEnv({ env, client })).resolves.toEqual(["A", "B"])
		await expect(populateEnv({ env, client })).resolves.toEqual(["A", "B"])
		expect(env).toMatchObject({ A: "1", B: "2", [LOADED_FLAG]: "A,B" })
		expect(getVariables).toHaveBeenCalledTimes(1)
	})

	test("is skipped in child processes of a loaded process", async () => {
		const { client, getVariables } = fakeClient({ A: "1" })
		await populateEnv({ env: { OP_ENVIRONMENT_ID: "env-id", [LOADED_FLAG]: "" }, client })
		expect(getVariables).not.toHaveBeenCalled()
	})

	test("removes the service account token unless keepCredentials is set", async () => {
		const { client } = fakeClient({ A: "1" })
		const env: RuntimeEnv = { OP_ENVIRONMENT_ID: "env-id", OP_SERVICE_ACCOUNT_TOKEN: "ops_token" }
		await populateEnv({ env, client })
		expect(env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN")

		const kept: RuntimeEnv = { OP_ENVIRONMENT_ID: "env-id", OP_SERVICE_ACCOUNT_TOKEN: "ops_token" }
		await populateEnv({ env: kept, client, keepCredentials: true })
		expect(kept.OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_token")
	})

	test("can be retried after a failure", async () => {
		const env: RuntimeEnv = { OP_ENVIRONMENT_ID: "env-id" }
		await expect(populateEnv({ env })).rejects.toThrow(/not configured/)
		expect(env).not.toHaveProperty(LOADED_FLAG)
	})
})

test("integrates with createEnv", async () => {
	const { client } = fakeClient({ PORT: "8080" }, { "op://v/db/url": "postgres://localhost/db" })
	const env = createEnv({
		server: { DATABASE_URL: z.url(), PORT: z.coerce.number() },
		runtimeEnv: await loadEnv({ env: { OP_ENVIRONMENT_ID: "env-id", DATABASE_URL: "op://v/db/url" }, client })
	})
	expect(env).toMatchObject({ DATABASE_URL: "postgres://localhost/db", PORT: 8080 })
})
