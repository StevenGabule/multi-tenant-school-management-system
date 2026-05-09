# Designing a Scalable, Multi-Tenant School Management System on NestJS, Prisma, and PostgreSQL

## TL;DR

- **Adopt a tiered hybrid tenancy model** anchored on PostgreSQL Row-Level Security (RLS) for the shared "Pool" tier (~80% of tenants), database-per-tenant "Silo" for premium districts/ministries with strict isolation, FERPA, or data-residency demands, and an optional schema-per-tenant "Bridge" tier for mid-market — with a single tenant registry/control plane that routes traffic and provisioning. This is the only model that gives you cost economics at 1,000+ schools and tens of millions of users while still passing enterprise security reviews.
- **Decompose along DDD bounded contexts (~15–20 services)** clustered into Identity, Academic Core (SIS, Enrollment, Academic Structure, Attendance, Gradebook, Scheduling), Engagement (Communications/Notifications, Parent Portal BFF), Operations (Fees/Payments, Library, Transport, Hostel, Health, Discipline), and Platform (Tenant/Provisioning, Audit, Analytics/Reporting, Document, Integrations). Use REST + JSON between web/mobile and gateway, gRPC or Kafka between services (event-driven where possible, sagas for cross-service transactions like enrollment), and reserve GraphQL Federation only for the BFF aggregation layer.
- **Pick boring, proven infrastructure**: NestJS (Nx monorepo) + Prisma per-service schema, PostgreSQL 16 (with PgBouncer in transaction mode and a Supavisor-style proxy for the silo tier, optionally Citus for the pool tier when row counts blow past ~500M), Redis for cache + BullMQ queues, Kafka (or Redpanda) for the event bus + Debezium CDC into Elasticsearch for search and ClickHouse/BigQuery for analytics, S3-compatible object storage with per-tenant KMS keys, Kubernetes multi-region with Istio/Linkerd for mTLS, and OpenTelemetry with `tenant_id` propagated as baggage on every span/log/metric. Phase 1 MVP can be delivered in ~4–6 months with the pool tier only; silo and multi-region come in Phase 2/3.

---

## Key Findings

1. **The K-12 SIS market is mature, fragmented, and security-conscious.** PowerSchool holds ~23% of K-12 implementations, FACTS ~15%, Infinite Campus ~10%, Skyward ~7%; the long tail (~25%) is the largest segment, signaling room for a modern entrant. Recent district-scale switches (e.g., North Carolina moving from PowerSchool to Infinite Campus) have been driven by both feature gaps and high-profile data breaches — meaning security architecture is now a primary procurement criterion, not a checklist item.
2. **Hybrid tenancy is the consensus best practice for vertical SaaS at this scale.** AWS's SaaS Lens documents the Silo / Pool / Bridge models explicitly and recommends mixing them per service and per customer tier. Pool with PostgreSQL RLS minimizes cost and operational overhead; Silo (DB-per-tenant) is mandatory when customers contractually demand it (ministries, large districts, regulated regions). Schema-per-tenant ("Bridge") sits in the middle but degrades badly past ~5,000–10,000 schemas because of `pg_catalog` performance.
3. **Prisma's multi-tenant story has real, concrete limits you must design around.** Prisma maintains a connection pool per `PrismaClient` instance, which means naive schema-switching or DB-per-tenant approaches can explode connections; the long-running `prisma-multi-tenant` library is unmaintained, and Prisma issues #2077 / #12420 (dynamic schema switching) remain open. The pragmatic pattern is: one `PrismaClient` per service for the pool tier with RLS enforced via `SET LOCAL app.current_tenant_id`, and a small LRU cache of `PrismaClient` instances keyed by tenant for the silo tier, fronted by PgBouncer (transaction pooling).
4. **RLS is the only safe data-isolation control for the pool tier.** Application-level `WHERE tenant_id = ?` filters consistently leak data due to forgotten clauses, complex joins, or background jobs missing tenant context. AWS, Microsoft Azure, Cloudflare, and Nile have all published the same pattern: enable `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`, store tenant context in a Postgres GUC (`current_setting('app.current_tenant_id')`), set it inside every transaction with `SET LOCAL`, and use Prisma's `$extends` or middleware to inject it on every query.
5. **Compliance has architectural weight.** FERPA expects encryption in transit (TLS 1.3) and at rest (AES-256), strict RBAC, and durable audit logs; GDPR adds explicit individual rights (deletion, portability, objection to automated decisions), DPIAs, and cross-border transfer controls; COPPA constrains under-13 data use; and 121+ U.S. state laws (NY Ed Law 2-d, California SOPIPA, etc.) layer on top. Multi-region data residency is therefore not optional for a global product — it must be enforceable both at the database (regional shards/silos) and at the API gateway (region-aware routing).
6. **Khan Academy's evolution is the closest analog and validates this pattern.** They scaled to 30M users in April 2020 by leaning on a managed serverless stack (GCP App Engine, Datastore, Memcache, Fastly CDN) and progressively decomposed into ~20 microservices behind a federated GraphQL gateway. Their public engineering write-ups specifically credit GraphQL federation for letting frontend teams aggregate data across services without forcing a monolith — which is exactly the pattern recommended here for the parent/teacher/student/admin BFFs.
7. **Saga + outbox is the right consistency model for enrollment.** Enrollment routinely touches Identity (create student/parent users), Academic (assign to section/class), Fees (generate invoice), Communications (welcome email), and Document (signed contract). A 2-phase commit across services is impractical; an orchestrated saga (with a dedicated Enrollment service running the workflow on BullMQ or Temporal) plus the transactional outbox pattern feeding Kafka is the durable, testable approach.

---

## Details

### 1. Core Features and Bounded Contexts

