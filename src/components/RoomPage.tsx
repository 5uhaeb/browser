import { useEffect, useState, useRef } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, WheelEvent } from "react";
import { socket } from "../lib/socket";
import { motion, AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";

interface Participant {
  id: string;
  name: string;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export default function RoomPage({ roomId, inviteCode, userName, onLeave }: { roomId: string; inviteCode: string; userName: string; onLeave: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");
  const [browserUrl, setBrowserUrl] = useState("https://www.google.com");
  const [tabCount, setTabCount] = useState(1);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const join = () => socket.emit("join-room", { roomId, name: userName });
    if (socket.connected) join();
    socket.on("connect", join);

    socket.on("room-state", (state) => {
      setMessages(state.messages);
      setParticipants(state.participants);
    });

    socket.on("participants-updated", setParticipants);

    socket.on("new-chat-message", (message) => {
      setMessages((current) => [...current, message]);
    });

    socket.on("browser-state-update", (state) => {
      if (state.url) setBrowserUrl(state.url);
      if (state.tabs) setTabCount(state.tabs);
      if (state.activeIndex !== undefined) setActiveTabIndex(state.activeIndex);
    });

    socket.on("stream-frame", (base64) => {
      setFrame(`data:image/jpeg;base64,${base64}`);
    });

    socket.on("room-error", (err) => {
      alert(err);
      onLeave();
    });

    return () => {
      socket.off("connect", join);
      socket.off("room-state");
      socket.off("participants-updated");
      socket.off("new-chat-message");
      socket.off("browser-state-update");
      socket.off("stream-frame");
      socket.off("room-error");
    };
  }, [roomId, userName, onLeave]);

  const newTab = () => socket.emit("browser-control", { action: "new-tab", data: {} });
  const switchTab = (index: number) => socket.emit("browser-control", { action: "switch-tab", data: { index } });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = (e: FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    socket.emit("chat-message", inputText);
    setInputText("");
  };

  const navigateBrowser = (e: FormEvent) => {
    e.preventDefault();
    socket.emit("browser-control", { action: "navigate", data: { url: browserUrl } });
  };

  const handleBrowserClick = (e: MouseEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 1280;
    const y = ((e.clientY - rect.top) / rect.height) * 720;
    socket.emit("browser-control", { action: "click", data: { x, y } });
  };

  const handleWheel = (e: WheelEvent) => {
    socket.emit("browser-control", { 
      action: "scroll", 
      data: { deltaX: e.deltaX, deltaY: e.deltaY } 
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Only capture if not typing in chat or address bar
    if (e.target instanceof HTMLInputElement) return;
    
    // Prevent default common shortcuts like space scrolling or backspace navigating
    if ([" ", "Backspace", "Tab", "Enter"].includes(e.key)) {
      e.preventDefault();
    }
    
    socket.emit("browser-control", { 
      action: "press", 
      data: { key: e.key } 
    });
  };

  const controlBrowser = (action: "back" | "forward" | "reload") => {
    socket.emit("browser-control", { action, data: {} });
  };

  return (
    <div className="grid grid-cols-[1fr_320px] grid-rows-[64px_1fr_64px] h-screen w-screen bg-[#0A0A0B] text-[#E4E4E7] font-sans overflow-hidden">
      {/* Header */}
      <header className="col-span-2 border-b border-[#27272A] flex items-center justify-between px-6 bg-[#0F0F11]">
        <div className="flex items-center gap-4">
          <span className="font-bold text-lg tracking-tight">StreamRoom</span>
          <div className="flex items-center bg-[#27272A] border border-[#3F3F46] rounded-md px-3 py-1 cursor-default group">
            <span className="text-[10px] font-bold text-[#A1A1AA] uppercase tracking-wider mr-2">Invite</span>
            <span className="text-[#38BDF8] font-mono text-xs tracking-widest">{inviteCode}</span>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
             <span className="text-xs text-[#71717A]">Latency: <span className="text-[#A1A1AA]">42ms</span></span>
             <span className="text-xs text-[#71717A]">Quality: <span className="text-[#A1A1AA]">1080p Source</span></span>
          </div>
        </div>
      </header>

      {/* Main Stream View */}
      <main className="bg-black flex flex-col p-4 gap-0">
        {/* Chrome Tab Bar */}
        <div className="flex items-end gap-1 px-4 h-9 bg-black">
          {Array.from({ length: tabCount }).map((_, i) => (
            <button
              key={i}
              onClick={() => switchTab(i)}
              className={`h-8 px-4 rounded-t-lg text-[11px] font-semibold flex items-center gap-2 transition-all ${i === activeTabIndex ? 'bg-[#27272A] text-white' : 'bg-[#18181B] text-[#71717A] hover:bg-[#27272A]/50'}`}
              style={{ minWidth: '120px' }}
            >
              <div className="w-2.5 h-2.5 rounded-sm bg-white/10" />
              Tab {i + 1}
            </button>
          ))}
          <button 
            onClick={newTab}
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#71717A] hover:bg-white/5 mb-1"
          >
            +
          </button>
        </div>

        <div className="flex-1 bg-[#18181B] border border-[#27272A] rounded-b-xl rounded-tr-xl overflow-hidden flex flex-col shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          {/* Browser UI */}
          <div className="h-10 bg-[#27272A] flex items-center px-3 gap-2">
             <div className="flex gap-1.5 mr-4">
               <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]"></div>
               <div className="w-2.5 h-2.5 rounded-full bg-[#FFBD2E]"></div>
               <div className="w-2.5 h-2.5 rounded-full bg-[#28C840]"></div>
             </div>
             
             <div className="flex items-center gap-1 mr-2 text-[#71717A]">
               <button onClick={() => controlBrowser("back")} className="hover:bg-white/5 p-1 rounded-md hover:text-white transition-colors">
                  <ChevronLeft className="w-4 h-4" />
               </button>
               <button onClick={() => controlBrowser("forward")} className="hover:bg-white/5 p-1 rounded-md hover:text-white transition-colors">
                  <ChevronRight className="w-4 h-4" />
               </button>
               <button onClick={() => controlBrowser("reload")} className="hover:bg-white/5 p-1 rounded-md hover:text-white transition-colors">
                  <RotateCcw className="w-3.5 h-3.5" />
               </button>
             </div>

             <form onSubmit={navigateBrowser} className="flex-1 bg-[#09090B] border border-[#3F3F46] rounded-[4px] h-7 flex items-center px-3">
               <input 
                 type="text" 
                 value={browserUrl}
                 onChange={(e) => setBrowserUrl(e.target.value)}
                 className="w-full bg-transparent text-[#A1A1AA] text-xs outline-none"
               />
             </form>
          </div>

          {/* Canvas Content */}
          <div 
            className="flex-1 overflow-hidden relative flex items-center justify-center bg-[#fdfdfd] outline-none"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onWheel={handleWheel}
          >
            {frame ? (
              <img
                src={frame}
                alt="Remote Browser"
                className="max-w-full max-h-full object-contain cursor-crosshair"
                onMouseDown={handleBrowserClick}
              />
            ) : (
              <div className="text-center">
                <h1 className="text-5xl font-serif text-[#18181B] mb-2">LOADING</h1>
                <div className="w-20 h-[1px] bg-[#27272A] mx-auto my-4 opacity-20"></div>
                <p className="text-sm text-[#71717A]">Establishing secure relay...</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Sidebar Chat */}
      <aside className="border-l border-[#27272A] bg-[#0F0F11] flex flex-col">
        <div className="flex-1 p-4 overflow-y-auto space-y-3">
          <AnimatePresence mode="popLayout">
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-sm leading-relaxed"
              >
                <span className={`font-bold mr-2 ${msg.senderId === socket.id ? 'text-[#38BDF8]' : 'text-[#A855F7]'}`}>
                  {msg.senderName}
                </span>
                <span className="text-[#E4E4E7]">{msg.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
          <div ref={chatEndRef} />
        </div>

        <div className="p-4 border-t border-[#27272A]">
          <form onSubmit={sendMessage}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type a message..."
              className="w-full bg-[#18181B] border border-[#27272A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[#3F3F46] transition-all placeholder:text-[#3F3F46]"
            />
          </form>
        </div>
      </aside>

      {/* Footer Status Bar */}
      <footer className="col-span-2 bg-[#0A0A0B] border-t border-[#27272A] flex items-center px-6 gap-6">
        <div className="flex gap-4 items-center">
          {participants.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-xs text-[#A1A1AA]">
              <div className="w-2 h-2 rounded-full bg-[#22C55E]"></div>
              <span>{p.name}{p.id === socket.id && ' (You)'}</span>
            </div>
          ))}
        </div>

        <button
          onClick={onLeave}
          className="ml-auto bg-[#7F1D1D] text-[#F87171] border border-[#991B1B] px-4 py-1.5 rounded-md text-xs font-bold hover:bg-[#991B1B] transition-colors"
        >
          Leave Room
        </button>
      </footer>
    </div>
  );
}
