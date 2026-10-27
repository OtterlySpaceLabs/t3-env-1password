export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		await import("@otterlyspace/t3-env-1password/register")
	}
}
