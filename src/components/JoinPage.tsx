import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";

export default function JoinPage({ onJoined }: { onJoined: (roomId: string, inviteCode: string, name: string) => void }) {
  const [inviteCode, setInviteCode] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [mode, setMode] = useState<"join" | "create">("join");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    const code = inviteCode.trim().toUpperCase();
    if (!displayName) return alert("Please enter a display name");
    
    setErrorMessage("");
    setIsLoading(true);
    try {
      if (mode === "create") {
        const res = await fetch("/api/rooms", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not create a room");
        onJoined(data.roomId, data.inviteCode, displayName);
      } else {
        if (!code) return alert("Please enter an invite code");
        const res = await fetch(`/api/rooms/validate/${code}`);
        if (res.ok) {
          const data = await res.json();
          onJoined(data.roomId, code, displayName);
        } else {
          alert("Invalid invite code");
        }
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : "Something went wrong";
      setErrorMessage(message);
      alert(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0A0B] flex items-center justify-center p-6 font-sans">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="w-full max-w-sm"
      >
        <div className="mb-12">
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2">WatchParty</h1>
          <p className="text-[#A1A1AA] text-sm">Minimalist browser streaming for friends.</p>
        </div>

        <div className="flex p-1 bg-[#18181B] border border-[#27272A] rounded-lg mb-8">
          <button
            type="button"
            onClick={() => setMode("join")}
            className={`flex-1 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-all ${mode === "join" ? 'bg-[#27272A] text-white shadow-sm' : 'text-[#71717A] hover:text-white'}`}
          >
            Join
          </button>
          <button
            type="button"
            onClick={() => setMode("create")}
            className={`flex-1 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-all ${mode === "create" ? 'bg-[#27272A] text-white shadow-sm' : 'text-[#71717A] hover:text-white'}`}
          >
            Create
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-[#71717A] uppercase tracking-[0.2em] mb-2 px-1">Display Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                className="w-full bg-[#18181B] border border-[#27272A] rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-[#38BDF8] transition-all placeholder:text-[#3F3F46]"
              />
            </div>

            {mode === "join" && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
              >
                <label className="block text-[10px] font-bold text-[#71717A] uppercase tracking-[0.2em] mb-2 px-1">Invite Code</label>
                <input
                  type="text"
                  required={mode === "join"}
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="EX-CODE"
                  className="w-full bg-[#18181B] border border-[#27272A] rounded-lg px-4 py-3 text-[#38BDF8] font-mono text-sm focus:outline-none focus:border-[#38BDF8] transition-all placeholder:text-[#3F3F46] uppercase"
                />
              </motion.div>
            )}
          </div>

          <button
            disabled={isLoading}
            className="w-full bg-white hover:bg-[#E4E4E7] text-black font-bold py-3.5 rounded-lg transition-all flex items-center justify-center gap-2 group"
          >
            {isLoading ? (
              <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
            ) : (
              <>
                {mode === "join" ? "Join Stream" : "Create Session"}
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </>
            )}
          </button>
          {errorMessage && (
            <p className="text-xs leading-relaxed text-[#F87171] bg-[#7F1D1D]/20 border border-[#7F1D1D] rounded-lg p-3">
              {errorMessage}
            </p>
          )}
        </form>

        <div className="mt-12 flex items-center gap-6 text-[10px] font-bold text-[#3F3F46] uppercase tracking-[0.1em]">
          <span>Ephemeral Storage</span>
          <span>End-to-End Sync</span>
        </div>
      </motion.div>
    </div>
  );
}
