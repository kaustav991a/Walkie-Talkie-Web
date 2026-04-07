import React, { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Mic, MicOff, Users, User, Bell, Settings, Radio, Send, MessageSquare } from 'lucide-react';
import { WebRTCManager } from './lib/webrtc';
import { audioEngine } from './lib/audio';
import { cn } from './lib/utils';

interface UserState {
  id: string;
  name: string;
  isTalking: boolean;
  target: string;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
  target: string;
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [rtcManager, setRtcManager] = useState<WebRTCManager | null>(null);
  const [joined, setJoined] = useState(false);
  const [username, setUsername] = useState('');
  const [users, setUsers] = useState<Map<string, UserState>>(new Map());
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [activeTarget, setActiveTarget] = useState<string>('team'); // 'team' or userId
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number>();

  // Initialize Socket and WebRTC
  useEffect(() => {
    if (!joined || !username) return;

    const newSocket = io();
    setSocket(newSocket);

    const manager = new WebRTCManager(newSocket, (userId, isTalking, target) => {
      setUsers(prev => {
        const newMap = new Map(prev);
        const user = newMap.get(userId);
        if (user) {
          newMap.set(userId, { ...user, isTalking, target });
        }
        return newMap;
      });

      // Audio Ducking Logic
      if (isTalking && target !== 'team') {
        // Someone is talking directly to someone (maybe us)
        // Duck the team channel
        audioEngine.duckTeam(true);
      } else if (!isTalking) {
        // Restore team volume
        audioEngine.duckTeam(false);
      }

      // Desktop Notification Logic
      if (isTalking && notificationsEnabled) {
        const user = users.get(userId);
        if (user && document.hidden) {
          new Notification(`New Message from ${user.name}`, {
            body: target === 'team' ? 'Speaking to Team' : 'Direct Message',
            icon: '/favicon.ico'
          });
        }
      }
    });

    setRtcManager(manager);

    newSocket.on('chat-message', (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg]);
      
      // Notification for text messages
      if (notificationsEnabled && document.hidden) {
        new Notification(`Text from ${msg.senderName}`, {
          body: msg.text,
          icon: '/favicon.ico'
        });
      }
    });

    newSocket.on('connect', async () => {
      const micGranted = await manager.initializeLocalStream();
      if (micGranted) {
        audioEngine.init();
        newSocket.emit('join', username);
      } else {
        alert("Microphone access is required for the Walkie-Talkie.");
      }
    });

    newSocket.on('existing-users', (existingUsers: any[]) => {
      setUsers(prev => {
        const newMap = new Map(prev);
        existingUsers.forEach(u => newMap.set(u.id, { ...u, isTalking: false, target: 'team' }));
        return newMap;
      });
    });

    newSocket.on('user-joined', (user: any) => {
      setUsers(prev => {
        const newMap = new Map(prev);
        newMap.set(user.id, { ...user, isTalking: false, target: 'team' });
        return newMap;
      });
    });

    newSocket.on('user-left', (userId: string) => {
      setUsers(prev => {
        const newMap = new Map(prev);
        newMap.delete(userId);
        return newMap;
      });
    });

