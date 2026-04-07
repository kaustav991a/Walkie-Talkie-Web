import { audioEngine } from './audio';
import { db } from '../firebase';
import { collection, addDoc, onSnapshot, query, where, serverTimestamp, orderBy } from 'firebase/firestore';

export class WebRTCManager {
  userId: string;
  localStream: MediaStream | null = null;
  peers: Map<string, RTCPeerConnection> = new Map();
  onUserTalking: (userId: string, isTalking: boolean, target: string) => void;
  unsubSignals: (() => void) | null = null;

  constructor(userId: string, onUserTalking: (userId: string, isTalking: boolean, target: string) => void) {
    this.userId = userId;
    this.onUserTalking = onUserTalking;
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
          } else if (data.type === 'answer') {
            const pc = this.peers.get(senderId);
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.data)));
            }
          } else if (data.type === 'candidate') {
            const pc = this.peers.get(senderId);
            if (pc) {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.data)));
              } catch (e) {
                console.error("Error adding received ice candidate", e);
              }
            }
          }
        }
      });
    });
  }

  private async sendSignal(receiverId: string, type: 'offer' | 'answer' | 'candidate', data: string) {
    try {
      await addDoc(collection(db, 'signals'), {
        senderId: this.userId,
        receiverId,
        type,
        data,
        timestamp: serverTimestamp()
      });
    } catch (e) {
      console.error("Error sending signal", e);
    }
  }

  public connectToPeer(targetUserId: string) {
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
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });

    this.peers.set(targetUserId, pc);

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
      audioEngine.removeStream(targetUserId);
    }
  }

  public disconnect() {
    if (this.unsubSignals) this.unsubSignals();
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
  }
}
