# Phase 2.6 — Frontend: Next.js + the parent portal MVP

> **Concepts:** Next.js App Router, server components vs client components, OIDC authorization-code-with-PKCE in a browser, BFF as the data layer, session cookies vs localStorage, route-level loading/error states, optimistic UI, Tailwind + shadcn/ui
> **Estimated effort:** 4 weekends — first real client app
> **Status:** Not Started
> **Prerequisites:**
> - Milestones 2.0, 2.5 complete (payments are the parent dashboard's most interesting feature)
> - Familiarity with React; Next.js's App Router differs significantly from Pages router

---

## What you'll learn

- **Next.js App Router** (v15+): file-based routing, server components by default, the layout/page/loading/error file convention.
- **Server components vs client components**: which runs where, what each can and can't do, the boundary discipline.
- **OIDC authorization-code-with-PKCE** in a browser: redirect flow, callback handling, token storage. The standard public-client pattern.
- **BFF-driven data**: the frontend never calls SIS or academic directly; it calls bff-parent. The persona-shaped endpoints from milestone 1.7 finally have a consumer.
- **Session cookies vs localStorage**: refresh tokens go in `httpOnly` cookies; access tokens in memory; localStorage is forbidden. The XSS posture.
- **Route-level loading + error states**: Next.js's `loading.tsx` + `error.tsx` files. UX while the BFF responds; UX when it doesn't.
- **Optimistic UI**: the parent marks "Read" on a notification; the UI updates before the API confirms. The API call rolls back the UI on failure.

---

## Why this matters (senior perspective)

Phase 1 + 2.0–2.5 built a backend that nothing consumes. Phase 2.6 is the first real consumer — the parent portal. The frontend earns its keep by demonstrating that the BFF's persona-shaped endpoints, the auth model, the partial responses, and the cache work as designed in a UI.

The senior posture has three parts:

1. **The frontend is the client team's BFF target.** Every UX decision pulls on the BFF's endpoint shape. If you find yourself stitching 4 BFF calls in the client, your BFF endpoint is wrong, not the client.
2. **Server components are not a fad.** They unlock real wins: less JavaScript shipped, secrets stay on the server, data fetching closer to the data. The discipline is keeping the client-component boundary tight.
3. **Auth in the browser is the most error-prone path in the system.** Refresh-token-in-cookie + access-token-in-memory + silent-refresh-on-401 is the well-known shape; every other shape is a security smell.

---

## Hands-on plan

### Step 1 — Generate the Next.js app

`pnpm exec nx g @nx/next:app parent-portal` (or, if Nx's Next integration is awkward, a side-by-side `apps/parent-portal` with its own package.json).

Tooling stack:
- Next.js 15+, App Router.
- Tailwind CSS for styling.
- shadcn/ui for headless component primitives (Button, Card, Form, Dialog).
- Vitest for unit tests; Playwright for E2E.

### Step 2 — Auth — OIDC PKCE flow

The parent portal is a Keycloak public client (no secret). The OIDC code-with-PKCE flow:

1. User clicks "Log in." Next.js redirects to Keycloak's auth endpoint with a PKCE code challenge.
2. User authenticates at Keycloak.
3. Keycloak redirects back to `/auth/callback?code=...`.
4. The callback (server component) exchanges the code for tokens at Keycloak's token endpoint.
5. The refresh token is set in an `httpOnly`, `Secure`, `SameSite=Strict` cookie.
6. The access token is returned to the page (or kept in memory client-side).

For the access token in memory: a React context that holds it; a fetch wrapper that adds `Authorization: Bearer ...`. On 401, the wrapper hits `/auth/refresh` (a server action that reads the refresh-token cookie, calls Keycloak, returns a new access token).

Never `localStorage`. Never URL parameters. Never embedded in HTML attributes.

### Step 3 — The dashboard page

`app/(authed)/dashboard/page.tsx`:

```typescript
export default async function DashboardPage() {
  const data = await fetchDashboard(); // server-side BFF call
  return <Dashboard data={data} />;
}
```

The Dashboard component is a server component that fetches from bff-parent's `/me/dashboard` server-side, using the request's auth context. The browser receives rendered HTML; no client-side JavaScript loads just to fetch + render the dashboard.

For the interactive bits (mark notification read, open a modal), small client components are nested into the server tree.

### Step 4 — Loading + error states

Each route gets:
- `loading.tsx`: shown while the page server-renders. A skeleton matching the dashboard's shape.
- `error.tsx`: shown when the page throws. A "We couldn't load your dashboard — retry?" with the retry button.

The BFF's `degraded: true` field (milestone 1.7) lands here: the UI renders the available children with full data + a banner saying "some sections couldn't load."

### Step 5 — Optimistic UI

The "Mark notification read" interaction. Three layers:

1. Client component sets local state to "read" instantly.
2. Server action calls `bff-parent` PATCH endpoint.
3. On success: confirm.
4. On failure: revert local state + toast the error.

React 19's `useOptimistic` is the idiomatic primitive. The UX wins: the user never waits.

### Step 6 — Payments integration (from milestone 2.5)

The parent's "tuition due" view drives the Stripe Elements integration. The page:

1. Server-renders the tuition amount + due date.
2. A client component embeds Stripe Elements (their iframe-based card collector).
3. On submit, Stripe Elements tokenizes the card; the client calls `bff-parent`'s POST /api/me/payments with the token.
4. The BFF forwards to payments-service; payments-service creates the intent at Stripe.
5. The webhook arrives async; the parent's dashboard shows "Payment processing"; eventually "Paid."

The Stripe iframe means the card number NEVER touches our origin — PCI scope minimization (milestone 2.5).

### Step 7 — i18n preview

Phase 2 doesn't fully localize, but the frontend establishes the seams. Next-intl or react-intl with one namespace (`common.json`) wired up. Default `en-US`; the second locale comes when a market demands it (Phase 3).

### Step 8 — Tests

- **E2E (Playwright)**: log in as a parent, see the dashboard, log out. The happy path.
- **E2E**: tamper the refresh-token cookie; the next API call fails; the user is redirected to login.
- **Unit**: BFF response shape parsing.
- **A11y**: each interactive page passes axe-core's automated checks.

### Step 9 — ADRs

- `adr/0034-frontend-framework.md` — Next.js vs Remix vs SvelteKit; Phase 2 chose-and-why.
- `adr/0035-spa-auth-flow.md` — OIDC PKCE + cookie strategy + the why-not-localStorage stance.

---

## Definition of done

- [ ] `parent-portal` Next.js app deployed.
- [ ] OIDC PKCE login flow works; refresh token in httpOnly cookie; access token in memory.
- [ ] `/dashboard` server-renders from bff-parent.
- [ ] `degraded: true` from the BFF renders as a UX banner; non-degraded sections still show.
- [ ] Loading + error route states; skeletons + retry.
- [ ] "Mark notification read" uses optimistic UI; reverts on failure.
- [ ] Payments flow: Stripe Elements iframe, no card data on our origin.
- [ ] Playwright E2E test for log-in → dashboard → log-out.
- [ ] axe-core A11y: zero violations on the dashboard page.
- [ ] ADR-0034 (frontend framework) and ADR-0035 (SPA auth) written.

---

## Reflection questions

1. **Why are refresh tokens in cookies and access tokens in memory?** Walk through the XSS attack each protects against.
2. **The dashboard is a server component; the "mark read" button is a client component. What's the boundary, and what data crosses it?**
3. **Stripe Elements is an iframe. Why does that matter for PCI scope?**
4. **The BFF returns `degraded: true`. What's the UX rule that decides whether to show the partial data vs the error page?**
5. **A new locale (`hi-IN`) is requested. What's the migration path through the codebase?**

---

## References

- Next.js App Router docs: <https://nextjs.org/docs/app>
- OAuth 2.0 PKCE: <https://datatracker.ietf.org/doc/html/rfc7636>
- shadcn/ui: <https://ui.shadcn.com/>
- "The web in 2026 is server-first again" — various engineering blog posts on RSC
- Internal:
  - `docs/adr/0015-bff-pattern.md` — the BFF this frontend consumes
  - `docs/adr/0013-iam-backbone.md` — Keycloak (the OIDC provider)
  - `apps/bff-parent/src/dashboard/dashboard.controller.ts` — the endpoint
