# Domain Context

## Identity and ownership

- **User**: a Better Auth account identified by a stable `user.id`.
- **Session**: a Better Auth server session. Every non-public `/api/*` route requires one unless the explicit `AUTH_DISABLED=1` test switch is enabled.
- **Public question bank**: read-only imported exam content in `tiku.db`; it is shared by all users.
- **Personal study data**: custom batches/questions, attempts, practice records, favorites, notes, explanation cache, and tutoring conversations. These rows are owned by `user_id`.
- **User AI profile**: a private copy of the global AI role templates in `user_ai_agents`. A server-stored provider key belongs to this profile, never to the shared template.
- **Browser-only key**: an API key held by the browser AI adapter for the current browser session; it is not sent to the application server or written to the application database.
- **Server-stored key**: an encrypted provider key held in `ai-config.db`; it is decrypted only while the authenticated user's AI request is being made.

## Ownership rule

Public question content may be shared. Personal rows must always be created, read, updated, and deleted with the authenticated user's `user_id`. Existing pre-login personal rows are assigned once to the first account that uses the upgraded data directory; later accounts do not inherit them.

## Authentication boundary

Better Auth owns users, accounts, and sessions in `auth.db`. The study domain owns its SQLite data and applies the ownership filter in the API layer. Authentication alone is not considered sufficient isolation.
