import { expect, test } from "vitest"

import { loadEnv } from "../src/index.ts"

// Uses the real SDK: checks that its WASM core loads on this Node.js version
// and that authentication errors surface. No 1Password account is needed.
test("surfaces SDK errors for an invalid service account token", async () => {
	await expect(
		loadEnv({ env: { OP_ENVIRONMENT_ID: "env-id", OP_SERVICE_ACCOUNT_TOKEN: "ops_invalid" } })
	).rejects.toThrow(/invalid service account token/)
})
