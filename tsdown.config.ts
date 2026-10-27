import { defineConfig } from "tsdown"

export default defineConfig({
	entry: ["src/index.ts", "src/register.ts", "src/next.ts", "src/phase.ts", "src/cli.ts"],
	tsconfig: "tsconfig.build.json",
	format: "esm",
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	unbundle: true,
	fixedExtension: false,
	clean: true,
	publint: true
})
