import { env } from "../../../env"

export const dynamic = "force-dynamic"

export function GET() {
	return Response.json({
		secret: env.SERVER_SECRET,
		databaseUrl: env.DATABASE_URL,
		hasToken: "OP_SERVICE_ACCOUNT_TOKEN" in process.env
	})
}
