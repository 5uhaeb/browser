/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from "react";
import JoinPage from "./components/JoinPage";
import RoomPage from "./components/RoomPage";
import { socket } from "./lib/socket";

export default function App() {
  const [session, setSession] = useState<{ roomId: string; inviteCode: string; name: string } | null>(null);

  useEffect(() => {
    if (session) {
      console.log("Session detected, opening socket...");
      socket.open();
    } else {
      socket.disconnect();
    }
  }, [session]);

  const handleJoin = (roomId: string, inviteCode: string, name: string) => {
    setSession({ roomId, inviteCode, name });
  };

  const handleLeave = () => {
    setSession(null);
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      {!session ? (
        <JoinPage onJoined={handleJoin} />
      ) : (
        <RoomPage 
          roomId={session.roomId} 
          inviteCode={session.inviteCode}
          userName={session.name} 
          onLeave={handleLeave} 
        />
      )}
    </div>
  );
}
