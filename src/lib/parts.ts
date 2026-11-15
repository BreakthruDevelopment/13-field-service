import "server-only";
import { type SQL, and, asc, count, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError, VersionConflictError } from "@/lib/errors";
import { text } from "@/lib/text";
import { writeTx } from "@/lib/write-tx";

/**
 * The parts catalog. Dispatchers write; technicians and dispatchers read (technicians see active parts only).
 * The SKU is the key the AI work order matches on (13.3), so it is set at creation and never changes.
 */

const { part } = schema;

export const MAX_PARTS = 500;

export type PartDto = {
  id: string;
  sku: string;
  name: string;
  unit: (typeof schema.PART_UNITS)[number];
  aliases: string[];
  maxPerJob: number;
  active: boolean;
  version: number;
};

const toPart = (r: typeof part.$inferSelect): PartDto => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  unit: r.unit,
  aliases: r.aliases,
  maxPerJob: r.maxPerJob,
  active: r.active,
  version: r.version,
});

const aliases = z.array(text(60, { min: 1 })).max(10);

export const newPartInput = z.strictObject({
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,40}$/, "SKU is 2 to 40 letters, digits or dashes"),
  name: text(120, { min: 1, minMessage: "Name is required" }),
  unit: z.enum(schema.PART_UNITS).default("each"),
  aliases: aliases.default([]),
  maxPerJob: z.number().int().min(1).max(9999).default(20),
  active: z.boolean().default(true),
  clientOpId: z.string().uuid().optional(),
});

export const partPatchInput = z.strictObject({
  version: z.number().int().min(1),
  name: text(120, { min: 1, minMessage: "Name is required" }).optional(),
  unit: z.enum(schema.PART_UNITS).optional(),
  aliases: aliases.optional(),
  maxPerJob: z.number().int().min(1).max(9999).optional(),
  active: z.boolean().optional(),
});

export const partListQuery = z.strictObject({
  q: text(100).optional(),
  /** Dispatchers only; technicians always get active parts. */
  includeInactive: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/** Words of the search text, lower-cased, reduced to characters that can't break out of a tsquery lexeme. */
export function searchWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9/.\-]/g, ""))
    .filter(Boolean)
    .slice(0, 8);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const haystack = sql`(${part.sku} || ' ' || ${part.name} || ' ' || fs_part_search_text(${part.aliases}))`;

export async function listParts(actor: Actor, input: unknown): Promise<{ parts: PartDto[]; hasMore: boolean }> {
  assertCan(actor, "read", "part");
  const f = partListQuery.parse(input ?? {});
  const filters: (SQL | undefined)[] = [];
  if (actor.role !== "dispatcher" || !f.includeInactive) filters.push(eq(part.active, true));
  const words = f.q ? searchWords(f.q) : [];
  let rank: SQL | undefined;
  if (words.length) {
    // Every word must match, as a word prefix in the tsvector (the GIN index) or as a substring (SKUs like 1/2 and 14-2).
    for (const w of words) {
      filters.push(or(sql`${part.search} @@ to_tsquery('simple', ${`'${w}':*`})`, sql`${haystack} ilike ${`%${escapeLike(w)}%`}`));
    }
    rank = sql`ts_rank(${part.search}, plainto_tsquery('simple', ${words.join(" ")}))`;
  }
  const rows = await db()
    .select()
    .from(part)
    .where(and(...filters))
    .orderBy(...(rank ? [desc(rank)] : []), asc(part.sku))
    .limit(f.limit + 1)
    .offset(f.offset);
  return { parts: rows.slice(0, f.limit).map(toPart), hasMore: rows.length > f.limit };
}

export async function createPart(actor: Actor, input: unknown): Promise<{ part: PartDto; created: boolean }> {
  assertCan(actor, "create", "part");
  const data = newPartInput.parse(input);
  return writeTx(actor, async (tx) => {
    if (data.clientOpId) {
      const [existing] = await tx.select().from(part).where(and(eq(part.createdBy, actor.id), eq(part.clientOpId, data.clientOpId)));
      if (existing) return { part: toPart(existing), created: false };
    }
    const [{ n }] = await tx.select({ n: count() }).from(part);
    if (n >= MAX_PARTS) throw new ConflictError("The catalog is full (500 parts).");
    const [row] = await tx
      .insert(part)
      .values({ ...data, aliases: data.aliases, clientOpId: data.clientOpId ?? null, createdBy: actor.id })
      .onConflictDoNothing()
      .returning();
    if (row) return { part: toPart(row), created: true };
    // Either a parallel request with the same op id won, or the SKU is taken.
    if (data.clientOpId) {
      const [existing] = await tx.select().from(part).where(and(eq(part.createdBy, actor.id), eq(part.clientOpId, data.clientOpId)));
      if (existing) return { part: toPart(existing), created: false };
    }
    throw new ConflictError("A part with that SKU already exists.");
  });
}

export async function updatePart(actor: Actor, id: string, input: unknown): Promise<PartDto> {
  assertCan(actor, "update", "part");
  const partId = z.string().uuid().parse(id);
  const { version, ...fields } = partPatchInput.parse(input);
  return writeTx(actor, async (tx) => {
    const [row] = await tx
      .update(part)
      .set({ ...fields, version: version + 1, updatedAt: new Date() })
      .where(and(eq(part.id, partId), eq(part.version, version)))
      .returning();
    if (row) return toPart(row);
    const [current] = await tx.select().from(part).where(eq(part.id, partId));
    if (!current) throw new NotFoundError("Part not found");
    throw new VersionConflictError(toPart(current));
  });
}
