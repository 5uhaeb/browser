import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { existsSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { nanoid } from "nanoid";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";

// --- Types & Constants ---
interface Participant {
  id: string;
  name: string;
  joinedAt: number;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

interface Room {
  id: string;
  inviteCode: string;
  participants: Map<string, Participant>;
  messages: ChatMessage[];
  createdAt: number;
  lastActivity: number;
  lastEmptyAt: number | null; // Track when the room became empty
  browser?: {
    context: BrowserContext;
    userDataDir: string;
    activePageIndex: number;
    pages: Page[];
    streamInterval?: NodeJS.Timeout;
  };
}

const ROOM_TTL = 1000 * 60 * 60; // 1 hour of inactivity
const EMPTY_COOLDOWN = 1000 * 10; // Remove ended sessions quickly, while tolerating quick reconnects
const rooms = new Map<string, Room>();

const BROWSER_VIEWPORT = { width: 1024, height: 576 };
const STREAM_FPS = Math.max(1, Math.min(Number(process.env.STREAM_FPS || 6), 12));
const STREAM_JPEG_QUALITY = Math.max(20, Math.min(Number(process.env.STREAM_JPEG_QUALITY || 35), 80));
const BROWSER_PERMISSIONS = [
  "clipboard-read",
  "clipboard-write",
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "payment-handler",
] as const;

function getExtensionPaths() {
  return (process.env.BROWSER_EXTENSION_PATHS || "")
    .split(path.delimiter)
    .map((extensionPath) => extensionPath.trim())
    .filter(Boolean)
    .map((extensionPath) => path.resolve(extensionPath))
    .filter((extensionPath) => {
      if (existsSync(extensionPath)) return true;
      console.warn(`Skipping missing extension path: ${extensionPath}`);
      return false;
    });
}

function getBrowserArgs(extensionPaths: string[]) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
  ];

  if (extensionPaths.length > 0) {
    const extensionList = extensionPaths.join(",");
    args.push(`--disable-extensions-except=${extensionList}`);
    args.push(`--load-extension=${extensionList}`);
  }

  return args;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "https://www.google.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function wireBrowserPage(roomId: string, page: Page, io: Server) {
  await page.exposeFunction("watchPartyAudioChunk", (base64: string) => {
    io.to(roomId).emit("audio-chunk", base64);
  });

  await page.addInitScript(() => {
    const windowWithAudio = window as typeof window & {
      __watchPartyAudioInstalled?: boolean;
      watchPartyAudioChunk?: (base64: string) => void;
    };

    if (windowWithAudio.__watchPartyAudioInstalled) return;
    windowWithAudio.__watchPartyAudioInstalled = true;

    let recorder: MediaRecorder | null = null;

    const sendBlob = (blob: Blob) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const base64 = result.split(",")[1];
        if (base64) windowWithAudio.watchPartyAudioChunk?.(base64);
      };
      reader.readAsDataURL(blob);
    };

    const startAudio = (media: HTMLMediaElement) => {
      if (recorder || typeof MediaRecorder === "undefined") return;

      const mediaWithCapture = media as HTMLMediaElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const captureStream = mediaWithCapture.captureStream?.bind(media) || mediaWithCapture.mozCaptureStream?.bind(media);
      if (!captureStream) return;

      const stream = captureStream();
      if (stream.getAudioTracks().length === 0) return;

      media.muted = false;
      media.volume = 1;

      const options = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? { mimeType: "audio/webm;codecs=opus" }
        : undefined;
      recorder = new MediaRecorder(stream, options);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) sendBlob(event.data);
      };
      recorder.onstop = () => {
        recorder = null;
      };
      recorder.start(500);
    };

    const scanForMedia = () => {
      document.querySelectorAll("video,audio").forEach((element) => {
        const media = element as HTMLMediaElement;
        media.muted = false;
        if (!media.paused) startAudio(media);
        media.addEventListener("play", () => startAudio(media));
      });
    };

    new MutationObserver(scanForMedia).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("load", scanForMedia);
    setInterval(scanForMedia, 2000);
    scanForMedia();
  });
}

