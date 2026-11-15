import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createCustomer, listCustomers } from "@/lib/customers";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);

/** GET /api/customers?q=&limit=&offset= (dispatcher) -> { customers: (Customer & { siteCount })[], hasMore } */
export async function GET(request: Request) {
  try {
    const user = await requireRole("dispatcher");
    return Response.json(await listCustomers(user, query(request)));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/customers (dispatcher) body { name, phone, email?, notes?, clientOpId? } -> 201 { customer } (200 on a replayed clientOpId) */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireRole("dispatcher");
    const { customer, created } = await createCustomer(user, await readJson(request));
    return Response.json({ customer }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
