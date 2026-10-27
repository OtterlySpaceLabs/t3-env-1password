"use client"

import { env } from "../env"

export function SiteName() {
	return <h1 id="site-name">{env.NEXT_PUBLIC_SITE_NAME}</h1>
}