async function destroyRoom(id: string) {
  const room = rooms.get(id);
  if (!room) return;

  rooms.delete(id);
  console.log(`Cleaning up room: ${id}`);

  if (room.browser?.streamInterval) clearInterval(room.browser.streamInterval);
  await room.browser?.context.close().catch(() => {});

  if (room.browser?.userDataDir) {
    await rm(room.browser.userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Room Manager Logic ---
function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const isInactive = now - room.lastActivity > ROOM_TTL;
    const isEmpty = room.participants.size === 0;
    const isUnjoinedTooLong = room.participants.size === 0 && !room.lastEmptyAt && now - room.createdAt > 1000 * 60 * 5;

    // Robust empty check: Only delete if been empty for 60 seconds
    const emptyTooLong = room.lastEmptyAt && (now - room.lastEmptyAt > EMPTY_COOLDOWN);

    if (isInactive || isUnjoinedTooLong || (isEmpty && emptyTooLong)) {
      void destroyRoom(id);
    }
  }
}
setInterval(cleanupRooms, 15000); // Check more frequently (every 15s) for better responsiveness

// --- Server Setup ---
async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  app.use(express.json());

  // --- API Routes ---
  app.post("/api/rooms", async (req, res) => {
    const inviteCode = nanoid(8).toUpperCase();
    const roomId = nanoid(12);
    let userDataDir: string | null = null;

    try {
      const extensionPaths = getExtensionPaths();
      userDataDir = await mkdtemp(path.join(os.tmpdir(), "watchparty-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: extensionPaths.length > 0 ? "chromium" : undefined,
        args: getBrowserArgs(extensionPaths),
        viewport: BROWSER_VIEWPORT,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        locale: "en-US",
        timezoneId: "America/New_York",
        permissions: [...BROWSER_PERMISSIONS],
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
      });

      // Ultra Stealth Masking
      await context.addInitScript(() => {
        // Hide automation
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Fake plugins
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // Fake languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        // Fake WebGL
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Open Source Technology Center';
          if (parameter === 37446) return 'Mesa DRI Intel(R) HD Graphics 520 (Skylake GT2)';
          return getParameter.apply(this, (arguments as unknown) as [number]);
        };
      });

      const page = await context.newPage();
      await wireBrowserPage(roomId, page, io);
      await page.goto("https://www.google.com");

      const pages = [page];
      const activePageIndex = 0;

      // Browser State Sync Logic
      const syncBrowserState = () => {
        const browserState = rooms.get(roomId)?.browser;
        const activePage = browserState?.pages[browserState.activePageIndex];
        if (activePage) {
          io.to(roomId).emit("browser-state-update", {
            url: activePage.url(),
            tabs: browserState.pages.length,
            activeIndex: browserState.activePageIndex
          });
        }
      };
      
      page.on("framenavigated", syncBrowserState);

      // Start one stream loop for the room
      const streamInterval = setInterval(async () => {
        if (!rooms.has(roomId)) return clearInterval(streamInterval);
        try {
          const browserState = rooms.get(roomId)?.browser;
          const activePage = browserState?.pages[browserState.activePageIndex];
          if (activePage && !activePage.isClosed()) {
            const buffer = await activePage.screenshot({ type: "jpeg", quality: STREAM_JPEG_QUALITY });
            if (buffer) {
              io.to(roomId).volatile.emit("stream-frame", buffer);
            }
          }
        } catch (e) {}
      }, Math.round(1000 / STREAM_FPS));

      const newRoom: Room = {
        id: roomId,
        inviteCode,
        participants: new Map(),
        messages: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
        lastEmptyAt: null,
        browser: { context, userDataDir, pages, activePageIndex, streamInterval },
      };

      rooms.set(roomId, newRoom);
      res.json({ roomId, inviteCode });
    } catch (error) {
      console.error("Failed to launch browser:", error);
      if (userDataDir) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
      res.status(500).json({
        error: "Could not start browser session. On Render, make sure the build command runs `npm run render-build`.",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/rooms/validate/:code", (req, res) => {
    const inviteCode = req.params.code.toUpperCase();
    const room = Array.from(rooms.values()).find((r) => r.inviteCode === inviteCode);
    if (room) {
      res.json({ roomId: room.id, isValid: true });
    } else {
      res.status(404).json({ isValid: false });
    }
  });

  // --- Socket.io Realtime Logic ---
  io.on("connection", (socket) => {
    socket.on("join-room", ({ roomId, name }) => {
      console.log(`Join attempt: Room ${roomId} by ${name} (${socket.id})`);
      const room = rooms.get(roomId);
      
      if (!room) {
        console.error(`Join failed: Room ${roomId} not found`);
        return socket.emit("room-error", "Room not found or expired");
      }

      const nameExists = Array.from(room.participants.values()).some((p) => p.name === name && p.id !== socket.id);
      if (nameExists) {
        console.warn(`Join failed: Name ${name} taken in room ${roomId}`);
        return socket.emit("room-error", "Display name taken");
      }

      const participant: Participant = { id: socket.id, name, joinedAt: Date.now() };
      room.participants.set(socket.id, participant);
      room.lastActivity = Date.now();
      room.lastEmptyAt = null; // No longer empty
      socket.join(roomId);

      console.log(`Join success: ${name} joined ${roomId}`);
      io.to(roomId).emit("participants-updated", Array.from(room.participants.values()));
      socket.emit("room-state", {
        messages: room.messages,
        participants: Array.from(room.participants.values()),
      });

      socket.on("chat-message", (text) => {
        const msg: ChatMessage = { id: nanoid(), senderId: socket.id, senderName: name, text, timestamp: Date.now() };
        room.messages.push(msg);
        room.lastActivity = Date.now();
        io.to(roomId).emit("new-chat-message", msg);
      });

      socket.on("browser-control", async ({ action, data }) => {
        if (!room.browser) return;
        const activePage = room.browser.pages[room.browser.activePageIndex];
        if (!activePage) return;

        try {
           if (action === "navigate") await activePage.goto(normalizeUrl(data.url || ""));
           else if (action === "click") await activePage.mouse.click(data.x, data.y);
           else if (action === "scroll") await activePage.mouse.wheel(data.deltaX || 0, data.deltaY || 0);
           else if (action === "press") await activePage.keyboard.press(data.key);
           else if (action === "back") await activePage.goBack();
           else if (action === "forward") await activePage.goForward();
           else if (action === "reload") await activePage.reload();
           else if (action === "new-tab") {
             const newPage = await room.browser.context.newPage();
             await wireBrowserPage(roomId, newPage, io);
             await newPage.goto("https://www.google.com");
             room.browser.pages.push(newPage);
             room.browser.activePageIndex = room.browser.pages.length - 1;
             // Re-bind sync
             newPage.on("framenavigated", () => {
               const idx = room.browser?.pages.indexOf(newPage);
               if (idx === room.browser?.activePageIndex) {
                 io.to(roomId).emit("browser-state-update", { url: newPage.url(), tabs: room.browser?.pages.length, activeIndex: idx });
               }
             });
             io.to(roomId).emit("browser-state-update", { url: newPage.url(), tabs: room.browser.pages.length, activeIndex: room.browser.activePageIndex });
           }
           else if (action === "switch-tab") {
             if (data.index >= 0 && data.index < room.browser.pages.length) {
                room.browser.activePageIndex = data.index;
                const newActive = room.browser.pages[data.index];
                io.to(roomId).emit("browser-state-update", { url: newActive.url(), tabs: room.browser.pages.length, activeIndex: data.index });
             }
           }
           room.lastActivity = Date.now();
        } catch (e) {}
      });

      socket.on("disconnect", () => {
        console.log(`Participant left: ${name} (${socket.id})`);
        room.participants.delete(socket.id);
        room.lastActivity = Date.now();
        if (room.participants.size === 0) {
          room.lastEmptyAt = Date.now();
        }
        io.to(roomId).emit("participants-updated", Array.from(room.participants.values()));
      });
    });
  });

  // --- Vite / Static Assets ---
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
