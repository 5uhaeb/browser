import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { nanoid } from "nanoid";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

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
    instance: Browser;
    context: BrowserContext;
    activePageIndex: number;
    pages: Page[];
    streamInterval?: NodeJS.Timeout;
  };
}

const ROOM_TTL = 1000 * 60 * 60; // 1 hour of inactivity
const EMPTY_COOLDOWN = 1000 * 60; // Keep empty rooms for 1 min before deleting
const rooms = new Map<string, Room>();

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "https://www.google.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// --- Room Manager Logic ---
function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const isInactive = now - room.lastActivity > ROOM_TTL;
    const isEmpty = room.participants.size === 0;
    const isNew = now - room.createdAt < 1000 * 60 * 5; // 5 min original grace

    // Robust empty check: Only delete if been empty for 60 seconds
    const emptyTooLong = room.lastEmptyAt && (now - room.lastEmptyAt > EMPTY_COOLDOWN);

    if (isInactive || (isEmpty && !isNew && emptyTooLong)) {
      console.log(`Cleaning up room: ${id}`);
      if (room.browser?.streamInterval) clearInterval(room.browser.streamInterval);
      room.browser?.context.close().catch(() => {});
      room.browser?.instance.close().catch(() => {});
      rooms.delete(id);
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

    try {
      const browser = await chromium.launch({ 
        headless: true,
        args: [
          "--no-sandbox", 
          "--disable-setuid-sandbox", 
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled", // Mask automation
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream"
        ]
      });

      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        locale: "en-US",
        timezoneId: "America/New_York",
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
          const activePage = pages[activePageIndex];
          if (activePage) {
            const buffer = await activePage.screenshot({ type: "jpeg", quality: 40 });
            if (buffer) {
              io.to(roomId).emit("stream-frame", buffer.toString("base64"));
            }
          }
        } catch (e) {}
      }, 333); // ~3 FPS

      const newRoom: Room = {
        id: roomId,
        inviteCode,
        participants: new Map(),
        messages: [],
        createdAt: Date.now(),
        lastActivity: Date.now(),
        lastEmptyAt: Date.now(),
        browser: { instance: browser, context, pages, activePageIndex, streamInterval },
      };

      rooms.set(roomId, newRoom);
      res.json({ roomId, inviteCode });
    } catch (error) {
      console.error("Failed to launch browser:", error);
      res.status(500).json({ error: "Could not start browser session" });
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
