# Agrawal_Backend — API

Express (Node, TypeScript) API with PostgreSQL + Prisma, issuing its own session tokens (ADR-0014). The source is built (commit `efb535a`, 20 September 2026). It is not deployed and not verified against live services; see [`docs/REMAINING BACKEND WORK.md`](docs/REMAINING%20BACKEND%20WORK.md).

- Owns the HTTP contract both clients build against.
- Replaces the mocked services in `Agrawal_Frontend/prototypes/registration/src/services/` (auth, payment, registration, image scan).
- Domain names and invariants: `CONTEXT.md` (copy in this directory; canonical version lives in the `Agrawal_App` repository).
