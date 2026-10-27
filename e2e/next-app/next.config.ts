import { withOnePassword } from "@otterlyspace/t3-env-1password/next"
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
	output: process.env.E2E_STANDALONE ? "standalone" : undefined,
	typescript: { ignoreBuildErrors: true },
	// The fixture is nested in the repository, which has its own lockfile.
	outputFileTracingRoot: process.cwd(),
	turbopack: { root: process.cwd() }
}

export default withOnePassword(nextConfig, {
	build: process.env.E2E_BUILD_MODE === "public" ? "public" : "all",
	validate: () => import("./src/env.ts")
})