After surveying PowerSchool, Infinite Campus, Skyward, FACTS, Synergy, Blackbaud, Ellucian, OpenEduCat, Fedena, RosarioSIS, and the OneRoster/Ed-Fi/LTI standards, the following decomposition reflects both market expectations and DDD-clean boundaries. The rule of thumb is one service per bounded context unless two contexts share the same aggregate root and the same change cadence — in which case start them as modules in one service and split later (Vlad Khononov's reminder that "a Microservice is a Bounded Context, but not vice versa" applies; you will get ~15–20 services, not 50).

| # | Service | Responsibility | Key entities | Justification |
|---|---|---|---|---|
| 1 | **Tenant & Provisioning** | District/school onboarding, tier assignment (pool/bridge/silo), feature flags, billing plan, tenant lifecycle (suspend/migrate) | `Tenant`, `District`, `School`, `Plan`, `FeatureFlag` | Control-plane data; lives in a non-tenant-scoped "global" DB. Owns the tenant registry that all other services consult for routing. |
| 2 | **Identity & Access (IAM)** | AuthN (password, magic link, SSO via SAML/OIDC), AuthZ (RBAC + ABAC), session/JWT issuance, parent-of-student relationship graph, child accounts (COPPA-aware) | `User`, `Role`, `Permission`, `Membership`, `GuardianLink`, `IdpConnection` | Distinct auth flows for staff/admin (SSO mandatory at enterprise tier), parents (email + MFA), students (often minor → restricted, school-issued credentials, sometimes federated via Google/Microsoft EDU). |
| 3 | **Student Information (SIS Core)** | Canonical student profile, demographics, family relationships, enrollment history, transfer/withdrawal, longitudinal record | `Student`, `Guardian`, `Enrollment`, `EnrollmentEvent` | This is the system of record. Everything else hangs off it. Owns the student-id namespace per tenant. |
| 4 | **Admissions & Enrollment Workflow** | Inquiry → application → acceptance → enrollment saga; document collection; class/section placement | `Application`, `ApplicationStage`, `Offer`, `EnrollmentSaga` | Distinct from SIS Core because workflow logic and forms churn differently from canonical records. Hosts the saga orchestrator. |
| 5 | **Staff / HR** | Teacher and non-teaching staff records, employment, qualifications, payroll integration hooks, leave | `Employee`, `Contract`, `Qualification`, `Leave` | Different stakeholder, different lifecycle, different regulatory regime (labor law) than students. |
| 6 | **Academic Structure** | Academic year, terms, grade levels, courses, sections, curricula, learning standards | `AcademicYear`, `Term`, `Course`, `Section`, `Subject`, `Standard` | Reference data consumed by attendance/grading/scheduling. Often versioned (curricula change yearly). |
| 7 | **Attendance** | Daily and period attendance, leave requests, biometric/RFID ingestion, parent notifications on absence | `AttendanceEvent`, `LeaveRequest` | High-volume time-series writes (millions/day at scale). Should be its own service because of write profile and integrations (RFID, biometric devices). |
| 8 | **Gradebook & Assessment** | Assignments, scores, weighted grading schemes, standards-based grading, report cards, transcripts | `Assignment`, `Score`, `GradingScheme`, `ReportCard`, `Transcript` | Highly tenant-customizable (every district has its own grading policy). Read-heavy at end of term, write-heavy mid-term. |
| 9 | **Timetable / Scheduling** | Master schedule generation (constraint solver), room/teacher allocation, conflict detection, period rotation patterns | `Period`, `TimetableEntry`, `Constraint` | The constraint-solving workload (tabu search, OR-tools) is CPU-bound and bursty — keep it isolated so it does not starve OLTP services. |
| 10 | **Communications (Messaging)** | In-app messaging, announcements, parent–teacher chat, email/SMS/push fan-out adapter | `Conversation`, `Message`, `Announcement`, `Channel` | Real-time WebSockets workload, distinct from the fire-and-forget Notification service. |
| 11 | **Notification** | Templated transactional notifications (assignment due, fee overdue, attendance alerts), multi-channel delivery, opt-out/locale | `NotificationTemplate`, `Delivery`, `Subscription` | Pure async; consumes domain events from Kafka and produces email/SMS/push. Should be horizontally scaled independently. |
| 12 | **Fees, Billing & Payments** | Fee structures, invoices, receipts, refunds, payment-gateway adapters (Stripe, Razorpay, PayU, regional rails), reconciliation | `FeeStructure`, `Invoice`, `Payment`, `Refund`, `LedgerEntry` | Money is sensitive. PCI-scope reduction by using gateway tokens; double-entry ledger; needs strong consistency and audit. |
| 13 | **Library** | Catalog, circulation, holds, fines, integration with Z39.50/OPAC | `Title`, `Copy`, `Loan`, `Hold`, `Fine` | Optional but expected by mid/large schools. Self-contained CRUD service. |
| 14 | **Transportation** | Routes, stops, vehicles, driver assignments, GPS ingestion, parent live-tracking | `Route`, `Stop`, `Vehicle`, `Trip`, `Position` | Geo + time-series workload; if you collect live GPS, consider TimescaleDB or a separate time-series store. |
| 15 | **Hostel / Boarding** (optional per tenant feature flag) | Rooms, allocations, mess plans, leave passes, visitors | `Hostel`, `Room`, `Allocation`, `Visit` | Off by default; turned on for boarding schools. |
| 16 | **Health Records** | Vaccinations, allergies, incidents, nurse visits, medication administration, parent consent | `HealthRecord`, `Vaccination`, `Incident`, `Consent` | Often subject to HIPAA-like rules in addition to FERPA — strongly consider per-tenant KMS and tighter access logging here. |
| 17 | **Behavior / Discipline** | Incidents, referrals, interventions (MTSS/PBIS), suspensions | `Incident`, `Referral`, `Intervention` | Sensitive PII; needs the same audit rigor as health. |
| 18 | **Document Management** | Per-tenant S3 bucket or prefix, signed-URL issuance, PDF generation (report cards, transcripts), e-signature | `Document`, `Folder`, `SignedUrl`, `Signature` | All other services delegate file storage here; centralizes lifecycle/retention and KMS key handling. |
| 19 | **Audit Log** | Append-only, tamper-evident log of all data access and mutations with tenant + actor + resource | `AuditEvent` | Required by FERPA (record of disclosures), GDPR (record of processing), SOC 2. Should be a write-heavy event stream → ClickHouse/Elasticsearch with WORM-style retention. |
| 20 | **Analytics & Reporting** | OLAP queries, dashboards, government reporting (Ed-Fi, IPEDS, state-level), exports | `Report`, `ExportJob`, materialized views | Reads from the data warehouse fed by Debezium CDC, never from OLTP. |
| 21 | **Integrations Hub** | OneRoster (1.1/1.2), Ed-Fi ODS/API, LTI 1.3, Google Workspace / Microsoft 365 sync, payment gateways, government education systems | `Connector`, `SyncJob`, `Webhook` | Isolating the "messy boundary" with external systems keeps schema drift and rate-limit retries from polluting the core. |

**What is NOT a service of its own:** parent portal, teacher portal, admin portal, mobile API. These are **BFFs (Backends For Frontends)** that compose data from the services above; following the Microsoft / AWS / Sam Newman BFF pattern. Each persona gets one BFF (e.g., `bff-parent`, `bff-teacher`, `bff-admin-district`) and the BFFs are also where you can apply GraphQL Federation if you want a unified schema later.

### 2. Multi-Tenancy Deep Dive

#### 2.1 Tradeoff matrix (anchored to the AWS Silo / Bridge / Pool taxonomy)

| Dimension | Pool — Shared DB + RLS | Bridge — Schema-per-tenant | Silo — DB-per-tenant |
|---|---|---|---|
| Cost per tenant | Lowest (cents) | Medium | Highest (often $50–$500/mo just in infra) |
| Isolation strength | Logical, DB-enforced via RLS | Strong (separate `search_path`, separate roles possible) | Strongest (separate cluster optional) |
| Noisy-neighbor risk | High; needs per-tenant rate limits, query timeouts, Citus/Aperture-style throttling | Medium; one tenant can still saturate the instance | Effectively zero |
| Scaling ceiling | Excellent with Citus distribution by `tenant_id` (proven at billions of rows) | Hard wall at ~5–10k schemas due to `pg_catalog` cost | Linear with infra spend |
| Backup / restore granularity | Hard — restoring one tenant requires logical extraction | Per-schema dump possible | Trivial — `pg_restore` per tenant |
| Schema migration | Single migration applies to all | N migrations, must be idempotent (`IF NOT EXISTS`), risk of drift | Fan-out, can be staggered (canary tenant first) |
| Per-tenant performance tuning | Limited | Limited | Full (different instance class) |
| Compliance fit | OK for FERPA/GDPR with proper RLS + audit; often unacceptable to ministries | Better story to procurement | Required for some sovereign / on-prem deployments |
| Prisma ergonomics | Best — single `PrismaClient`, single schema | Awkward — Prisma issue #12420 (dynamic schema switching) still open | Workable — one `PrismaClient` per tenant, LRU-cached |
| Connection pool sanity | Cleanest (one pool) | Schema-aware pooling needed (PgBouncer struggles to share pools across `search_path`) | Pool-per-tenant; needs Supavisor or layered PgBouncers |

**Recommendation: tiered hybrid.**

- **Pool (default, free/standard tier):** Shared cluster per region, all tenants share schemas, RLS enforced, Citus extension turned on once you exceed ~500M rows in any single hot table (attendance, scoring events). This is roughly the AWS Pool model and Microsoft Azure's "Database Per Tenant via row sharding" guidance.
- **Bridge (mid-tier, optional):** Used only as a migration intermediate — a tenant about to be promoted to Silo gets a dedicated schema first, smoke-tested, then moved. Avoid offering Bridge as a permanent tier; the operational burden is rarely worth it once you've built RLS + Silo.
- **Silo (premium / regulated):** A dedicated PostgreSQL database (same cluster initially, separate cluster on request) for: districts > N students (e.g., 50k), ministries of education, customers under HIPAA-aligned health-records contracts, and customers in jurisdictions with strict residency laws (Russia, China, KSA, Germany for some Länder, etc.). One Kubernetes namespace per silo tenant for the application tier is *not* required — the same stateless services connect to whichever DB the tenant is mapped to.

#### 2.2 PostgreSQL RLS in detail (the production pattern)

```sql
-- Per tenant-scoped table:
ALTER TABLE student ENABLE ROW LEVEL SECURITY;
ALTER TABLE student FORCE ROW LEVEL SECURITY;  -- forces even table owner

CREATE POLICY tenant_isolation ON student
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A separate restrictive policy for soft-deletes, status, etc., combined AS RESTRICTIVE
CREATE POLICY active_only ON student AS RESTRICTIVE
  FOR SELECT USING (deleted_at IS NULL);
```

Critical gotchas verified across AWS, Nile, and Cloudflare write-ups:

- **Don't use the table owner / superuser** to run application queries; create an `app_user` role and `GRANT` only what's needed. Owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set.
- **Use `SET LOCAL`, not `SET`** so the GUC is scoped to the transaction and cannot leak between pooled connections (this is the single most common production bug in the pattern).
- **PgBouncer transaction mode breaks `SET` (non-LOCAL)** — `SET LOCAL` inside a `BEGIN ... COMMIT` is the only way to be safe under transaction pooling.
- **RLS recursion** on the `users` table (where the policy needs to check `is_admin`) requires a `SECURITY DEFINER` helper function to break the cycle; Nile documented hitting this in production.
- **Background jobs forget tenant context.** Every BullMQ job payload must carry `tenant_id`; the worker's first action is to open a transaction and `SET LOCAL app.current_tenant_id`. Make this part of a base `TenantAwareProcessor` class so nobody bypasses it.

#### 2.3 NestJS implementation pattern

```ts
// tenant.middleware.ts — resolves tenant from JWT (NEVER from a client header alone)
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private cls: ClsService, private prisma: PrismaService) {}
  async use(req: Request, _res: Response, next: NextFunction) {
    const tenantId = req.user?.tenantId; // populated by JwtAuthGuard
    if (!tenantId) throw new UnauthorizedException();
    this.cls.set('tenantId', tenantId);
    next();
  }
}

// prisma.service.ts — extends client to set GUC inside every transaction
@Injectable()
export class PrismaService extends PrismaClient {
  constructor(private cls: ClsService) {
    super();
    this.$extends({
      query: {
        async $allOperations({ args, query }) {
          const tenantId = cls.get('tenantId');
          return this.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `SET LOCAL app.current_tenant_id = '${tenantId}'`,
            );
            return query(args);
          });
        },
      },
    });
  }
}
```

For the **silo tier**, replace `PrismaService` with a `PrismaClientFactory` that maintains an LRU cache (size ~200, TTL 30 min) of `PrismaClient` instances keyed by tenant. Each instance has its own pool sized to ~5 connections; in front of all of them put PgBouncer in transaction mode (or Supavisor, Supabase's cloud-native multi-tenant pooler that keeps a single dynamic pool keyed by tenant identity and supports rolling node replacement).

#### 2.4 Connection-pool math at scale

If you have 3,000 pool-tier tenants on a single Postgres primary with `max_connections = 400`, and a typical NestJS pod has Prisma `connection_limit=10`, then 8 pods exhaust the database before a single silo tenant connects. The path that works in production (DZone's PgBouncer-at-scale write-up confirms this; Cloudflare runs a customized PgBouncer doing the same):

1. PgBouncer in **transaction mode** in front of every Postgres node.
2. `default_pool_size` at the PgBouncer ↔ Postgres link sized to (cores × 2 + spindles), so ~25–50.
3. `max_client_conn = 5,000+` from the application side — PgBouncer multiplexes these onto the small server pool.
4. Per-tenant `max_user_connections` to enforce noisy-neighbor caps.
5. Auth via `auth_query` (a small DB-backed lookup) rather than a flat `auth_file`, with a separate tiny pool for auth itself.
6. For silo tier, an outer Supavisor cluster routes by tenant subdomain to the right Postgres database.

#### 2.5 Tenant migration: pool → silo

Promotion is a routine operational event in this design:

1. Provision new Silo Postgres instance in target region.
2. Use `pg_dump` filtered by `WHERE tenant_id = $1` (or Citus `isolate_tenant_to_new_shard()` if pool tier runs Citus) to bootstrap.
3. Start Debezium CDC on the source filtered by `tenant_id` to keep the silo in sync.
4. Update tenant registry: `tenant.tier = 'silo'`, `tenant.dsn = <new>`, version bump.
5. Drain in-flight requests (read-only window ~minutes), cut over.
6. Hard-delete the tenant's rows from the pool DB after a verification window.

### 3. Microservices Architecture

#### 3.1 Communication patterns — opinionated defaults

| Caller → Callee | Default | Use when | Avoid when |
|---|---|---|---|
| Web/mobile → API Gateway | HTTPS REST + JSON | Always, for external | — |
| Gateway → BFF | HTTPS REST or gRPC | Most cases | Real-time → use WebSocket/SSE |
| BFF → Service | gRPC (NestJS microservice transport) | Internal sync RPC, low latency | Cross-team where schema discoverability matters more than latency |
| Service → Service (sync) | gRPC | Strong contract via proto | Prefer async if not strictly needed |
| Service → Service (async) | **Kafka events** (default) or RabbitMQ for work queues | All domain events; this is the spine of the system | When ordering across partitions is required |
| Service → DB | Prisma | — | — |
| Background work | BullMQ on Redis | Within-service async (emails, PDFs, exports) | Cross-service workflows (use Kafka or Temporal) |

**Rule of thumb:** synchronous coupling is a debt; treat every cross-service call you write as a chance to publish an event instead. Per microservices.io, sagas plus events are the only sane way to keep enrollment-style workflows consistent without distributed transactions.

#### 3.2 Event-driven, CQRS, event sourcing

- **Event-driven everywhere it pays off.** Every service emits domain events to Kafka topics named `{tenant_region}.{service}.{aggregate}.{eventType}` (e.g., `us-east-1.attendance.attendance-event.recorded`). Use the **transactional outbox** pattern (write the event in the same DB transaction as the state change, a relayer like Debezium publishes to Kafka) so you never lose an event. This avoids the "we updated the DB but the event never fired" class of bug.
- **CQRS for high-fanout read models.** The Gradebook is a clear case: writes go to the OLTP Postgres; the parent portal needs precomputed "term-to-date GPA" projections. Build those projections as Kafka consumers writing to dedicated read tables (or to Elasticsearch for transcripts/search).
- **Event sourcing only where audit is the product.** Don't event-source everything; per Confluent and Substack analyses, event sourcing has a real complexity tax. Use it for `AttendanceEvent`, `Discipline.Incident`, `Gradebook.ScoreChanged`, and the `Audit` service itself — places where the historical sequence *is* the requirement (FERPA "record of disclosures," grade-change history). The rest of the domain is plain CRUD.

#### 3.3 Sagas — the enrollment example

```
EnrollmentSaga (orchestrated, NestJS service running on BullMQ workflow):
  1. IdentityService.createParentIfMissing()    → compensate: deleteIfNew
  2. IdentityService.createStudentUser()        → compensate: deleteIfNew
  3. SISService.createStudent()                  → compensate: softDelete
  4. AcademicService.assignToSection()           → compensate: removeFromSection
  5. FeesService.generateInvoice()               → compensate: voidInvoice
  6. DocumentService.issueWelcomePack()          → compensate: markVoid
  7. NotificationService.sendWelcome()           → compensate: noop (idempotent)
```

Orchestration over choreography is the right choice here because the steps have a strict order, the workflow is a product surface (admins want to see "enrollment in progress, step 4/7"), and rollback semantics need a single owner. Temporal is a strong candidate if the team has the appetite; otherwise BullMQ flows + a state machine in Postgres is simpler and ships faster.

#### 3.4 API Gateway, BFFs, and inter-service auth

- **Edge:** Kong, Envoy, or AWS API Gateway terminates TLS, applies WAF, global rate-limits per IP and per tenant, validates JWT signature, and routes to the right BFF based on hostname (`portal.parent.example.com` → `bff-parent`).
- **BFF tier (NestJS):** one BFF per persona. Each BFF holds the user-facing schema (REST or GraphQL), composes from internal services via gRPC, and contains the persona-specific authorization (parents can only see their own children — enforced here, defense-in-depth on top of RLS).
- **Service mesh:** Istio or Linkerd inside the cluster for **mTLS between services**, retries, circuit breakers, and traffic shifting (canary). Linkerd if you want lower operational overhead; Istio if you need fine-grained policy and already have the SRE bench to run it.
- **Auth propagation:** the gateway issues a short-lived (15-min) access JWT containing `sub`, `tenant_id`, `roles`, `scopes`, `actor_id`. Services validate signature on every request and propagate the token (or a service-to-service mTLS-asserted minted token) downstream. Never trust `tenant_id` from a header — derive it from the validated JWT claim.

### 4. Data Layer

- **PostgreSQL** is the system of record for every service. Default to one logical database per service (so the SIS service's tables are not in the same DB as Fees), and within each, the tenancy model from §2.
- **Redis** for: session cache, JWT-blacklist, per-tenant rate limit token buckets, BullMQ queues, hot-path caches (timetable for today, current term metadata) with **per-tenant key prefixes** (`tenant:{id}:...`) and a per-tenant TTL strategy.
- **Elasticsearch / OpenSearch** for: free-text search across students/staff/library catalog, transcripts, audit log explorer. Populated by Debezium CDC from Postgres so OLTP isn't double-written. Per-tenant indexes for very large districts; a single index with `tenant_id` filter for small ones.
- **Object storage (S3-compatible)** for documents, generated PDFs, photos, signed user uploads. **Per-tenant prefix + per-tenant KMS key** at the silo tier; per-region key at the pool tier. Issue signed URLs with short expiry (5–15 min) from the Document service.
- **Time-series (TimescaleDB or ClickHouse)** for attendance, GPS tracking, audit events, and analytics events. Attendance at 1,000 schools × 1,000 students × 6 periods/day × 200 school days = ~1.2 B events/year — easily handled by TimescaleDB hypertables partitioned by week and `tenant_id`.
- **Data warehouse (ClickHouse, BigQuery, or Snowflake)** for OLAP. ClickHouse is the most cost-effective and self-hostable; BigQuery is a fit if you're on GCP and want zero-ops; Snowflake suits enterprise customers running their own analytics teams. CDC pipeline: Postgres → Debezium → Kafka → ClickHouse via Kafka connector — the canonical pattern shown in dozens of public references.
- **Sharding:** for the pool tier, use Citus to distribute by `tenant_id`. Citus's `isolate_tenant_to_new_shard()` is the cleanest tool for promoting a noisy tenant to its own physical shard without rewriting application code. Do not reach for Citus on day one; introduce it when a single primary is at >70% CPU sustained or any single hot table crosses ~500M rows.
- **Caching invalidation:** cache by tenant + entity version (`tenant:{id}:student:{id}:v{version}`). Bump version on writes; never use TTL alone for anything that violates correctness on stale data (gradebook, fees).

### 5. Scalability, Reliability, Performance

- **Horizontal scaling per service** via Kubernetes HPA on CPU + custom metrics (request queue depth, p99 latency). Stateless services only; stateful concerns confined to Postgres, Redis, Kafka, S3.
- **Multi-region deployment:**
  - Active-active for *stateless* services in every region.
  - Active-passive (read replicas + DR) for the pool DB in each region; tenants are pinned to a home region.
  - Active-active for control-plane (tenant registry) is viable using logical replication; pgEdge or Aurora Global Database are commercial options if the team doesn't want to build it.
  - Region-aware routing at the API gateway (DNS geo-routing → regional gateway → tenant lookup → backend in same region). A request that lands in EU but belongs to a US-region tenant gets forwarded; this is unavoidable for cross-region admins.
  - **Data residency enforced at three layers:** tenant-region pinning in the tenant registry, region-aware gateway routing, region-locked KMS keys (a US region's app cannot decrypt EU data). InfoQ's "atom" pattern (define the smallest data unit that lives in one region) is the right mental model.
- **Per-tenant rate limiting** at the API gateway layer using Redis token buckets keyed on `tenant_id`. Tier-aware quotas (free: 100 rps, paid: 1000 rps, enterprise: custom). Adaptive throttling at the DB layer using a custom PgBouncer / Aperture-style adaptive scheduler if a tenant misbehaves — Cloudflare published the canonical write-up on this.
- **Resilience primitives** (Istio or per-service via `nestjs-resilience` / `cockatiel`): circuit breakers (open after 5 consecutive failures, half-open after 30s), timeouts at every hop (gateway 30s, BFF 10s, internal RPC 3s), retries with jitter on idempotent operations only, bulkheads (separate thread pools per downstream).
- **Backpressure:** Kafka consumers commit offsets only after processing; lag alerts at p95 > 30s. BullMQ workers honor concurrency limits per tenant; rate-limited queues for external API calls (SMS providers, payment gateways).
- **Async/background jobs:** BullMQ on Redis (NestJS native integration via `@nestjs/bullmq`). Real-world write-ups confirm this stack handles 2M+ jobs/day per cluster comfortably. Use **dead-letter queues** for poison messages, **Bull Board** for ops visibility, and **separate queues per workload class** (transactional emails vs bulk report exports vs media transcoding) so a slow report doesn't block a welcome email.

### 6. Security & Compliance

#### 6.1 Regulatory map and architectural impact

| Regulation | Scope | Architectural requirements |
|---|---|---|
| **FERPA** (US K-12 + higher ed) | Education records, PII | Encryption at rest (AES-256) + in transit (TLS 1.3), RBAC, audit log of access/disclosures with retention ≥ length of record (effectively indefinite for transcripts), parental access rights, data-sharing agreements with sub-processors. Recommended (not strictly mandated): encryption. |
| **GDPR** (EU residents) | All PII | Lawful basis tracking, consent management for under-16s (member-state varies), DSAR (subject access) within 30 days, right to erasure (hard delete cascade), data portability (export in machine-readable format), breach notification within 72 hours, DPIAs, DPO designation, cross-border transfer controls (SCCs/adequacy). |
| **COPPA** (US under-13) | Children's PII | Verifiable parental consent, prohibition on behavioral advertising / unrelated third-party sharing — architecturally, isolate marketing/analytics infra from core learning data. |
| **State laws (SOPIPA, NY Ed Law 2-d, etc.)** | Vendor obligations | Data privacy plans, breach notification (e.g., NY: 10 days), prohibition on targeted ads, deletion on contract termination. |
| **SOC 2 Type II** | Org control framework | Audit logging, change management, access reviews, vendor management, incident response — mostly process, but underpinned by audit infrastructure. |

#### 6.2 Encryption strategy

- **In transit:** TLS 1.3 mandatory, mTLS between services via service mesh, HSTS enforced at edge.
- **At rest:**
  - PostgreSQL: full-disk encryption (AWS RDS / GCP Cloud SQL default) — covers media-loss scenarios.
  - Application-layer envelope encryption for sensitive columns (SSN, health notes, discipline incidents, parent income for financial-aid). Envelope keys (DEKs) wrapped by per-tenant KMS keys for silo customers, per-region master keys for pool customers. AWS KMS, GCP Cloud KMS, or HashiCorp Vault Transit are all viable — pick based on your cloud.
  - S3: SSE-KMS with the same per-tenant key hierarchy.
- **Right to be forgotten:**
  - Hard delete on student record cascades through Kafka events to all consumers (`student.deleted` topic) which delete or anonymize their own copies.
  - Backups are the gotcha: define a backup retention window (e.g., 35 days) after which deleted data falls off; document this in the DPA.
  - Crypto-shredding for the silo tier — destroying the per-tenant KMS key is the fastest way to render data unrecoverable.

#### 6.3 Authentication flows by persona

| Persona | Primary AuthN | MFA | Notes |
|---|---|---|---|
| District/School Admin | SAML / OIDC SSO via customer IdP (Okta, Entra ID, Google Workspace) | Mandatory at enterprise tier | Per-tenant IdP connection in IAM service. SCIM for user provisioning. |
| Teacher / Staff | SSO if district uses one; else email + password + MFA | Strong-recommended | Same flow as admin but typically narrower roles. |
| Parent | Email + password + optional MFA; magic-link as fallback | Optional but recommended | Many parents share devices, low tech literacy — keep flow simple. |
| Student (≥13) | School-issued credential, often federated (Google EDU, Microsoft EDU); QR badge for younger | None; relies on classroom controls | COPPA-aware. |
| Student (<13) | Class-roster login from teacher's session, or QR | None | Restricted scope; cannot self-register. |

Keycloak (open source, self-hosted, supports SAML/OIDC + brokering, free) is the strongest recommendation for the IAM service backbone; Auth0/Frontegg/SuperTokens are commercial alternatives that may save build time but charge per MAU. The recent Scalekit pattern (federating customer IdPs into a single OIDC trust with the IAM provider) is worth knowing if you go commercial.

#### 6.4 Authorization (RBAC + ABAC)

Role hierarchy: District-Admin > School-Admin > Teacher > Parent-of-X > Student. Permissions are fine-grained (e.g., `student:read:demographics`, `student:read:grades`, `student:write:attendance`). Parent's "of X" relationship is an ABAC attribute: `student.id ∈ user.guardian_links`. Encode policies in OPA (Rego) or Cerbos sidecars for centralized decision logic; the service still owns the data, the policy engine answers "may this principal do this action on this resource?"

#### 6.5 Audit logging

Append-only stream into ClickHouse (or AWS QLDB / Postgres with `pgAudit`) capturing: `tenant_id, actor_id, actor_type, action, resource_type, resource_id, before_hash, after_hash, ip, user_agent, timestamp, request_id`. Retention 7 years (state laws, transcripts), with WORM-style protection (no UPDATE/DELETE on the audit DB role). Surface a per-tenant audit explorer in the admin BFF.

### 7. DevOps & Observability

- **Kubernetes deployment:**
  - Cluster per region; namespace per environment (`dev`, `staging`, `prod-us-east-1`).
  - Each microservice → Helm chart; ArgoCD or Flux for GitOps.
  - HPA on CPU + custom metrics; PodDisruptionBudgets so rolling deploys don't take a service offline.
  - For silo tenants: same shared cluster, with `NetworkPolicy` and `ResourceQuota` per tenant *only when* they pay for it; running a dedicated cluster per tenant is rarely worth the ops cost — the DB silo is what matters legally.
- **CI/CD on Nx monorepo:**
  - One repo with `apps/` (services, BFFs) and `libs/` (shared DTOs, Prisma schema fragments via `prisma-multi-schema`, common middlewares).
  - Nx affected commands so PRs only build/test what changed; remote cache via Nx Cloud or self-hosted.
  - Build → test → containerize → push to registry → ArgoCD sync. Each service gets a semver bump via `@jscutlery/semver` from conventional commits.
  - Per-PR ephemeral preview environments in a sandbox cluster (or via Signadot for request-level multi-tenancy in shared envs — leverages OpenTelemetry baggage).
- **Observability (OpenTelemetry as the standard):**
  - Auto-instrument NestJS HTTP + Prisma + BullMQ + Kafka clients.
  - **Propagate `tenant_id` as OTel baggage** so every span/log/metric is filterable by tenant — non-negotiable for triage at scale.
  - Collector as DaemonSet per node; exports traces to Tempo/Jaeger, metrics to Prometheus/Grafana Mimir, logs to Loki/OpenSearch.
  - SLOs per service (e.g., availability 99.9%, p99 latency 300ms for OLTP), error budgets, alerting via Grafana.
- **Logging:** structured JSON, every log line carries `tenant_id, request_id, user_id, service, version`. Strip PII before shipping (regex-based redaction in the OTel pipeline). Per-tenant log query views via Loki/OpenSearch label filters.
- **Disaster recovery per tier:**
  - Pool: continuous WAL archiving + cross-region replica, RPO ≤ 5 min, RTO ≤ 30 min, restore to a sandbox cluster monthly.
  - Silo: same plus per-tenant logical dumps weekly to enable selective restore.
  - Backups encrypted with KMS; restore drills quarterly (otherwise the procedure rots).

### 8. NestJS + Prisma Specific Patterns

- **Module organization:** each service is its own NestJS app. Shared code in `libs/`: `lib/auth` (JwtStrategy, TenantContextMiddleware, RolesGuard), `lib/prisma` (PrismaService, RLS extension), `lib/messaging` (Kafka producer/consumer wrappers, outbox), `lib/observability` (OTel bootstrap), `lib/dto` (Zod or class-validator schemas shared between BFF and service).
- **Microservices transports:** use `@nestjs/microservices` with gRPC for internal sync (proto-first), Kafka for events, Redis pub/sub only for non-critical cross-instance coordination (e.g., cache busting). Avoid TCP transport in production.
- **Repository pattern / clean architecture:** service-domain-infrastructure layering; controllers thin, application services orchestrate, domain entities encapsulate invariants, Prisma confined to repository implementations. This pays off when a context graduates from a module to its own service.
- **GraphQL Federation vs REST:**
  - External APIs: REST + OpenAPI (Ed-Fi/OneRoster compatibility, easier for districts' IT to consume).
  - Internal aggregation: REST or gRPC.
  - **Optional GraphQL Federation only at the BFF layer** if frontend velocity demands it — Khan Academy, Netflix, Expedia all use this pattern. Don't introduce federation on day one; it requires schema governance discipline most early teams lack.
- **Real-time:**
  - WebSockets via `@nestjs/websockets` (Socket.IO adapter with Redis pub/sub for horizontal scaling) for chat, live attendance, parent–teacher messages.
  - SSE for one-way updates (notification feed, dashboard tickers) — simpler, plays nice with HTTP/2 and proxies.
- **Multi-database with Prisma:** use the `prisma-client-js` `output` directive to generate one client per database (shared `tenant_global` for tenant registry, plus the service's main DB). Plain `prisma generate` per directory; the Prisma docs cover this exact pattern.

### 9. Real-World References (representative, non-exhaustive)

- **Khan Academy engineering blog and InfoQ coverage** — handled 2.5× traffic spike via serverless on GCP App Engine + Fastly CDN, decomposed into ~20 services behind a federated GraphQL gateway.
- **AWS SaaS Lens / SaaS Tenant Isolation Strategies / Multi-Tenant SaaS Storage Strategies whitepapers** — canonical Silo / Bridge / Pool taxonomy applied to RDS PostgreSQL, with explicit hybrid recommendations.
- **Microsoft Azure Architecture Center (Multitenant guidance for Azure DB for PostgreSQL, CQRS, Saga, BFF)** — production-tested patterns including `session_variable` and `login_hook` PG extensions for tenant context.
- **Cloudflare engineering: "Performance isolation in a multi-tenant database environment"** — adaptive throttling at PgBouncer using a TCP-Vegas-inspired congestion-window-per-tenant.
- **Nile Database "Shipping multi-tenant SaaS using Postgres RLS"** — production gotchas (table-owner bypass, RLS recursion on `users`, `SECURITY DEFINER` functions).
- **Supabase Supavisor** — open-source cloud-native multi-tenant pooler if PgBouncer is insufficient.
- **PowerSchool, Infinite Campus, FACTS, Synergy, Ellucian** product pages — feature parity baseline, ParentVUE-style portal architecture, FERPA/SOC 2 posture statements.
- **OpenEduCat (Odoo-based), Fedena (Rails), RosarioSIS (PHP)** — open-source SMS implementations to mine for domain shape and feature lists; their architectures are *not* a model to copy at scale (monolithic, single-tenant by deployment).
- **1EdTech (formerly IMS Global) standards: OneRoster 1.2, LTI 1.3, CASE; Ed-Fi Alliance ODS/API; CEDS; SIF** — interoperability standards you must support to sell into U.S. K-12.
- **Citus Data blog series** — multi-tenant sharding patterns, schema-based sharding (Citus 12+), `isolate_tenant_to_new_shard()` for tenant promotion.

### 10. Recommended Architecture (Synthesis)

**Logical diagram (textual):**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Clients: Parent app (mobile/web), Teacher app, Student app, Admin console,  │
│           District dashboard, 3rd-party SIS/LMS, Government endpoints         │
└──────────────────────────────┬───────────────────────────────────────────────┘
                               │ HTTPS / WSS
                  ┌────────────▼─────────────┐
                  │  Edge: CDN + WAF + DDoS  │  (CloudFront/Fastly + WAF)
                  └────────────┬─────────────┘
                               │
                  ┌────────────▼─────────────┐
                  │   API Gateway (Kong)     │  TLS, JWT verify, region-route,
                  │                          │  per-tenant rate limit, OTel
                  └────────────┬─────────────┘
                               │
       ┌───────────┬───────────┼───────────┬─────────────┐
       ▼           ▼           ▼           ▼             ▼
   bff-parent  bff-teacher  bff-student  bff-admin   bff-public-api
   (NestJS)   (NestJS)    (NestJS)     (NestJS)    (REST + OneRoster/Ed-Fi)
       │           │           │           │             │
       └───────────┴────┬──────┴───────────┴─────────────┘
                        │ gRPC (mTLS via Istio/Linkerd)
   ┌───────────┬────────┼────────┬───────────┬─────────────┬──────────────┐
   ▼           ▼        ▼        ▼           ▼             ▼              ▼
 IAM       Tenant     SIS    Enrollment  Academic     Attendance      Gradebook
                                          Structure
   ▼           ▼        ▼        ▼           ▼             ▼              ▼
 Scheduling Comms  Notification Fees     Library    Transport    Health/Discipline
                                                                        │
   ▼           ▼        ▼        ▼           ▼             ▼              ▼
 Document   Audit   Analytics  Integrations
                       │           │
                       │       (OneRoster, Ed-Fi, LTI,
                       │        Google EDU, MS365,
                       │        Stripe/Razorpay, gov't)
                       ▼
                 ClickHouse / BigQuery
                 ▲
   Kafka topics ─┴─◄── Debezium CDC ◄── PostgreSQL (Pool DBs + Silo DBs)
                                              │
                                          PgBouncer / Supavisor
                                              │
                                       Citus distribution by tenant_id
                                       (pool tier, when needed)

Cross-cutting: Redis (cache + BullMQ), S3 (per-tenant prefix + KMS),
               Elasticsearch (search), Keycloak (IAM backend),
               OpenTelemetry → Tempo/Prometheus/Loki/Grafana
```

**Tenancy tier strategy summary:**

| Tier | Default for | Storage | Pricing intuition | DR target |
|---|---|---|---|---|
| Pool | Schools < 5k students, single-school subscriptions | Shared Postgres + RLS, Citus when hot | $X/student/year, lowest | RPO 5 min / RTO 30 min |
| Bridge (transient) | In-flight migrations | Schema in shared cluster | n/a | Same as pool |
| Silo | Districts > 50k students, ministries, regulated regions, on-prem | Dedicated DB, optionally dedicated cluster, optionally on-prem | 3–8× pool pricing | RPO 1 min / RTO 15 min |

#### Phased rollout / MVP plan

**Phase 0 — Foundations (months 0–1):**
- Nx monorepo, NestJS service template with PrismaService + RLS extension + tenant-context middleware + OTel.
- Kong gateway, Keycloak IAM with one tenant, Postgres with RLS, Redis, Kafka, S3, Kubernetes (one region).
- CI/CD pipeline, GitOps with ArgoCD, observability stack.

**Phase 1 — MVP (months 2–6):** Pool tier only, single region.
- Services: Tenant, IAM, SIS, Enrollment, Academic Structure, Attendance, Gradebook, Communications, Notification, Document, Audit.
- BFFs: parent, teacher, admin.
- Integrations: Google Workspace SSO, basic email/SMS providers.
- Scope: 50–100 schools, single district pilots, US-only, English only.

**Phase 2 — Scale-out (months 6–12):**
- Add: Fees/Payments, Library, Transport, Discipline, Health, Scheduling, Analytics.
- Multi-region (US + EU), data residency enforcement.
- Integrations Hub: OneRoster 1.2, Ed-Fi, LTI 1.3, Stripe.
- BFF: student app.
- Citus introduction if pool size warrants.

**Phase 3 — Enterprise & global (months 12–24):**
- Silo tier productized: tenant promotion automation, per-tenant KMS, dedicated DR.
- SAML enterprise SSO, SCIM provisioning, SOC 2 Type II audit completion.
- Additional regions (APAC, LATAM, MEA), localization (i18n), regional payment rails.
- Government reporting connectors per target country.
- GraphQL Federation at the BFF layer (only if frontend velocity demands it).

---

## Recommendations

**Do this now (Phase 1 architectural decisions to lock in):**

1. **Build the tenant registry first.** Before any feature service, ship a `tenant-service` that owns `Tenant`, `District`, `School`, `Plan`, `FeatureFlag`, region pinning, and DSN routing for silo tier. Every service must consult it on startup and cache aggressively. Skipping this is the most common reason multi-tenant SaaS rewrites itself in year two.
2. **RLS from line one.** Even if you ship with one tenant in the pool, every table must have `tenant_id NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and a tenant-isolation policy. Add a CI test that creates two tenants and asserts cross-tenant queries return zero rows. This is your unbreakable safety net.
3. **Outbox pattern from line one.** Every service writes domain events to an `outbox` table in the same transaction as state changes; Debezium relays to Kafka. Retrofitting this later is painful.
4. **OTel baggage carrying `tenant_id` from line one.** If you can't filter every metric, log, and trace by tenant, you cannot operate this system at 1,000 schools. Make this a base-class concern, not a per-service one.
5. **Pick Keycloak (or commit to Auth0) by week 2.** Identity is the longest pole; deferring this decision blocks every other service.

**Do this in Phase 1 (before scaling beyond ~50 tenants):**

6. **PgBouncer in transaction mode** in front of every Postgres node, with `auth_query`. Don't run Prisma directly against Postgres in production.
7. **BullMQ + dedicated worker deployments per workload class.** Separate queues for transactional emails, bulk exports, PDF rendering, integrations sync.
8. **Per-tenant rate limiting at the gateway** keyed on JWT `tenant_id`, with a default tier and an "enterprise" override.
9. **A canary tenant** (your own internal "demo" tenant) that runs all migrations and synthetic load 24h before any tenant gets the change.

**Defer until you have evidence you need it:**

- Citus / sharding — wait until a single primary is consistently > 70% CPU.
- Service mesh (Istio/Linkerd) — add when you have > 8 services and need mTLS or canary deployments; until then, NetworkPolicies + JWT-based service auth are enough.
- GraphQL Federation — defer until frontend teams are filing constant "add a field" tickets across multiple BFFs.
- Event sourcing on most aggregates — start with CRUD + event publishing; only event-source attendance, discipline, gradebook history, and audit.
- Multi-cloud — single-cloud multi-region is plenty until a customer contractually demands otherwise.
- Temporal — BullMQ + Postgres state machine is sufficient for the saga workload until you have ≥ 5 distinct multi-step workflows that need observability.

**Tripwires that should change the recommendation:**

- If a single tenant exceeds ~10% of total pool DB CPU for > 1 week → promote to silo (or isolate via Citus shard).
- If pool-tier `pg_stat_activity` shows > 200 sustained backends → add a regional read replica and route reports there.
- If any service's p99 crosses its SLO for two consecutive days → split the noisy module into its own service before adding capacity.
- If you cross 5,000 schemas and you ever chose Bridge → migrate immediately to RLS-based Pool or to Silo; `pg_catalog` will become the bottleneck.
- If a regulated customer asks for "where exactly is our data" and you can't point to a region in < 5 minutes → your residency story isn't real; pause feature work and fix it.

---

## Caveats

- **Vendor benchmarks deserve a skeptical read.** PowerSchool's "PowerSchool vs Infinite Campus" page, the FACTS marketing pages, and most tooling vendor blogs (Frontegg, SuperTokens, etc.) are sales material. The directional facts (market share approximations, feature lists, AI integration trends from ListEdTech's 2025 report) are reasonable, but specific feature-superiority claims should be verified independently before influencing your design.
- **The "1,000+ schools, tens of millions of users" target is a planning horizon, not a starting capacity.** None of the recommendations require a Day 1 cluster sized for that — but all of them should be possible without a rewrite. The tenancy tier model and the bounded-context decomposition are the two decisions that are expensive to undo later; almost everything else (Citus, federation, multi-region, event sourcing) can be added incrementally.
- **Prisma's multi-tenant story has gaps.** The dynamic schema-switching feature requested in Prisma issues #2077 and #12420 is still open as of the research conducted; the once-popular `prisma-multi-tenant` library is unmaintained. The pattern recommended here (single client + RLS for pool, LRU-cached client per tenant for silo) is what the community has converged on, but it's not as turnkey as, say, Django's `django-tenants`. If your team has more Postgres than Node experience, a ProgrammingError on `SET LOCAL` under PgBouncer transaction mode will burn an afternoon at least once.
- **FERPA, GDPR, COPPA, and state laws interact in non-obvious ways**, especially for international schools, and every piece of compliance content should be reviewed by qualified legal counsel before it influences a contract or a security questionnaire response. The architectural controls described here are necessary but not sufficient for compliance — process, training, and contracts matter equally.
- **Open-source SMS projects (Fedena, OpenEduCat, RosarioSIS) are valuable as domain references but not as architectural references.** They are predominantly single-tenant, monolithic, and built on stacks (Rails, Odoo/Python, PHP) very different from what's recommended here. Mine them for entity models and feature checklists; do not copy their architecture.
- **Some referenced tools and patterns evolve quickly** — Prisma is rolling out a Rust-free client, Citus added schema-based sharding in version 12, OpenTelemetry instrumentation for some Node libraries is still maturing, and BullMQ has commercial Pro features that change the cost equation. Re-validate specific library versions and feature availability at the time of implementation rather than relying on snapshots from this report.
- **The "phased rollout" timelines (months 0–6, 6–12, 12–24) assume a competent team of ~8–15 engineers.** Half that team and the timelines double; a quarter and you should not be building this — buy or partner.

---

## Clarifying Questions for Stakeholders

Before locking the design, a senior engineer should get answers — in writing — to the following:

**Market & regulatory**
1. Which regions/countries are launch targets in the next 12 months and 24 months? (drives data-residency posture, language list, payment rails, government reporting connectors)
2. Which specific compliance regimes do you need certified vs. "meet the requirements of"? (SOC 2 Type II, ISO 27001, FedRAMP, StateRAMP, IL4, India MeitY, Singapore IMDA, etc.)
3. Are any target customers ministries of education or central governments who will demand on-premise or sovereign-cloud deployments? (forces silo + portable artifact strategy)
4. What's the position on Russia/China/India data-localization laws — in-scope or excluded?
5. Are there contracts already signed (or imminent) that have specific RPO/RTO/SLA commitments?

**Product**
6. K-12, higher ed, vocational, or all three? (radically different feature surfaces — financial aid, degree audit, clock-hour attendance vs. period attendance)
7. Will you need an LMS embedded, or always integrate with external LMS via LTI? (decision dramatically affects scope)
8. Is offline-first a requirement for parent/student/teacher mobile apps in low-connectivity regions?
9. What's the policy on AI features (predictive analytics, personalized learning, automated grading)? GDPR Art. 22 implications for automated decisions affecting students?
10. Does the parent app need real-time live-bus tracking? (forces transport service design and ingestion choice)

**Tenancy & commercial**
11. What's the target ratio of free/standard/enterprise tenants? (drives how aggressively to optimize pool tier)
12. Will tenants ever need to merge (district consolidation) or split (school spinoff)? (one of the hardest data-migration scenarios; better to design for it now)
13. Pricing model — per student, per school, flat per district? (impacts whether you need fine-grained per-tenant cost attribution day one)
14. White-labeling/custom domains per tenant? (impacts edge routing, certificate management, BFF templating)

**Integrations**
15. Which payment providers must be supported at launch, by region? (Stripe is not enough globally — Razorpay India, PayU LATAM, Paystack Africa, etc.)
16. Required SIS interoperability standards — OneRoster 1.1, 1.2, Ed-Fi which versions, SIF, LTI 1.3 — and do any contracts require certification (1EdTech certified)?
17. Government reporting endpoints needed at launch? (US states each have their own; EU varies; APAC varies)
18. Office 365 vs Google Workspace vs both for SSO and roster sync?

**Operations**
19. Acceptable deployment cadence per service — daily, weekly, monthly? (drives CI/CD investment)
20. SLA promises planned: 99.9%, 99.95%, 99.99%? (each "9" roughly multiplies infra and on-call cost)
21. Is there an internal SRE/platform team, or are product engineers on call?
22. What's the data-export commitment to tenants on contract termination — format, timeline, cost?
23. Disaster-recovery testing: quarterly, annually, never? (the honest answer determines whether DR will work when needed)

**Security**
24. Will you offer customer-managed encryption keys (BYOK) at the enterprise tier? (changes KMS architecture significantly)
25. Pen-testing cadence and red-team budget?
26. Bug-bounty program planned?
27. Vendor risk-management requirements from prospective customers — any requiring single-tenant attestation or HECVAT Full?

The answers to these questions will validate, refine, or invalidate specific recommendations above — particularly around tenancy tiers (questions 1–4, 11–14), service decomposition (6–10), and operational complexity (19–23).