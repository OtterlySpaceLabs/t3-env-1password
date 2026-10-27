import { isPublicBuild } from "@otterlyspace/t3-env-1password/phase"
import { createEnv } from "@t3-oss/env-nextjs"
import * as z from "zod"

export const env = createEnv({
	server: {
		SERVER_SECRET: z.string().min(1),
		DATABASE_URL: z.url()
	},
	client: {
		NEXT_PUBLIC_SITE_NAME: z.string().min(1)
	},
	experimental__runtimeEnv: {
		NEXT_PUBLIC_SITE_NAME: process.env.NEXT_PUBLIC_SITE_NAME
	},
	isServer: isPublicBuild() ? false : undefined
})
