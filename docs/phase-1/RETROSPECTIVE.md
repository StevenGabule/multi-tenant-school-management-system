# Phase 1 retrospective — prompt + template

> The milestone-1.9 doc explicitly recommended this before opening Phase 2:
>
> > Before opening Phase 2, do a Phase 1 retrospective: re-read each
> > milestone's reflection questions, your own answers, and your ADRs.
> > Write a Phase 1 summary post in your own words — what you learned,
> > what you'd change, what surprised you. This artifact is the most
> > valuable thing the entire project produced. It's the proof, to
> > yourself and to a future interview panel, that you've thought
> > through every layer of a multi-tenant SaaS.
>
> This file is the prompt. The synthesis is yours.

---

## How to use this

Don't write the retrospective in this file. **Write it as a separate
document in your own voice** — a blog post, a personal markdown file,
a Notion page, whatever feels natural. This file is the structure to
react against, not to fill in.

If you write it here anyway, sign your name at the top. The retrospective
is a *first-person* artifact; the value is in your synthesis.

---

## The prompts

### 1. The five things you learned that you didn't know existed before this project

Not "I learned about RLS." You knew RLS existed. Name the things you
didn't know — the gotchas, the patterns, the surprising trade-offs.
Examples that might be on your list:

- The RLS recursion problem and `SECURITY DEFINER` as the fix (milestone 1.6, ADR-0005).
- That `pg_dump`'s sort-and-hash includes session-specific timestamps
  in comments (drill #1 lesson #1).
- That Keycloak 24+ silently drops user attributes that aren't in the
  user-profile schema (milestone 1.6).
- That OTLP collector's `from_context` reads HTTP-request metadata,
  not W3C baggage at the span level (milestone 1.8).
- That `Promise.allSettled` is the senior choice over `Promise.all`
  for BFF aggregation; one slow child shouldn't fail the whole dashboard
  (milestone 1.7).

Whatever your five are, write them in your voice. The list IS the
retrospective's substance.

### 2. The decisions you'd reverse

Every ADR has a list of options-considered. Some of them, in
hindsight, look better than the one you picked. Be specific:

- Would you pick Citus earlier? Defer the saga? Skip the BFF and go
  GraphQL? Use Temporal from the start?
- For each reversal: what would have made it the right call back then?

This is the hardest section. The senior practice is to be HONEST in
hindsight without using hindsight to deny the original judgment. "I'd
make the same call again knowing what I knew then" is a fine answer.

### 3. The three things that surprised you about your own behavior

- Which milestone did you blow through the schedule on, and why?
- Where did you cut corners you wish you hadn't? Or DIDN'T cut corners
  you should have?
- What patterns from Phase 1 are you carrying into your day job?

This section is about you, not the system. The interview question
behind it is "how do you learn?"

### 4. The ADRs that earn their keep

Twenty ADRs. Rank them. The top five are the ones a future you (or a
future hire) would ACTUALLY use. The bottom five — keep them as
record, but mark them as "we'd skip writing this one again."

Some ADRs earn their keep by being load-bearing decisions you reach
for monthly. Others are historical context — fine to write once, never
re-read. Knowing which is which is the senior move.

### 5. The shape of Phase 2

You have an outline (`INDEX.md`). The milestone docs are sketched
(`phase-2/*.md`). Some bullets feel inevitable, some feel premature.

- Which Phase 2 milestone do you most want to start? Why?
- Which one are you putting off, and is that intuition or avoidance?
- If you could only do ONE Phase 2 milestone, which would it be?
  (Answers a question about the project's value beyond the curriculum.)

---

## A few format hints

- **Length:** 2,000–4,000 words is the senior post-mortem range. Less
  than 1,000 is shallow; more than 5,000 nobody reads.
- **Voice:** first person, past tense for what happened, present tense
  for what you'd do now. "I learned X. I'd do Y differently."
- **Specifics over generalities.** A line of SQL is better than "the
  RLS pattern." A trace screenshot is better than "OTel was useful."
- **Audience:** future you in 18 months, or a hiring panel asking
  "what was your hardest engineering project." Write for that listener.

---

## When you're done

The retrospective is YOUR artifact, not the project's. But if you'd
like it referenced from the public-facing INDEX as a portfolio piece,
add a link there:

```
- [Phase 1 retrospective: what 10 milestones taught me](./RETROSPECTIVE-johnpaul-2026-05.md)
```

(File name suggestion: include your name and a year-month so future
forks of this project don't conflate your synthesis with someone else's.)

---

## A note on cadence

The milestone-1.9 doc's win condition was "the next drill is scheduled."
This file's win condition is similar: **the retrospective is written.**

Not "started," not "in your head." Written, dated, signed, committable.
The discipline beats the content.

When it's done, open Phase 2.
