# WatchParty - Codex Context

Stack: TypeScript, Vite, React, Express, Playwright Chromium, Socket.IO.

Entry points:
- Backend: `server.ts`
- Frontend: `src/`
- HTML shell: `index.html`

Common commands:
- Dev: `npm run dev`
- Build: `npm run build`
- Render build: `npm run render-build`
- Start: `npm start`
- Lint/type-check: `npm run lint` (`tsc --noEmit`)

Project rules:
- Use ESM only; do not introduce CommonJS.
- Do not add new dependencies without asking first.
- Keep Playwright launch/session options centralized in `server.ts`.
- Do not edit `package-lock.json` manually; update it via npm commands.
- Prefer small, focused changes that preserve the current app shape.
- Run `npm run lint` after TypeScript changes and `npm run build` for release-facing changes.

Runtime notes:
- Playwright Chromium is required: `npx playwright install chromium`.
- The dev server listens on `http://localhost:3000` unless `PORT` is set.
- Room state is in memory; invite codes, messages, and browser profiles are ephemeral.
- Extension support uses unpacked folders from `BROWSER_EXTENSION_PATHS`.
