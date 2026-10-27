import type { NextConfig } from "next"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { LOADED_FLAG } from "../src/index.ts"
import { withOnePassword } from "../src/next.ts"
import { PUBLIC_BUILD_FLAG, isPublicBuild } from "../src/phase.ts"
import { fakeClient } from "./helpers.ts"

const context = { defaultConfig: {} as NextConfig }
const original = { ...process.env }

beforeEach(() => {
	process.env.OP_ENVIRONMENT_ID = "env-id"
	process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_service_account_token"
})

afterEach(() => {
	for (const key of Object.keys(process.env)) delete process.env[key]
	Object.assign(process.env, original)
})

function environment() {
	return fakeClient({ NEXT_PUBLIC_SITE: "otterly", SERVER_SECRET: "server-secret-value" })
}

describe("withOnePassword", () => {
	test("loads every variable when the dev server and production server start", async () => {
		for (const phase of ["phase-development-server", "phase-production-server"]) {
			delete process.env[LOADED_FLAG]
			const { client } = environment()
			await withOnePassword({}, { client })(phase, context)
			expect(process.env.SERVER_SECRET).toBe("server-secret-value")
			expect(process.env.NEXT_PUBLIC_SITE).toBe("otterly")
		}
	})

	test("removes the service account token after loading", async () => {
		await withOnePassword({}, { client: environment().client })("phase-development-server", context)
		expect(process.env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN")
	})

	test("only loads public variables during a public build", async () => {
		await withOnePassword({}, { client: environment().client, build: "public" })("phase-production-build", context)
		expect(process.env.NEXT_PUBLIC_SITE).toBe("otterly")
		expect(process.env).not.toHaveProperty("SERVER_SECRET")
		expect(process.env[PUBLIC_BUILD_FLAG]).toBe("1")
		expect(isPublicBuild()).toBe(true)
	})

	test("loads every variable during a build by default", async () => {
		await withOnePassword({}, { client: environment().client })("phase-production-build", context)
		expect(process.env.SERVER_SECRET).toBe("server-secret-value")
		expect(isPublicBuild()).toBe(false)
	})

	test("does not contact 1Password for next info", async () => {
		const { client, getVariables } = environment()
		await withOnePassword({}, { client })("phase-info", context)
		expect(getVariables).not.toHaveBeenCalled()
	})

	test("validates after the variables are loaded", async () => {
		const validate = vi.fn<() => Promise<void>>(() => {
			expect(process.env.SERVER_SECRET).toBe("server-secret-value")
			return Promise.resolve()
		})
		await withOnePassword({}, { client: environment().client, validate })("phase-production-build", context)
		expect(validate).toHaveBeenCalledOnce()
	})

	test("adds the SDK to serverExternalPackages and supports config functions", async () => {
		const config = await withOnePassword(
			(phase) => ({ serverExternalPackages: ["sharp"], env: { PHASE: phase } }),
			{ client: environment().client }
		)("phase-production-build", context)
		expect(config.env).toEqual({ PHASE: "phase-production-build" })
		expect(config.serverExternalPackages).toEqual([
			"sharp",
			"@1password/sdk",
			"@1password/sdk-core",
			"@otterlyspace/t3-env-1password"
		])
	})

	describe("prevents leaking secrets to the browser through the env option", () => {
		test.each([
			["by name", { SERVER_SECRET: "anything" }],
			["by value", { RENAMED: "server-secret-value" }],
			["the service account token", { TOKEN: "ops_service_account_token" }]
		])("%s", async (_, env) => {
			await expect(
				withOnePassword({ env }, { client: environment().client })("phase-production-build", context)
			).rejects.toThrow(/exposes server secrets from 1Password to the browser/)
		})

		test("allows public variables", async () => {
			const config = await withOnePassword(
				{ env: { NEXT_PUBLIC_SITE: "otterly", SITE: "otterly" } },
				{ client: environment().client }
			)("phase-production-build", context)
			expect(config.env).toEqual({ NEXT_PUBLIC_SITE: "otterly", SITE: "otterly" })
		})
	})
})