    return () => {
      newSocket.disconnect();
      cancelAnimationFrame(requestRef.current!);
    };
  }, [joined, username]);

  // Global Hotkey (Spacebar) for PTT
  useEffect(() => {
    if (!rtcManager) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body) {
        e.preventDefault();
        setIsPTTActive(true);
        audioEngine.resume(); // Ensure AudioContext is running
        rtcManager.broadcastPTT(true, activeTarget);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        setIsPTTActive(false);
        rtcManager.broadcastPTT(false, activeTarget);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [rtcManager, activeTarget]);

  // Waveform Visualization
  const drawWaveform = useCallback(() => {
    if (!canvasRef.current || !audioEngine.ctx) return;
    
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dataArray = audioEngine.getWaveformData();
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    // Determine if anyone is talking to set color
    const isAnyoneTalking = Array.from(users.values()).some(u => u.isTalking) || isPTTActive;
    
    ctx.lineWidth = 3;
    ctx.strokeStyle = isPTTActive ? '#ef4444' : (isAnyoneTalking ? '#10b981' : '#3f3f46');
    ctx.shadowBlur = isAnyoneTalking ? 15 : 0;
    ctx.shadowColor = ctx.strokeStyle;

    ctx.beginPath();
    const sliceWidth = width * 1.0 / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    requestRef.current = requestAnimationFrame(drawWaveform);
  }, [users, isPTTActive]);

  useEffect(() => {
    if (joined) {
      requestRef.current = requestAnimationFrame(drawWaveform);
    }
    return () => cancelAnimationFrame(requestRef.current!);
  }, [joined, drawWaveform]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeTarget]);

  const requestNotifications = async () => {
    if ('Notification' in window) {
      const permission = await Notification.requestPermission();
      setNotificationsEnabled(permission === 'granted');
    }
  };

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !socket) return;
    
    socket.emit('chat-message', {
      text: chatInput.trim(),
      target: activeTarget
    });
    setChatInput('');
  };

  const activeMessages = messages.filter(m => 
    m.target === 'team' ? activeTarget === 'team' : 
    (m.target === activeTarget && m.senderId === socket?.id) || 
    (m.senderId === activeTarget && m.target === socket?.id)
  );

  if (!joined) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-100 font-sans">
        <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800 shadow-2xl w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center">
              <Radio className="w-8 h-8 text-emerald-500" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold text-center mb-2">Walkie-Talkie</h1>
          <p className="text-zinc-400 text-center mb-8 text-sm">Enter your callsign to join the frequency.</p>
          
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Callsign (e.g. Maverick)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 mb-4 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
            onKeyDown={(e) => e.key === 'Enter' && username && setJoined(true)}
          />
          <button
            onClick={() => setJoined(true)}
            disabled={!username}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors"
          >
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans flex overflow-hidden">
      {/* Sidebar: DMs and Team */}
      <div className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-emerald-500" />
            <span className="font-semibold tracking-tight">Channels</span>
          </div>
          <button 
            onClick={requestNotifications}
            className={cn("p-1.5 rounded-md transition-colors", notificationsEnabled ? "text-emerald-500 bg-emerald-500/10" : "text-zinc-500 hover:bg-zinc-800")}
            title="Enable Desktop Notifications"
          >
            <Bell className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {/* Team Channel */}
          <button
            onClick={() => setActiveTarget('team')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all",
              activeTarget === 'team' ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            )}
          >
            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700">
              <Users className="w-4 h-4" />
            </div>
            <div className="flex-1 text-left">
              <div className="font-medium text-sm">Team Global</div>
              <div className="text-xs text-zinc-500">{users.size + 1} online</div>
            </div>
          </button>

          <div className="pt-4 pb-2 px-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
            Direct Messages
          </div>

          {/* Individual Users */}
          {Array.from(users.values()).map(user => (
            <button
              key={user.id}
              onClick={() => setActiveTarget(user.id)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all group",
                activeTarget === user.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              )}
            >
              <div className="relative">
                <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700">
                  <User className="w-4 h-4" />
                </div>
                {/* Status Indicator */}
                <div className={cn(
                  "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-zinc-900 transition-colors",
                  user.isTalking ? "bg-emerald-500 animate-pulse" : "bg-zinc-500"
                )} />
              </div>
              <div className="flex-1 text-left truncate">
                <div className="font-medium text-sm truncate">{user.name}</div>
                <div className="text-xs text-zinc-500 truncate">
                  {user.isTalking ? 'Transmitting...' : 'Idle'}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Current User Profile */}
        <div className="p-4 border-t border-zinc-800 bg-zinc-900/50 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
            <span className="text-emerald-500 font-medium text-sm">{username.charAt(0).toUpperCase()}</span>
          </div>
          <div className="flex-1 truncate">
            <div className="font-medium text-sm text-zinc-200 truncate">{username}</div>
            <div className="text-xs text-emerald-500">Online</div>
          </div>
          <button className="text-zinc-500 hover:text-zinc-300 transition-colors">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative">
        {/* Top Bar */}
        <div className="h-16 border-b border-zinc-800 flex items-center px-6 justify-between bg-zinc-950/50 backdrop-blur-sm z-10">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-medium text-zinc-200">
              {activeTarget === 'team' ? 'Team Global Frequency' : `Private Channel: ${users.get(activeTarget)?.name}`}
            </span>
          </div>
          
          {/* "Tray" Indicator Simulation */}
          <div className={cn(
            "px-3 py-1.5 rounded-full text-xs font-medium flex items-center gap-2 transition-colors border",
            isPTTActive 
              ? "bg-red-500/10 text-red-500 border-red-500/20" 
              : Array.from(users.values()).some(u => u.isTalking)
                ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                : "bg-zinc-800 text-zinc-400 border-zinc-700"
          )}>
            {isPTTActive ? (
              <><Mic className="w-3 h-3" /> Transmitting</>
            ) : Array.from(users.values()).some(u => u.isTalking) ? (
              <><Radio className="w-3 h-3" /> Receiving</>
            ) : (
              <><MicOff className="w-3 h-3" /> Standby</>
            )}
          </div>
        </div>

        {/* Central Waveform Visualization */}
        <div className="flex-1 flex items-center justify-center relative overflow-hidden">
          {/* Background Glow */}
          <div className={cn(
            "absolute inset-0 opacity-20 transition-opacity duration-500 blur-3xl",
            isPTTActive ? "bg-red-500/20" : Array.from(users.values()).some(u => u.isTalking) ? "bg-emerald-500/20" : "bg-transparent"
          )} />
          
          <canvas 
            ref={canvasRef}
            width={800}
            height={400}
            className="w-full max-w-4xl h-64 z-10"
          />
        </div>

        {/* Bottom Controls */}
        <div className="p-8 flex flex-col items-center justify-center bg-gradient-to-t from-zinc-950 to-transparent z-10">
          <button
            onMouseDown={() => {
              setIsPTTActive(true);
              audioEngine.resume();
              rtcManager?.broadcastPTT(true, activeTarget);
            }}
            onMouseUp={() => {
              setIsPTTActive(false);
              rtcManager?.broadcastPTT(false, activeTarget);
            }}
            onMouseLeave={() => {
              if (isPTTActive) {
                setIsPTTActive(false);
                rtcManager?.broadcastPTT(false, activeTarget);
              }
            }}
            className={cn(
              "w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2 transition-all duration-200 shadow-2xl border-4",
              isPTTActive 
                ? "bg-red-500 border-red-400 scale-95 shadow-red-500/50" 
                : "bg-zinc-800 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 shadow-black/50"
            )}
          >
            <Mic className={cn("w-10 h-10", isPTTActive ? "text-white" : "text-zinc-400")} />
            <span className={cn("text-xs font-bold uppercase tracking-widest", isPTTActive ? "text-white" : "text-zinc-500")}>
              {isPTTActive ? 'Live' : 'PTT'}
            </span>
          </button>
          <p className="mt-6 text-sm text-zinc-500 font-medium tracking-wide">
            Hold <kbd className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono text-xs mx-1 shadow-sm">Spacebar</kbd> to talk
          </p>
        </div>
      </div>

      {/* Right Sidebar: Chat */}
      <div className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col">
        <div className="h-16 border-b border-zinc-800 flex items-center px-4 gap-2">
          <MessageSquare className="w-5 h-5 text-emerald-500" />
          <span className="font-semibold tracking-tight">
            {activeTarget === 'team' ? 'Team Chat' : users.get(activeTarget)?.name || 'Chat'}
          </span>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-2">
              <MessageSquare className="w-8 h-8 opacity-20" />
              <p className="text-sm">No messages yet</p>
            </div>
          ) : (
            activeMessages.map(msg => {
              const isMe = msg.senderId === socket?.id;
              return (
                <div key={msg.id} className={cn("flex flex-col", isMe ? "items-end" : "items-start")}>
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="text-xs font-medium text-zinc-400">{isMe ? 'You' : msg.senderName}</span>
                    <span className="text-[10px] text-zinc-600">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className={cn(
                    "px-3 py-2 rounded-lg text-sm max-w-[90%] break-words",
                    isMe ? "bg-emerald-600 text-white rounded-tr-none" : "bg-zinc-800 text-zinc-200 rounded-tl-none"
                  )}>
                    {msg.text}
                  </div>
                </div>
              );
            })
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-zinc-800 bg-zinc-950/50">
          <form onSubmit={sendMessage} className="relative">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Type a message..."
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-3 pr-10 py-2.5 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-all"
            />
            <button
              type="submit"
              disabled={!chatInput.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-zinc-400 hover:text-emerald-500 disabled:opacity-50 disabled:hover:text-zinc-400 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

