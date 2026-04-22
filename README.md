# WatchParty

WatchParty is a DB-free shared browser room: create an invite code, stream a hosted Chromium session, control the browser together, and chat in real time.

All room state is in memory. Browser profiles are temporary per room and are deleted when the room ends.

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:

   ```sh
   npm install
   ```

2. Install the Playwright browser runtime:

   ```sh
   npx playwright install chromium
   ```

3. Run the app:

   ```sh
   npm run dev
   ```

4. Open `http://localhost:3000`.

## Browser Extensions

Set `BROWSER_EXTENSION_PATHS` to one or more unpacked Chrome extension directories before starting the server.

```sh
BROWSER_EXTENSION_PATHS=/absolute/path/to/extension npm run dev
```

On Windows, separate multiple paths with `;`. On Linux/macOS, separate multiple paths with `:`.

## Production

```sh
npm run build
npm start
```

## Render

Create a Web Service, not a Static Site. Use the Docker environment.

- Root directory: leave blank or use `.`
- Environment: Docker
- Dockerfile path: `./Dockerfile`
- Publish directory: leave blank

The Docker image is based on Microsoft's official Playwright image, so Chromium and the Linux system dependencies are already present.
