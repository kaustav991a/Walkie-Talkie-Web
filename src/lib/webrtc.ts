import { audioEngine } from './audio';
import { db } from '../firebase';
import { collection, addDoc, onSnapshot, query, where, orderBy } from 'firebase/firestore';

export class WebRTCManager {
  userId: string;
  sessionId: string;
  localStream: MediaStream | null = null;
  peers: Map<string, RTCPeerConnection> = new Map();
  peerSessionIds: Map<string, string> = new Map();
  pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  onUserTalking: (userId: string, isTalking: boolean, target: string) => void;
  onConnectionStateChange?: (userId: string, state: string) => void;
  unsubSignals: (() => void) | null = null;

  constructor(
    userId: string, 
    sessionId: string, 
    onUserTalking: (userId: string, isTalking: boolean, target: string) => void,
    onConnectionStateChange?: (userId: string, state: string) => void
  ) {
    this.userId = userId;
    this.sessionId = sessionId;
    this.onUserTalking = onUserTalking;
    this.onConnectionStateChange = onConnectionStateChange;
    this.setupSignaling();
  }

  async initializeLocalStream() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("getUserMedia is not supported in this browser.");
        return false;
      }
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.setLocalMicEnabled(false);
      return true;
    } catch (err) {
      console.error("Failed to get local stream", err);
      return false;
    }
  }

  setLocalMicEnabled(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = enabled;
      });
    }
  }

  private setupSignaling() {
    const q = query(
      collection(db, 'signals'),
      where('receiverId', '==', this.userId),
      orderBy('timestamp', 'asc')
    );

    this.unsubSignals = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          
          // Ignore signals meant for a previous session of ours!
          if (data.receiverSessionId && data.receiverSessionId !== this.sessionId) return;

          const senderId = data.senderId;
          
          if (data.type === 'offer') {
            let pc = this.peers.get(senderId);
            if (!pc) {
              pc = this.createPeerConnection(senderId);
            }
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.data)));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal(senderId, 'answer', JSON.stringify(answer));
            this.processPendingCandidates(senderId, pc);
          } else if (data.type === 'answer') {
            const pc = this.peers.get(senderId);
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.data)));
              this.processPendingCandidates(senderId, pc);
            }
          } else if (data.type === 'candidate') {
            const pc = this.peers.get(senderId);
            if (pc && pc.remoteDescription) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.data)));
              } catch (e) {
                console.error("Error adding received ice candidate", e);
              }
            } else {
              if (!this.pendingCandidates.has(senderId)) {
                this.pendingCandidates.set(senderId, []);
              }
              this.pendingCandidates.get(senderId)!.push(JSON.parse(data.data));
            }
          }
        }
      });
    });
  }

  private async processPendingCandidates(userId: string, pc: RTCPeerConnection) {
    const candidates = this.pendingCandidates.get(userId);
    if (candidates) {
      for (const candidate of candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("Error adding pending ice candidate", e);
        }
      }
      this.pendingCandidates.delete(userId);
    }
  }

  private async sendSignal(receiverId: string, type: 'offer' | 'answer' | 'candidate', data: string) {
    const receiverSessionId = this.peerSessionIds.get(receiverId);
    try {
      await addDoc(collection(db, 'signals'), {
        senderId: this.userId,
        receiverId,
        receiverSessionId: receiverSessionId || '',
        type,
        data,
        timestamp: Date.now() // Use Date.now() instead of serverTimestamp to avoid null sorting issues
      });
    } catch (e) {
      console.error("Error sending signal", e);
    }
  }

  public connectToPeer(targetUserId: string, targetSessionId: string) {
    this.peerSessionIds.set(targetUserId, targetSessionId);
    if (!this.peers.has(targetUserId)) {
      // Only the lexicographically smaller ID initiates the offer to avoid glare
      if (this.userId < targetUserId) {
        this.createPeerConnection(targetUserId, true);
      } else {
        this.createPeerConnection(targetUserId, false);
      }
    }
  }

  private createPeerConnection(targetUserId: string, isInitiator: boolean = false) {
    const pc = new RTCPeerConnection({
      iceServers: [
        // Google's public STUN servers (for normal NAT traversal)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Free public TURN server (OpenRelay by Metered) for strict firewalls / symmetric NATs
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
            'turns:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    });

    this.peers.set(targetUserId, pc);

    let checkingTimeout: any;

    pc.oniceconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(targetUserId, pc.iceConnectionState);
      }
      
      if (pc.iceConnectionState === 'checking') {
        // If stuck in checking for 15 seconds, force a reconnect
        checkingTimeout = setTimeout(() => {
          if (pc.iceConnectionState === 'checking') {
            console.log(`ICE connection stuck in checking with ${targetUserId}, forcing reconnect`);
            this.removePeerConnection(targetUserId);
            setTimeout(() => {
              const targetSessionId = this.peerSessionIds.get(targetUserId);
              if (targetSessionId) this.connectToPeer(targetUserId, targetSessionId);
            }, 1000);
          }
        }, 15000);
      } else {
        clearTimeout(checkingTimeout);
      }

      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        console.log(`ICE connection lost with ${targetUserId}`);
        this.removePeerConnection(targetUserId);
        
        // Auto-reconnect after a short delay to handle spotty corporate networks
        setTimeout(() => {
          const targetSessionId = this.peerSessionIds.get(targetUserId);
          if (targetSessionId) {
            console.log(`Attempting to auto-reconnect to ${targetUserId}`);
            this.connectToPeer(targetUserId, targetSessionId);
          }
        }, 2000);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(targetUserId, 'candidate', JSON.stringify(event.candidate));
      }
    };

    pc.ontrack = (event) => {
      audioEngine.addStream(targetUserId, event.streams[0], true);
    };

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream!);
      });
    }

    if (isInitiator) {
      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        this.sendSignal(targetUserId, 'offer', JSON.stringify(pc.localDescription));
      });
    }

    return pc;
  }

  public removePeerConnection(targetUserId: string) {
    const pc = this.peers.get(targetUserId);
    if (pc) {
      pc.close();
      this.peers.delete(targetUserId);
      this.pendingCandidates.delete(targetUserId);
      audioEngine.removeStream(targetUserId);
    }
  }

  public disconnect() {
    if (this.unsubSignals) this.unsubSignals();
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.pendingCandidates.clear();
  }
}
