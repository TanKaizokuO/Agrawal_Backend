# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

Single-context. The glossary lives in this repo; the decision record lives in the sibling app repo.

```
Agrawal_Samajh_App/
├── Agrawal_App/
│   ├── CONTEXT.md          ← canonical copy of the glossary
│   └── docs/adr/           ← the decision record (ADR-0001 … ADR-0028+)
└── Agrawal_Backend/        ← this repo
    ├── CONTEXT.md          ← mirror of ../Agrawal_App/CONTEXT.md
    └── src/
```

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary and invariants.
- **`../Agrawal_App/docs/adr/`** — read ADRs that touch the area you're about to work in. When `CONTEXT.md` or the code cites an ADR number (e.g. "ADR-0027"), resolve it there. There is no `docs/adr/` in this repo; don't create one.

If any of these files don't exist (e.g. the sibling repo isn't checked out), **proceed silently**. Don't flag their absence; don't suggest creating them upfront.

`CONTEXT.md` here mirrors `../Agrawal_App/CONTEXT.md`. When `/domain-modeling` resolves a new term or decision, edit the `Agrawal_App` copy (and write ADRs into `../Agrawal_App/docs/adr/`), then sync this mirror.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids (e.g. say **Member**, not "user" or "profile").

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (…) — but worth reopening because…_
