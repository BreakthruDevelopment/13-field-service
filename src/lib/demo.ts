/**
 * The demo workspace: 2 dispatchers, 3 technicians, 8 customers, 12 sites, 60 parts and 15 jobs today and tomorrow,
 * including "Kitchen sink leaking under cabinet" with notes (the AI work-order fixture in 13.3 matches its SKUs and notes).
 *
 * Deliberately free of `server-only` and `@/` imports so `scripts/seed-demo.mts` can run it with plain tsx. Two callers:
 * - `POST /api/admin/demo` (admin button, any environment): users get no password, so nobody can sign in as them;
 * - `scripts/seed-demo.mts` (guarded by `demoSeedConfig()`, never against production): passes a password so a local or CI
 *   run can sign in as the demo dispatchers and technicians.
 *
 * Rules (see `demo-identity.ts`): demo users are written straight to the database with the marker in `user.image` and an
 * address under `demo.breakthru.test`; an unrelated account that already uses a demo id or email is never touched (409).
 * Loading again replaces the demo customers (and their sites and jobs) and keeps the demo users and parts.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { CAP_LOCKS, MAX_OPEN_JOBS, MAX_PARTS } from "./caps";
import { DEMO_EMAIL_DOMAIN, MARKER } from "./demo-identity";
import { ConflictError } from "./errors";
import * as schema from "./db/schema";

type Exec = Pick<PostgresJsDatabase<typeof schema>, "select" | "insert" | "update" | "delete" | "execute">;

export const DEMO_DISPATCHERS = [
  { id: "demo-fs-dispatcher-1", name: "Dana Whitfield (demo dispatcher)" },
  { id: "demo-fs-dispatcher-2", name: "Marcus Bell (demo dispatcher)" },
];
export const DEMO_TECHNICIANS = [
  { id: "demo-fs-tech-1", name: "Rosa Alvarez (demo technician)" },
  { id: "demo-fs-tech-2", name: "Tom Nguyen (demo technician)" },
  { id: "demo-fs-tech-3", name: "Priya Shah (demo technician)" },
];

type PartSeed = [sku: string, name: string, unit: (typeof schema.PART_UNITS)[number], aliases?: string[], maxPerJob?: number];

export const DEMO_PARTS: PartSeed[] = [
  // Plumbing
  ["PLB-CART-STD", "Faucet cartridge, standard single-handle", "each", ["cartridge", "faucet cartridge"], 4],
  ["PLB-COMP-050", "Compression fitting 1/2 in", "each", ["compression fitting", "compression"], 20],
  ["PLB-ELB-050-CU", "Copper elbow 1/2 in", "each", ["copper elbow", "elbow"], 40],
  ["PLB-PEX-050", "PEX tubing 1/2 in", "ft", ["pex", "pex tubing"], 200],
  ["PLB-VLV-SHUT-050", "Shutoff valve 1/2 in", "each", ["shutoff valve", "angle stop"], 6],
  ["PLB-WH-40G", "Water heater, 40 gallon gas", "each", ["water heater"], 2],
  ["PLB-SUP-12", "Braided supply line 12 in", "each", ["supply line"], 6],
  ["PLB-SUP-16", "Braided supply line 16 in", "each", ["supply line"], 6],
  ["PLB-TRAP-150", "P-trap 1-1/2 in", "each", ["p trap", "trap"], 4],
  ["PLB-WAX-RING", "Toilet wax ring", "each", ["wax ring"], 3],
  ["PLB-FLAPPER", "Toilet flapper", "each", ["flapper"], 4],
  ["PLB-FILL-VLV", "Toilet fill valve", "each", ["fill valve", "ballcock"], 3],
  ["PLB-PTFE-TAPE", "PTFE thread tape", "roll", ["teflon tape", "plumber's tape"], 10],
  ["PLB-CPLG-050-CU", "Copper coupling 1/2 in", "each", ["coupling"], 40],
  ["PLB-TEE-050-CU", "Copper tee 1/2 in", "each", ["tee"], 40],
  ["PLB-PIPE-050-CU", "Copper pipe 1/2 in", "ft", ["copper pipe"], 100],
  ["PLB-SOLDER-LF", "Lead-free solder", "roll", ["solder"], 4],
  ["PLB-DISPOSAL-050", "Garbage disposal 1/2 hp", "each", ["disposal"], 2],
  ["PLB-FAUCET-KIT", "Kitchen faucet, pull-down", "each", ["kitchen faucet"], 2],
  ["PLB-ANODE-ROD", "Water heater anode rod", "each", ["anode"], 2],
  ["PLB-PRV-075", "Pressure relief valve 3/4 in", "each", ["relief valve", "prv"], 2],
  ["PLB-SEALANT-SIL", "Silicone sealant, clear", "each", ["silicone", "caulk"], 6],
  ["PLB-HOSE-CLAMP", "Hose clamps", "box", ["clamps"], 4],
  ["PLB-ESCUTCHEON", "Pipe escutcheon plates", "set", ["escutcheon"], 6],
  // HVAC
  ["HVC-FILT-16X25", "Air filter 16x25x1", "each", ["filter", "16x25"], 12],
  ["HVC-FILT-20X25", "Air filter 20x25x1", "each", ["filter", "20x25"], 12],
  ["HVC-CAP-35-5", "Run capacitor 35/5 uF", "each", ["capacitor", "run cap"], 4],
  ["HVC-CONT-30A", "Contactor 30 A 24 V", "each", ["contactor"], 3],
  ["HVC-BLOWER-MOT", "Blower motor 1/2 hp", "each", ["blower motor"], 2],
  ["HVC-CON-FAN-MOT", "Condenser fan motor", "each", ["fan motor"], 2],
  ["HVC-R410A", "Refrigerant R-410A", "kg", ["r410a", "freon"], 10],
  ["HVC-COND-PUMP", "Condensate pump", "each", ["condensate pump"], 2],
  ["HVC-DRAIN-075", "PVC drain pipe 3/4 in", "ft", ["condensate drain"], 50],
  ["HVC-IGN-HSI", "Hot surface igniter", "each", ["igniter"], 2],
  ["HVC-FLAME-SENS", "Flame sensor", "each", ["flame sensor"], 2],
  ["HVC-TAPE-FOIL", "Foil duct tape", "roll", ["duct tape"], 6],
  ["HVC-FOAM-INS", "Pipe insulation foam", "ft", ["insulation"], 100],
  ["HVC-BELT-A42", "Blower belt A42", "each", ["belt"], 3],
  ["HVC-TXV-3T", "Expansion valve, 3 ton", "each", ["txv"], 1],
  ["HVC-DRIER-083", "Filter drier 3/8 in", "each", ["drier"], 2],
  ["HVC-LINESET-25", "Line set 25 ft", "set", ["line set"], 2],
  ["HVC-PAD-CONDENSER", "Condenser pad", "each", ["pad"], 2],
  // Electrical
  ["ELE-CBL-14-2", "Cable 14/2 NM-B", "ft", ["14/2", "romex"], 250],
  ["ELE-CBL-12-2", "Cable 12/2 NM-B", "ft", ["12/2", "romex"], 250],
  ["ELE-OUT-STD", "Receptacle 15 A", "each", ["outlet"], 20],
  ["ELE-OUT-GFCI", "GFCI receptacle 20 A", "each", ["gfci", "gfci outlet"], 10],
  ["ELE-SW-SP", "Switch, single pole", "each", ["light switch"], 20],
  ["ELE-BRK-20A", "Breaker 20 A single pole", "each", ["breaker"], 6],
  ["ELE-BRK-15A", "Breaker 15 A single pole", "each", ["breaker"], 6],
  ["ELE-BOX-1G", "Electrical box, 1 gang", "each", ["box"], 20],
  ["ELE-BOX-2G", "Electrical box, 2 gang", "each", ["box"], 20],
  ["ELE-WIRENUT", "Wire nuts, assorted", "box", ["wire nuts"], 4],
  ["ELE-EMT-050", "EMT conduit 1/2 in", "ft", ["conduit", "emt"], 200],
  ["ELE-LAMP-A19", "LED lamp A19", "box", ["bulbs", "led bulbs"], 6],
  ["ELE-COVER-STD", "Cover plate", "each", ["wall plate"], 20],
  ["ELE-STAPLES", "Cable staples", "box", ["staples"], 4],
  // General
  ["GEN-ZIPTIES", "Cable ties", "box", ["zip ties"], 4],
  ["GEN-SCREW-KIT", "Assorted screws and anchors", "set", ["screws"], 4],
  ["GEN-CAULK-PAINT", "Paintable caulk", "each", ["caulk"], 6],
  ["GEN-SHOP-RAGS", "Shop rags", "box", ["rags"], 4],
];

const DEMO_CUSTOMERS = [
  { name: "Maple Street Bakery", phone: "555-0101", email: "orders@maplestreetbakery.example", notes: "Call before 6 am; delivery door is at the back." },
  { name: "Harbor Dental Group", phone: "555-0102", email: "office@harbordental.example", notes: "Two locations. Ask for the office manager." },
  { name: "Oakwood Apartments", phone: "555-0103", email: "manager@oakwoodapts.example", notes: "Residents must be notified 24 hours before entry." },
  { name: "Riverside Elementary", phone: "555-0104", email: null, notes: "Check in at the front office; visitor badge required." },
  { name: "Greenfield Community Church", phone: "555-0105", email: "admin@greenfieldchurch.example", notes: "" },
  { name: "Summit Fitness", phone: "555-0106", email: "facilities@summitfitness.example", notes: "Closed Mondays; use the loading dock." },
  { name: "Lopez Residence", phone: "555-0107", email: null, notes: "Dog in the backyard (friendly)." },
  { name: "Patel Family Pharmacy", phone: "555-0108", email: "rx@patelpharmacy.example", notes: "Refrigeration is critical; escalate cooler calls." },
];

// [customer index, label, address, lat, lng, access notes]
const DEMO_SITES: [number, string, string, number | null, number | null, string][] = [
  [0, "Main bakery", "412 Maple Street, Austin, TX 78701", 30.2672, -97.7431, "Back door by the dumpsters."],
  [0, "Catering kitchen", "88 Mill Race Road, Austin, TX 78702", 30.2611, -97.7189, "Gate code 4417."],
  [1, "Downtown office", "1500 Harbor Way, Suite 200, Austin, TX 78701", 30.2701, -97.7452, "Elevator to 2; ring the bell."],
  [1, "North clinic", "9200 Burnet Road, Austin, TX 78758", 30.3712, -97.7253, ""],
  [2, "Building A", "2100 Oakwood Drive, Austin, TX 78704", 30.2405, -97.7692, "Maintenance closet behind the mail room."],
  [2, "Building B", "2110 Oakwood Drive, Austin, TX 78704", 30.2407, -97.7688, ""],
  [3, "Main campus", "700 River Road, Austin, TX 78703", 30.2841, -97.7655, "Gym entrance is on the east side."],
  [4, "Sanctuary and hall", "301 Greenfield Lane, Austin, TX 78745", 30.2093, -97.7988, "Ask for the caretaker."],
  [5, "Summit Fitness", "5500 Summit Parkway, Austin, TX 78759", 30.4021, -97.7545, "Loading dock, east side."],
  [6, "Home", "17 Pecan Court, Austin, TX 78704", 30.2312, -97.7701, "Park on the street."],
  [7, "Pharmacy", "3300 Lamar Boulevard, Austin, TX 78705", 30.3022, -97.7421, "Enter through the pharmacy counter."],
  [7, "Compounding lab", "3302 Lamar Boulevard, Austin, TX 78705", null, null, "Knock; the lab door is locked."],
];

type JobSeed = {
  day: 0 | 1;
  startHour: number | null; // UTC; 13-21 keeps the day the same in US time zones
  hours?: number;
  site: number;
  title: string;
  description: string;
  priority: (typeof schema.JOB_PRIORITIES)[number];
  tech: number | null;
  status: (typeof schema.SERVICE_JOB_STATUSES)[number];
};

export const SINK_JOB_TITLE = "Kitchen sink leaking under cabinet";

const DEMO_JOBS: JobSeed[] = [
  { day: 0, startHour: 13, hours: 1, site: 9, title: SINK_JOB_TITLE, description: "Customer reports water pooling under the kitchen sink since last night. Faucet drips when off.", priority: "high", tech: 0, status: "on_site" },
  { day: 0, startHour: 13, hours: 2, site: 0, title: "Walk-in cooler not cooling", description: "Cooler at 48 F, compressor humming but warm.", priority: "emergency", tech: 1, status: "en_route" },
  { day: 0, startHour: 14, hours: 2, site: 2, title: "Replace failed outlet in exam room 2", description: "Outlet is dead; breaker has not tripped.", priority: "normal", tech: 2, status: "scheduled" },
  { day: 0, startHour: 15, hours: 2, site: 4, title: "Water heater pilot out, unit 4B", description: "Tenant has had no hot water since morning.", priority: "high", tech: 0, status: "scheduled" },
  { day: 0, startHour: 17, hours: 1, site: 8, title: "Quarterly air filter replacement", description: "Replace filters on all six roof units.", priority: "low", tech: 1, status: "scheduled" },
  { day: 0, startHour: 17, hours: 1, site: 6, title: "Gym lights flickering", description: "Three fixtures flicker when the HVAC starts.", priority: "normal", tech: 2, status: "scheduled" },
  { day: 0, startHour: null, site: 7, title: "Install two GFCI outlets in the kitchen", description: "Church kitchen renovation; outlets by the sink.", priority: "normal", tech: null, status: "unassigned" },
  { day: 0, startHour: 13, hours: 1, site: 10, title: "Replace compressor contactor", description: "Display case compressor not starting.", priority: "high", tech: 2, status: "completed" },
  { day: 1, startHour: 13, hours: 2, site: 5, title: "Annual boiler inspection", description: "Yearly inspection and safety valve test.", priority: "normal", tech: 1, status: "scheduled" },
  { day: 1, startHour: 14, hours: 1, site: 3, title: "Clogged hand-wash sink drain", description: "Slow drain in the hygienist room.", priority: "normal", tech: 0, status: "scheduled" },
  { day: 1, startHour: 15, hours: 3, site: 1, title: "Install new exhaust fan", description: "Replace the roof exhaust fan over the ovens.", priority: "normal", tech: 2, status: "scheduled" },
  { day: 1, startHour: 16, hours: 1, site: 9, title: "Furnace short-cycling", description: "Runs two minutes, shuts off, repeats.", priority: "normal", tech: 0, status: "scheduled" },
  { day: 1, startHour: 13, hours: 1, site: 11, title: "Back-room outlet sparks when used", description: "Stop using the outlet until inspected.", priority: "emergency", tech: null, status: "unassigned" },
  { day: 1, startHour: null, site: 6, title: "Toilet running in staff restroom", description: "Keeps running after flushing.", priority: "low", tech: null, status: "unassigned" },
  { day: 1, startHour: 18, hours: 1, site: 7, title: "Annual HVAC filter replacement", description: "Sanctuary and fellowship hall units.", priority: "low", tech: null, status: "unassigned" },
];

const SINK_NOTES = [
  "Arrived. Water pooling under the sink cabinet. Shut off the supply to the faucet.",
  "Faucet cartridge was worn out and leaking: replaced the faucet cartridge. Also replaced 2 compression fittings 1/2in on the hot and cold supply.",
  "Braided supply line 20in is cracked at the nut. Needs replacing next visit, 1 needed. Cabinet floor is dry now.",
];

export type DemoSummary = { dispatchers: number; technicians: number; customers: number; sites: number; parts: number; jobs: number };

const day = (base: Date, offset: number, hour: number) => {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset, hour, 0, 0));
  return d;
};

/** Run inside one transaction. Throws `ConflictError` when a demo id or email already belongs to a real account. */
export async function loadDemoWorkspace(tx: Exec, opts: { now?: Date; password?: string } = {}): Promise<DemoSummary> {
  const now = opts.now ?? new Date();
  // One demo load at a time: the clash check below and the replace-everything delete/insert must not interleave.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CAP_LOCKS.demoLoad}, 0))`);
  const { user, account, customer, site, serviceJob, jobNote, jobEvent, part } = schema;
  const people = [
    ...DEMO_DISPATCHERS.map((p, i) => ({ ...p, role: "dispatcher", email: `fs-dispatcher-${i + 1}@${DEMO_EMAIL_DOMAIN}` })),
    ...DEMO_TECHNICIANS.map((p, i) => ({ ...p, role: "technician", email: `fs-tech-${i + 1}@${DEMO_EMAIL_DOMAIN}` })),
  ];

  // Never take over a real account: a demo id or email held by anything without our marker is a conflict.
  const clash = await tx
    .select({ id: user.id, email: user.email, image: user.image })
    .from(user)
    .where(inArray(user.email, people.map((p) => p.email)));
  const byId = await tx.select({ id: user.id, image: user.image }).from(user).where(inArray(user.id, people.map((p) => p.id)));
  if ([...clash, ...byId].some((u) => u.image !== MARKER)) throw new ConflictError("A real account already uses a demo address. The demo wasn't loaded.");

  for (const p of people) {
    await tx
      .insert(user)
      .values({ id: p.id, name: p.name, email: p.email, emailVerified: true, role: p.role, image: MARKER })
      .onConflictDoUpdate({ target: user.id, set: { name: p.name, role: p.role, image: MARKER, updatedAt: now } });
  }
  if (opts.password) {
    const { hashPassword } = await import("better-auth/crypto");
    const hash = await hashPassword(opts.password);
    for (const p of people) {
      await tx.delete(account).where(and(eq(account.userId, p.id), eq(account.providerId, "credential")));
      await tx.insert(account).values({ id: `${p.id}-credential`, accountId: p.id, providerId: "credential", userId: p.id, password: hash });
    }
  }

  const demoIds = people.map((p) => p.id);
  // Replace the demo customers: their sites, jobs, notes and events go with them (cascade).
  await tx.delete(customer).where(inArray(customer.createdBy, demoIds));

  const dispatcher = DEMO_DISPATCHERS[0].id;
  const customers = await tx
    .insert(customer)
    .values(DEMO_CUSTOMERS.map((c) => ({ ...c, createdBy: dispatcher })))
    .returning({ id: customer.id });
  const sites = await tx
    .insert(site)
    .values(
      DEMO_SITES.map(([ci, label, address, lat, lng, accessNotes]) => ({
        customerId: customers[ci].id,
        label,
        address,
        lat: lat === null ? null : String(lat),
        lng: lng === null ? null : String(lng),
        accessNotes,
        createdBy: dispatcher,
      })),
    )
    .returning({ id: site.id, customerId: site.customerId });

  await tx
    .insert(part)
    .values(DEMO_PARTS.map(([sku, name, unit, aliases, maxPerJob]) => ({ sku, name, unit, aliases: aliases ?? [], maxPerJob: maxPerJob ?? 20, createdBy: dispatcher })))
    .onConflictDoNothing({ target: part.sku });

  for (const j of DEMO_JOBS) {
    const s = sites[j.site];
    const start = j.startHour === null ? null : day(now, j.day, j.startHour);
    const end = start ? new Date(start.getTime() + (j.hours ?? 1) * 3600_000) : null;
    const assignee = j.tech === null ? null : DEMO_TECHNICIANS[j.tech].id;
    const closed = j.status === "completed";
    const [row] = await tx
      .insert(serviceJob)
      .values({
        customerId: s.customerId,
        siteId: s.id,
        title: j.title,
        description: j.description,
        priority: j.priority,
        status: j.status,
        scheduledStart: start,
        scheduledEnd: end,
        assigneeId: assignee,
        createdBy: dispatcher,
        completedAt: closed ? new Date(now.getTime() - 3600_000) : null,
        statusVersion: j.status === "unassigned" ? 1 : j.status === "scheduled" ? 2 : 3,
        version: j.status === "unassigned" ? 1 : j.status === "scheduled" ? 2 : 3,
      })
      .returning({ id: serviceJob.id });
    const ev = (e: Partial<typeof jobEvent.$inferInsert> & Pick<typeof jobEvent.$inferInsert, "kind" | "actorId">) => tx.insert(jobEvent).values({ jobId: row.id, ...e });
    await ev({ kind: "created", actorId: dispatcher, toStatus: "unassigned" });
    if (assignee) await ev({ kind: "assigned", actorId: dispatcher, fromStatus: "unassigned", toStatus: "scheduled" });
    if (j.status === "en_route") await ev({ kind: "status", actorId: assignee!, fromStatus: "scheduled", toStatus: "en_route" });
    if (j.status === "on_site" || closed) {
      const geo = DEMO_SITES[j.site];
      await ev({
        kind: "status",
        actorId: assignee!,
        fromStatus: "scheduled",
        toStatus: "on_site",
        ...(geo[3] !== null && geo[4] !== null ? { lat: geo[3].toFixed(4), lng: (geo[4] + 0.0003).toFixed(4), accuracyM: 18, capturedAt: now } : {}),
      });
    }
    if (j.title === SINK_JOB_TITLE) {
      for (const [i, body] of SINK_NOTES.entries()) {
        await tx.insert(jobNote).values({ jobId: row.id, authorId: assignee!, body, serverAt: new Date(now.getTime() - (SINK_NOTES.length - i) * 600_000) });
      }
    }
    if (closed) {
      await tx.insert(jobNote).values({ jobId: row.id, authorId: assignee!, body: "Replaced the failed contactor and checked amp draw. Compressor starts and holds temperature." });
      await ev({ kind: "status", actorId: assignee!, fromStatus: "on_site", toStatus: "completed" });
    }
  }

  // The demo adds parts and open jobs, so it honours the same caps as the API (cap locks last, same names as the API uses).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CAP_LOCKS.parts}, 0))`);
  const [{ parts }] = await tx.select({ parts: count() }).from(part);
  if (parts > MAX_PARTS) throw new ConflictError("The part catalog is full. The demo wasn't loaded.");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${CAP_LOCKS.openJobs}, 0))`);
  const [{ open }] = await tx.select({ open: count() }).from(serviceJob).where(inArray(serviceJob.status, ["unassigned", "scheduled", "en_route", "on_site", "on_hold"]));
  if (open > MAX_OPEN_JOBS) throw new ConflictError("Too many open jobs. The demo wasn't loaded.");

  return { dispatchers: DEMO_DISPATCHERS.length, technicians: DEMO_TECHNICIANS.length, customers: customers.length, sites: sites.length, parts: DEMO_PARTS.length, jobs: DEMO_JOBS.length };
}
