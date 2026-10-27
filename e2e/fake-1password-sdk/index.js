"use strict"
// CommonJS, like the real SDK.
const fs = require("node:fs")

function data() {
	return JSON.parse(fs.readFileSync(process.env.FAKE_OP_DATA, "utf8"))
}

function log(call) {
	if (process.env.FAKE_OP_LOG)
		fs.appendFileSync(process.env.FAKE_OP_LOG, `${JSON.stringify({ call, pid: process.pid })}\n`)
}

// oxlint-disable-next-line typescript/no-extraneous-class -- mirrors the SDK
class DesktopAuth {
	constructor(accountName) {
		this.accountName = accountName
	}
}

function createClient({ auth }) {
	log("createClient")
	if (auth !== data().token) return Promise.reject(new Error("invalid service account token"))
	return Promise.resolve({
		environments: {
			getVariables(environmentId) {
				log("getVariables")
				const variables = data().environments[environmentId]
				if (!variables) return Promise.reject(new Error(`environment ${environmentId} not found`))
				return Promise.resolve({
					variables: Object.entries(variables).map(([name, value]) => ({ name, value, masked: true }))
				})
			}
		},
		secrets: {
			resolveAll(references) {
				log("resolveAll")
				const { secrets } = data()
				return Promise.resolve({
					individualResponses: Object.fromEntries(
						references.map((ref) => [
							ref,
							ref in secrets
								? { content: { secret: secrets[ref], itemId: "item", vaultId: "vault" } }
								: { error: { type: "itemNotFound" } }
						])
					)
				})
			}
		}
	})
}

module.exports = { createClient, DesktopAuth }
