import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Mic, MicOff, Users, User, Bell, Settings, Radio, Send, MessageSquare, SignalHigh, SignalMedium, SignalLow, SignalZero, Menu, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { WebRTCManager } from './lib/webrtc';
import { audioEngine } from './lib/audio';
import { cn } from './lib/utils';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { collection, doc, setDoc, onSnapshot, query, orderBy, addDoc, limit } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

interface UserState {
  id: string;
  name: string;
  isTalking: boolean;
  target: string;
  lastSeen?: number;
  sessionId?: string;
  peerId?: string;
}

interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  target: string;
}

export default function App() {
  const [rtcManager, setRtcManager] = useState<WebRTCManager | null>(null);
  const [joined, setJoined] = useState(false);
  const [username, setUsername] = useState('');
  const [userId, setUserId] = useState('');
  const [authError, setAuthError] = useState('');
  const [users, setUsers] = useState<Map<string, UserState>>(new Map());
  const [isPTTActive, setIsPTTActive] = useState(false);
  const [activeTarget, setActiveTarget] = useState<string>('team');
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    'Notification' in window && Notification.permission === 'granted'
  );
  const notificationsEnabledRef = useRef(notificationsEnabled);
  useEffect(() => {
    notificationsEnabledRef.current = notificationsEnabled;
  }, [notificationsEnabled]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [micError, setMicError] = useState<string>('');
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [forceRelay, setForceRelay] = useState(false);
  const [connectionStates, setConnectionStates] = useState<Record<string, string>>({});
  const [connectionQualities, setConnectionQualities] = useState<Record<string, 'excellent' | 'good' | 'poor' | 'unknown'>>({});
  const [mobileView, setMobileView] = useState<'channels' | 'ptt' | 'chat'>('ptt');
  const [sessionId] = useState(() => Math.random().toString(36).substring(2, 15));
  const [showSettings, setShowSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>('default');
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('default');
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (showSettings) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
        setAudioOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
      }).catch(err => console.error("Failed to enumerate devices", err));
    }
  }, [showSettings]);

  const handleMicChange = async (deviceId: string) => {
    setSelectedMic(deviceId);
    if (rtcManager) {
      await rtcManager.switchMicrophone(deviceId);
      if (rtcManager.localStream) {
        audioEngine.setLocalStream(rtcManager.localStream);
      }
    }
  };

  const handleSpeakerChange = async (deviceId: string) => {
    setSelectedSpeaker(deviceId);
    await audioEngine.setOutputDevice(deviceId);
  };

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(err => console.error('SW registration failed:', err));
    }
  }, []);
  const requestRef = useRef<number>();

  useEffect(() => {
    const handleInteraction = () => {
      if (!hasInteracted) {
        setHasInteracted(true);
        audioEngine.init();
        audioEngine.resume();
      }
    };
    window.addEventListener('click', handleInteraction);
    window.addEventListener('keydown', handleInteraction);
    return () => {
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [hasInteracted]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
        setUsername(user.displayName || 'Anonymous');
        setJoined(true);
      } else {
        setJoined(false);
        setUserId('');
        setUsername('');
      }
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setAuthError('');
    try {
      audioEngine.init();
      audioEngine.resume();
      
      await signInWithGoogle();
      
      if ('Notification' in window && Notification.permission === 'default') {
        const perm = await Notification.requestPermission();
        setNotificationsEnabled(perm === 'granted');
      }
    } catch (e: any) {
      console.error("Auth error:", e);
      setAuthError(e.message || 'Authentication failed');
    }
  };

  const handleLogout = async () => {
    if (rtcManager) {
      rtcManager.disconnect();
    }
    await logout();
  };

  // Initialize WebRTC and Firestore Listeners
  useEffect(() => {
    if (!joined || !userId || !username || !isAuthReady) return;

    let unsubUsers: (() => void) | undefined;
    let unsubMessages: (() => void) | undefined;
    let presenceInterval: any;

    const manager = new WebRTCManager(
      userId, 
      forceRelay, 
      async (peerId) => {
        // Update Firestore with our peerId
        const userRef = doc(db, 'users', userId);
        await setDoc(userRef, { peerId }, { merge: true });
      },
      (uid, state) => {
        setConnectionStates(prev => ({ ...prev, [uid]: state }));
      },
      (uid, quality) => {
        setConnectionQualities(prev => ({ ...prev, [uid]: quality }));
      }
    );
    setRtcManager(manager);

    const init = async () => {
      // 1. Initialize Microphone FIRST
      const micGranted = await manager.initializeLocalStream(selectedMic === 'default' ? undefined : selectedMic);
      if (micGranted && manager.localStream) {
        audioEngine.init();
        audioEngine.setLocalStream(manager.localStream);
      } else {
        setMicError("Microphone access denied. You can still use text chat.");
      }
      
      manager.startSignaling();

      // 2. Update own presence
      const userRef = doc(db, 'users', userId);
      await setDoc(userRef, {
        uid: userId,
        username,
        isTalking: false,
        target: 'team',
        lastSeen: Date.now(),
        sessionId
      }, { merge: true });

      presenceInterval = setInterval(() => {
        setDoc(userRef, { lastSeen: Date.now(), sessionId }, { merge: true });
      }, 30000);

      // 3. Listen to Users (Now that we have the mic, we can safely connect to peers)
      unsubUsers = onSnapshot(collection(db, 'users'), (snapshot) => {
        setUsers(prev => {
          const newMap = new Map(prev);
          
          // First pass: determine if we are currently receiving a private transmission
          let isReceivingPrivate = false;
          snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (data.uid !== userId && data.isTalking && data.target === userId) {
              isReceivingPrivate = true;
            }
          });

          snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (data.uid === userId) return; // Skip self
            
            // Clean up stale users (not seen in 2 mins)
            if (Date.now() - (data.lastSeen || 0) > 120000) {
              newMap.delete(data.uid);
              manager.removePeerConnection(data.uid);
              return;
            }

            const isTalking = data.isTalking || false;
            const target = data.target || 'team';
            const prevUser = prev.get(data.uid);
            
            // If user reconnected with a new session, drop the old connection
            if (prevUser && prevUser.sessionId && prevUser.sessionId !== data.sessionId) {
              manager.removePeerConnection(data.uid);
            }

            newMap.set(data.uid, {
              id: data.uid,
              name: data.username,
              isTalking,
              target,
              lastSeen: data.lastSeen,
              sessionId: data.sessionId,
              peerId: data.peerId
            });

            const isTeamStream = target === 'team';
            
            // PRIORITY OVERRIDE LOGIC:
            // We hear the stream if:
            // 1. It is a private transmission directed at us.
            // 2. It is a global transmission AND we are NOT currently receiving a private transmission.
            const shouldHear = isTalking && (
              target === userId || 
              (target === 'team' && !isReceivingPrivate)
            );

            // Update Audio Engine
            audioEngine.setStreamActive(data.uid, shouldHear, isTeamStream);

            // Desktop Notification Logic for Voice (Removed document.hidden so it's easier to test)
            if (isTalking && (!prevUser || !prevUser.isTalking) && shouldHear) {
              if (notificationsEnabledRef.current) {
                if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                  navigator.serviceWorker.ready.then(reg => {
                    reg.showNotification(`Incoming Transmission`, {
                      body: `${data.username} is speaking on ${target === 'team' ? 'Team Channel' : 'Private Channel'}`,
                      icon: '/favicon.ico'
                    });
                  });
                } else {
                  new Notification(`Incoming Transmission`, {
                    body: `${data.username} is speaking on ${target === 'team' ? 'Team Channel' : 'Private Channel'}`,
                    icon: '/favicon.ico'
                  });
                }
              }
            }
          });

          return newMap;
        });
      }, (error) => {
        console.error("Users onSnapshot error:", error);
      });

      // 4. Listen to Messages
      const qMessages = query(collection(db, 'messages'), orderBy('timestamp', 'desc'), limit(50));
      unsubMessages = onSnapshot(qMessages, (snapshot) => {
        const msgs: ChatMessage[] = [];
        snapshot.docs.forEach(docSnap => {
          const data = docSnap.data();
          msgs.push({
            id: docSnap.id,
            senderId: data.senderId,
            senderName: data.senderName,
            text: data.text,
            timestamp: data.timestamp,
            target: data.target
          });
        });
        msgs.reverse(); // Oldest first
        
        setMessages(prev => {
          // Check for new messages for notifications (Removed document.hidden so it's easier to test)
          if (notificationsEnabledRef.current && msgs.length > prev.length && prev.length > 0) {
            const newMsg = msgs[msgs.length - 1];
            if (newMsg.senderId !== userId) {
              if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(reg => {
                  reg.showNotification(`Message from ${newMsg.senderName}`, {
                    body: newMsg.text,
                    icon: '/favicon.ico'
                  });
                });
              } else {
                new Notification(`Message from ${newMsg.senderName}`, {
                  body: newMsg.text,
                  icon: '/favicon.ico'
                });
              }
            }
          }
          return msgs;
        });
      }, (error) => {
        console.error("Messages onSnapshot error:", error);
      });
    };

    init();

    return () => {
      if (presenceInterval) clearInterval(presenceInterval);
      if (unsubUsers) unsubUsers();
      if (unsubMessages) unsubMessages();
      manager.disconnect();
      setRtcManager(null);
      cancelAnimationFrame(requestRef.current!);
    };
  }, [joined, userId, username, isAuthReady, forceRelay]); // Added forceRelay to dependencies

  // Auto-connect to new peers
  useEffect(() => {
    if (!rtcManager || !userId) return;
    
    users.forEach((user) => {
      if (user.id !== userId && user.peerId && userId < user.id) {
        rtcManager.connectToPeer(user.id, user.peerId);
      }
    });
  }, [users, rtcManager, userId]);

  // Global Hotkey (Spacebar) for PTT
  useEffect(() => {
    if (!rtcManager || !joined) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body) {
        e.preventDefault();
        setIsPTTActive(true);
        audioEngine.unlockAll();
        audioEngine.setLocalMicActive(true);
        rtcManager.setLocalMicEnabled(true);
        setDoc(doc(db, 'users', userId), { isTalking: true, target: activeTarget }, { merge: true });
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && e.target === document.body) {
        e.preventDefault();
        setIsPTTActive(false);
        audioEngine.setLocalMicActive(false);
        rtcManager.setLocalMicEnabled(false);
        setDoc(doc(db, 'users', userId), { isTalking: false, target: activeTarget }, { merge: true });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [rtcManager, activeTarget, joined, userId]);

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

    const isAnyoneTalking = Array.from(users.values()).some(u => u.isTalking) || isPTTActive;
    
    // Draw Frequency Bars
    const barCount = 64; // Number of bars
    const barWidth = (width / barCount) - 2;
    let x = 0;
    
    // We only use the lower half of the frequencies as they contain most voice data
    const step = Math.floor((dataArray.length / 2) / barCount);

    for (let i = 0; i < barCount; i++) {
      // Average the frequency data for this bar
      let sum = 0;
      for (let j = 0; j < step; j++) {
        sum += dataArray[(i * step) + j];
      }
      const average = sum / step;
      
      // Normalize to height (average is 0-255)
      const barHeight = (average / 255) * height * 0.8; // Max 80% height
      
      // Minimum bar height so it looks good when silent
      const finalHeight = Math.max(barHeight, 4);

      // Color gradient based on state
      if (isPTTActive) {
        ctx.fillStyle = `rgba(239, 68, 68, ${Math.max(0.3, average / 255)})`; // Red
        ctx.shadowColor = '#ef4444';
      } else if (isAnyoneTalking) {
        ctx.fillStyle = `rgba(16, 185, 129, ${Math.max(0.3, average / 255)})`; // Emerald
        ctx.shadowColor = '#10b981';
      } else {
        ctx.fillStyle = 'rgba(63, 63, 70, 0.5)'; // Zinc-700
        ctx.shadowColor = 'transparent';
      }
      
      ctx.shadowBlur = (isAnyoneTalking || isPTTActive) ? 10 : 0;

      // Draw rounded bar (centered vertically)
      const y = (height - finalHeight) / 2;
      
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, finalHeight, barWidth / 2);
      ctx.fill();

      x += barWidth + 2;
    }

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

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !userId) return;
    
    try {
      await addDoc(collection(db, 'messages'), {
        senderId: userId,
        senderName: username,
        text: chatInput.trim(),
        target: activeTarget,
        timestamp: Date.now()
      });
      setChatInput('');
    } catch (err) {
      console.error("Error sending message", err);
    }
  };

  const activeMessages = messages.filter(m => 
    m.target === 'team' ? activeTarget === 'team' : 
    (m.target === activeTarget && m.senderId === userId) || 
    (m.senderId === activeTarget && m.target === userId)
  );

  const isReceivingPrivate = Array.from(users.values()).some(u => u.isTalking && u.target === userId);

  if (!isAuthReady) {
    return <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-500">Loading...</div>;
  }

  if (!joined) {
    return (
      <div className="h-screen bg-zinc-950 flex items-center justify-center text-zinc-100 font-sans">
        <div className="bg-zinc-900 p-8 rounded-2xl border border-zinc-800 shadow-2xl w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-full flex items-center justify-center">
              <Radio className="w-8 h-8 text-emerald-500" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold text-center mb-2">Walkie-Talkie</h1>
          <p className="text-zinc-400 text-center mb-6 text-sm">Log in with Google to join the frequency.</p>
          
          {authError && (
            <div className="bg-red-500/10 text-red-500 text-sm p-3 rounded-lg mb-4 text-center border border-red-500/20">
              {authError}
            </div>
          )}

          <button
            onClick={handleLogin}
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <User className="w-5 h-5" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] bg-zinc-950 text-zinc-100 font-sans flex overflow-hidden relative w-full">
      
      {/* Audio Unlock Overlay */}
      {!hasInteracted && (
        <div className="absolute inset-0 z-[60] bg-zinc-950/90 backdrop-blur-md flex items-center justify-center cursor-pointer">
          <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-2xl text-center max-w-[85%] animate-pulse">
            <Radio className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Tap to connect</h2>
            <p className="text-zinc-400 text-sm">Browser policies require interaction before audio can be played.</p>
          </div>
        </div>
      )}

      {/* CHANNELS SIDEBAR */}
      <div className={cn(
        "bg-zinc-950 md:bg-zinc-900 flex flex-col z-20",
        "absolute inset-0 pb-[72px] md:pb-0 md:relative md:inset-auto md:w-64 md:border-r md:border-zinc-800 shrink-0",
        mobileView === 'channels' ? "opacity-100" : "opacity-0 pointer-events-none md:opacity-100 md:pointer-events-auto"
      )}>
        <div className="h-14 md:h-16 border-b border-zinc-800/50 md:border-zinc-800 flex items-center px-4 justify-between shrink-0 bg-zinc-900/50 md:bg-transparent backdrop-blur-md md:backdrop-blur-none">
          <div className="flex items-center gap-2">
            <Radio className="w-5 h-5 text-emerald-500" />
            <span className="font-semibold tracking-tight">Channels</span>
          </div>
          <div className="flex items-center gap-1">
            <button 
              onClick={requestNotifications}
              className={cn("p-1.5 rounded-md transition-colors", notificationsEnabled ? "text-emerald-500 bg-emerald-500/10" : "text-zinc-500 hover:bg-zinc-800")}
            >
              <Bell className="w-4 h-4 md:w-5 md:h-5" />
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className="md:hidden p-1.5 text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1 md:space-y-2">
            <button
              onClick={() => { setActiveTarget('team'); setMobileView('ptt'); }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all border",
                activeTarget === 'team' ? "bg-zinc-800 border-zinc-700 text-white" : "bg-zinc-900/50 border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              )}
            >
              <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700 shrink-0">
                <Users className="w-5 h-5" />
              </div>
              <div className="flex-1 text-left">
                <div className="font-semibold text-base text-zinc-100">Team Global</div>
                <div className="text-sm text-zinc-500">
                  {isReceivingPrivate ? (
                    <span className="text-orange-500">Muted (Priority Override)</span>
                  ) : Array.from(users.values()).some(u => u.isTalking && u.target === 'team') ? (
                    <span className="text-emerald-500 animate-pulse">Receiving transmission...</span>
                  ) : (
                    `${users.size + 1} online`
                  )}
                </div>
              </div>
            </button>

            <div className="pt-4 pb-2 px-4 text-xs font-bold text-zinc-500 uppercase tracking-wider">
              Direct Channels
            </div>

            {Array.from(users.values()).map(user => (
              <button
                key={user.id}
                onClick={() => { setActiveTarget(user.id); setMobileView('ptt'); }}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all border",
                  activeTarget === user.id ? "bg-zinc-800 border-zinc-700 text-white" : "bg-zinc-900/50 border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                )}
              >
                <div className="relative shrink-0">
                  <div className="w-10 h-10 rounded-full bg-zinc-800 flex items-center justify-center border border-zinc-700">
                    <User className="w-5 h-5" />
                  </div>
                  <div className={cn(
                    "absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-zinc-900 transition-colors",
                    user.isTalking 
                      ? (user.target === 'team' || user.target === userId ? "bg-emerald-500 animate-pulse" : "bg-orange-500") 
                      : "bg-zinc-500"
                  )} />
                </div>
                <div className="flex-1 text-left truncate">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-base text-zinc-100 truncate">{user.name}</span>
                    <div className="flex items-center gap-2">
                      {connectionStates[user.id] === 'connected' && (
                        <div className="text-zinc-500">
                          {connectionQualities[user.id] === 'excellent' && <SignalHigh className="w-4 h-4 text-emerald-500" />}
                          {connectionQualities[user.id] === 'good' && <SignalMedium className="w-4 h-4 text-yellow-500" />}
                          {connectionQualities[user.id] === 'poor' && <SignalLow className="w-4 h-4 text-orange-500" />}
                          {(!connectionQualities[user.id] || connectionQualities[user.id] === 'unknown') && <SignalZero className="w-4 h-4 text-zinc-600" />}
                        </div>
                      )}
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          if (rtcManager && user.peerId) {
                            rtcManager.removePeerConnection(user.id);
                            setTimeout(() => rtcManager.connectToPeer(user.id, user.peerId!), 500);
                          }
                        }}
                        className={cn(
                          "w-2.5 h-2.5 rounded-full cursor-pointer hover:scale-150 transition-transform",
                          connectionStates[user.id] === 'connected' ? "bg-emerald-500" :
                          connectionStates[user.id] === 'connecting' ? "bg-yellow-500 animate-pulse" :
                          connectionStates[user.id] === 'disconnected' ? "bg-red-500" :
                          connectionStates[user.id] === 'failed' ? "bg-red-600" : "bg-zinc-600"
                        )} 
                        title={`Connection: ${connectionStates[user.id] || 'connecting'}. Click to force reconnect.`} 
                      />
                    </div>
                  </div>
                  <div className="text-sm text-zinc-500 truncate">
                    {user.isTalking 
                      ? (user.target === 'team' ? 'Transmitting (Global)' : 
                         user.target === userId ? 'Transmitting (Private)' : 'Busy') 
                      : 'Idle'}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop User Profile (Bottom) */}
          <div className="hidden md:flex p-4 border-t border-zinc-800 bg-zinc-900/50 items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
              <span className="text-emerald-500 font-medium text-sm">{username.charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 truncate">
              <div className="font-medium text-sm text-zinc-200 truncate">{username}</div>
              <div className="text-xs text-emerald-500 cursor-pointer hover:underline" onClick={handleLogout}>Logout</div>
            </div>
          </div>
        </div>

        {/* MAIN PTT AREA */}
        <div className={cn(
          "bg-zinc-950 flex flex-col z-10",
          "absolute inset-0 pb-[72px] md:pb-0 md:relative md:inset-auto md:flex-1 min-w-0"
        )}>
          <div className="h-14 md:h-16 border-b border-zinc-800/50 md:border-zinc-800 flex items-center px-4 md:px-6 justify-between shrink-0 bg-zinc-900/50 md:bg-zinc-950/50 backdrop-blur-md z-20">
            <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="font-semibold md:font-medium text-zinc-100 md:text-zinc-200 truncate text-base">
                {activeTarget === 'team' ? 'Team Global' : users.get(activeTarget)?.name}
                <span className="hidden md:inline">{activeTarget === 'team' ? ' Frequency' : ''}</span>
              </span>
              {micError && (
                <span className="ml-2 md:ml-4 text-[10px] md:text-xs font-medium text-red-400 bg-red-400/10 px-2 py-0.5 md:py-1 rounded border border-red-400/20 shrink-0 truncate">
                  {micError}
                </span>
              )}
            </div>
            
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <button
                onClick={() => setForceRelay(!forceRelay)}
                className={cn(
                  "hidden md:block px-3 py-1 rounded text-xs font-medium border transition-colors",
                  forceRelay 
                    ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" 
                    : "bg-zinc-800 text-zinc-400 border-zinc-700 hover:bg-zinc-700"
                )}
                title="Forces audio through a secure relay server. Use this if you are on a strict corporate network and connections are failing."
              >
                {forceRelay ? 'Corporate Firewall Mode: ON' : 'Corporate Firewall Mode: OFF'}
              </button>

              <button 
                onClick={() => setShowSettings(true)}
                className="hidden md:block p-2 text-zinc-400 hover:text-white transition-colors"
              >
                <Settings className="w-5 h-5" />
              </button>

              <button 
                onClick={() => setMobileView(mobileView === 'chat' ? 'ptt' : 'chat')} 
                className="hidden md:block p-2 -mr-2 text-zinc-400 hover:text-white relative shrink-0"
              >
                <MessageSquare className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Status Indicator */}
          <div className="flex justify-center pt-6">
            <div className={cn(
              "px-4 py-2 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-colors border shadow-lg",
              isPTTActive 
                ? "bg-red-500/20 text-red-500 border-red-500/30 shadow-red-500/10" 
                : Array.from(users.values()).some(u => u.isTalking)
                  ? "bg-emerald-500/20 text-emerald-500 border-emerald-500/30 shadow-emerald-500/10"
                  : "bg-zinc-800/80 text-zinc-400 border-zinc-700/50"
            )}>
              {isPTTActive ? (
                <><Mic className="w-4 h-4" /> Transmitting</>
              ) : Array.from(users.values()).some(u => u.isTalking) ? (
                <><Radio className="w-4 h-4" /> Receiving</>
              ) : (
                <><MicOff className="w-4 h-4" /> Standby</>
              )}
            </div>
          </div>

          {/* Central Waveform Visualization */}
          <div className="flex-1 flex items-center justify-center relative overflow-hidden">
            <div className={cn(
              "absolute inset-0 opacity-30 transition-opacity duration-500 blur-[80px]",
              isPTTActive ? "bg-red-500" : Array.from(users.values()).some(u => u.isTalking) ? "bg-emerald-500" : "bg-transparent"
            )} />
            
            <canvas 
              ref={canvasRef}
              width={400}
              height={300}
              className="w-full h-48 z-10"
            />
          </div>

          {/* Bottom Controls */}
          <div className="p-8 flex flex-col items-center justify-center bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent z-10 pb-12">
            <button
              onMouseDown={() => {
                setIsPTTActive(true);
                audioEngine.unlockAll();
                audioEngine.setLocalMicActive(true);
                rtcManager?.setLocalMicEnabled(true);
                setDoc(doc(db, 'users', userId), { isTalking: true, target: activeTarget }, { merge: true });
              }}
              onMouseUp={() => {
                setIsPTTActive(false);
                audioEngine.setLocalMicActive(false);
                rtcManager?.setLocalMicEnabled(false);
                setDoc(doc(db, 'users', userId), { isTalking: false, target: activeTarget }, { merge: true });
              }}
              onMouseLeave={() => {
                if (isPTTActive) {
                  setIsPTTActive(false);
                  audioEngine.setLocalMicActive(false);
                  rtcManager?.setLocalMicEnabled(false);
                  setDoc(doc(db, 'users', userId), { isTalking: false, target: activeTarget }, { merge: true });
                }
              }}
              onTouchStart={(e) => {
                e.preventDefault();
                setIsPTTActive(true);
                audioEngine.unlockAll();
                audioEngine.setLocalMicActive(true);
                rtcManager?.setLocalMicEnabled(true);
                setDoc(doc(db, 'users', userId), { isTalking: true, target: activeTarget }, { merge: true });
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                setIsPTTActive(false);
                audioEngine.setLocalMicActive(false);
                rtcManager?.setLocalMicEnabled(false);
                setDoc(doc(db, 'users', userId), { isTalking: false, target: activeTarget }, { merge: true });
              }}
              onTouchCancel={() => {
                setIsPTTActive(false);
                audioEngine.setLocalMicActive(false);
                rtcManager?.setLocalMicEnabled(false);
                setDoc(doc(db, 'users', userId), { isTalking: false, target: activeTarget }, { merge: true });
              }}
              className={cn(
                "w-40 h-40 rounded-full flex flex-col items-center justify-center gap-3 transition-all duration-200 shadow-2xl border-[6px] select-none touch-none",
                isPTTActive 
                  ? "bg-red-500 border-red-400 scale-95 shadow-red-500/50" 
                  : "bg-zinc-800 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 shadow-black/80"
              )}
            >
              <Mic className={cn("w-14 h-14", isPTTActive ? "text-white" : "text-zinc-400")} />
              <span className={cn("text-sm font-bold uppercase tracking-widest", isPTTActive ? "text-white" : "text-zinc-500")}>
                {isPTTActive ? 'Live' : 'PTT'}
              </span>
            </button>
            <p className="mt-6 md:mt-8 text-sm text-zinc-500 font-medium tracking-wide text-center">
              Hold <kbd className="hidden md:inline-block px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono text-xs mx-1 shadow-sm">Spacebar</kbd> <span className="md:hidden">to talk</span>
            </p>
          </div>
        </div>

        {/* CHAT SIDEBAR */}
        <div className={cn(
          "bg-zinc-950 md:bg-zinc-900 flex flex-col z-40",
          "absolute inset-0 pb-[72px] md:pb-0 md:left-auto md:right-0 md:w-80 md:h-full md:border-l md:border-zinc-800 shrink-0",
          mobileView === 'chat' ? "opacity-100 md:shadow-2xl md:pointer-events-auto" : "opacity-0 pointer-events-none"
        )}>
          <div className="h-14 md:h-16 border-b border-zinc-800/50 md:border-zinc-800 flex items-center px-4 justify-between shrink-0 bg-zinc-900/50 md:bg-transparent backdrop-blur-md md:backdrop-blur-none">
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquare className="w-5 h-5 text-emerald-500 shrink-0" />
              <span className="font-semibold tracking-tight truncate">
                {activeTarget === 'team' ? 'Team Chat' : users.get(activeTarget)?.name || 'Chat'}
              </span>
            </div>
            <button 
              onClick={() => setMobileView('ptt')}
              className="hidden md:block p-1.5 text-zinc-400 hover:text-white rounded-md hover:bg-zinc-800 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {activeMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-zinc-500 space-y-3">
                <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center">
                  <MessageSquare className="w-8 h-8 opacity-50" />
                </div>
                <p className="text-sm font-medium">No messages yet</p>
              </div>
            ) : (
              activeMessages.map(msg => {
                const isMe = msg.senderId === userId;
                return (
                  <div key={msg.id} className={cn("flex flex-col", isMe ? "items-end" : "items-start")}>
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-xs font-medium text-zinc-400">{isMe ? 'You' : msg.senderName}</span>
                      <span className="text-[10px] text-zinc-600">
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className={cn(
                      "px-4 py-2.5 rounded-2xl text-sm max-w-[85%] break-words shadow-sm",
                      isMe ? "bg-emerald-600 text-white rounded-tr-sm" : "bg-zinc-800 text-zinc-100 rounded-tl-sm border border-zinc-700/50"
                    )}>
                      {msg.text}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 border-t border-zinc-800/50 bg-zinc-900/50 backdrop-blur-md">
            <form onSubmit={sendMessage} className="relative flex items-center gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 bg-zinc-950 border border-zinc-700 rounded-full pl-4 pr-12 py-3 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500 transition-colors shadow-inner"
              />
              <button
                type="submit"
                disabled={!chatInput.trim()}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-emerald-600 text-white disabled:opacity-50 disabled:bg-zinc-800 disabled:text-zinc-500 transition-all"
              >
                <Send className="w-4 h-4 ml-0.5" />
              </button>
            </form>
          </div>
        </div>

      {/* MOBILE BOTTOM NAV */}
      <div className="md:hidden h-[72px] border-t border-zinc-800/80 bg-zinc-900/90 backdrop-blur-xl flex items-center justify-around px-2 shrink-0 pb-safe z-40 absolute bottom-0 left-0 right-0">
        <button 
          onClick={() => setMobileView('channels')}
          className={cn(
            "flex flex-col items-center justify-center w-20 h-full gap-1 transition-colors",
            mobileView === 'channels' ? "text-emerald-500" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <Radio className="w-6 h-6" />
          <span className="text-[10px] font-semibold tracking-wide">Channels</span>
        </button>
        
        <button 
          onClick={() => setMobileView('ptt')}
          className={cn(
            "flex flex-col items-center justify-center w-20 h-full gap-1 transition-colors",
            mobileView === 'ptt' ? "text-emerald-500" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center transition-all",
            mobileView === 'ptt' ? "bg-emerald-500/20" : "bg-transparent"
          )}>
            <Mic className="w-6 h-6" />
          </div>
          <span className="text-[10px] font-semibold tracking-wide">Talk</span>
        </button>

        <button 
          onClick={() => setMobileView('chat')}
          className={cn(
            "flex flex-col items-center justify-center w-20 h-full gap-1 transition-colors relative",
            mobileView === 'chat' ? "text-emerald-500" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <MessageSquare className="w-6 h-6" />
          <span className="text-[10px] font-semibold tracking-wide">Chat</span>
        </button>
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Settings className="w-5 h-5 text-emerald-500" />
                Settings
              </h2>
              <button onClick={() => setShowSettings(false)} className="text-zinc-400 hover:text-white p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-6">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">Microphone (Input)</label>
                <select 
                  value={selectedMic}
                  onChange={(e) => handleMicChange(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500"
                >
                  <option value="default">System Default</option>
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${device.deviceId.substring(0, 5)}...`}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500 mt-2">
                  Selecting your Bluetooth headset here will usually force the audio output to route to it as well on mobile devices.
                </p>
              </div>

              {audioOutputDevices.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-2">Speaker (Output)</label>
                  <select 
                    value={selectedSpeaker}
                    onChange={(e) => handleSpeakerChange(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="default">System Default</option>
                    {audioOutputDevices.map(device => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Speaker ${device.deviceId.substring(0, 5)}...`}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-zinc-500 mt-2">
                    Note: Direct speaker selection is not supported on all mobile browsers (like iOS Safari).
                  </p>
                </div>
              )}
              
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">Network Settings</label>
                <label className="flex items-center gap-3 p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50 cursor-pointer hover:bg-zinc-800 transition-colors">
                  <input 
                    type="checkbox" 
                    checked={forceRelay}
                    onChange={(e) => setForceRelay(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-600 text-emerald-500 focus:ring-emerald-500/20 bg-zinc-900"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-zinc-200">Corporate Firewall Mode</div>
                    <div className="text-xs text-zinc-500 mt-0.5">Force audio through secure relay servers (TURN). Use if connections fail.</div>
                  </div>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

