import { listUsers } from "@/lib/admin";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/** GET /api/admin/users?q=&limit= (admin) -> { users: { id, name, email, role, createdAt }[] } */
export async function GET(request: Request) {
  try {
    const user = await requireRole("admin");
    return Response.json(await listUsers(user, query(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
