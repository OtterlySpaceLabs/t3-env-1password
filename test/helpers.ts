import { vi } from "vitest"

import type { OnePasswordClient } from "../src/index.ts"

/**
 * A fake 1Password client serving `variables` from its Environment and `secrets` by reference.
 */
export function fakeClient(variables: Record<string, string> = {}, secrets: Record<string, string> = {}) {
	const getVariables = vi.fn<OnePasswordClient["environments"]["getVariables"]>((_environmentId) =>
		Promise.resolve({
			variables: Object.entries(variables).map(([name, value]) => ({ name, value, masked: true }))
		})
	)
	const resolveAll = vi.fn<OnePasswordClient["secrets"]["resolveAll"]>((references) =>
		Promise.resolve({
			individualResponses: Object.fromEntries(
				references.map((reference) => [
					reference,
					reference in secrets
						? { content: { secret: secrets[reference] ?? "", itemId: "item", vaultId: "vault" } }
						: { error: { type: "itemNotFound" as const } }
				])
			)
		})
	)
	const client = {
		environments: { getVariables },
		secrets: { resolve: vi.fn<OnePasswordClient["secrets"]["resolve"]>(), resolveAll }
	} satisfies OnePasswordClient
	return { client, getVariables, resolveAll }
}
