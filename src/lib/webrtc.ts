import { type Socket } from 'socket.io-client';
import { audioEngine } from './audio';

export class WebRTCManager {
  socket: Socket;
  localStream: MediaStream | null = null;
  peers: Map<string, RTCPeerConnection> = new Map();
  onUserTalking: (userId: string, isTalking: boolean, target: string) => void;

  constructor(socket: Socket, onUserTalking: (userId: string, isTalking: boolean, target: string) => void) {
    this.socket = socket;
    this.onUserTalking = onUserTalking;
    this.setupSocketListeners();
  }

  async initializeLocalStream() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // Start muted
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

  private setupSocketListeners() {
    this.socket.on('existing-users', (users: any[]) => {
      users.forEach(user => this.createPeerConnection(user.id, true));
    });

    this.socket.on('user-joined', (user: any) => {
      this.createPeerConnection(user.id, false);
    });

    this.socket.on('user-left', (userId: string) => {
      this.removePeerConnection(userId);
    });

    this.socket.on('offer', async (data: any) => {
      let pc = this.peers.get(data.caller);
      if (!pc) {
        pc = this.createPeerConnection(data.caller, false);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('answer', { target: data.caller, sdp: answer });
    });

    this.socket.on('answer', async (data: any) => {
      const pc = this.peers.get(data.callee);
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      }
    });

    this.socket.on('ice-candidate', async (data: any) => {
      const pc = this.peers.get(data.sender);
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
          console.error("Error adding received ice candidate", e);
        }
      }
    });

    this.socket.on('ptt-status', (data: any) => {
      this.onUserTalking(data.userId, data.isTalking, data.target);
    });
  }

  private createPeerConnection(targetId: string, isInitiator: boolean) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });

    this.peers.set(targetId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', { target: targetId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      // Route incoming audio to our Web Audio API Engine
      audioEngine.addStream(targetId, event.streams[0], true); // Default to team channel
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
        this.socket.emit('offer', { target: targetId, sdp: pc.localDescription });
      });
    }

    return pc;
  }

  private removePeerConnection(targetId: string) {
    const pc = this.peers.get(targetId);
    if (pc) {
      pc.close();
      this.peers.delete(targetId);
      audioEngine.removeStream(targetId);
    }
  }

  broadcastPTT(isTalking: boolean, target: string = 'team') {
    this.setLocalMicEnabled(isTalking);
    this.socket.emit('ptt-status', { isTalking, target });
  }
}
