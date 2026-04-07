import { type Socket } from 'socket.io-client';
import { audioEngine } from './audio';

export class WebRTCManager {
  socket: Socket;
  localStream: MediaStream | null = null;
  peers: Map<string, RTCPeerConnection> = new Map(); // Keyed by userId now
  userToSocket: Map<string, string> = new Map(); // userId -> socketId
  onUserTalking: (userId: string, isTalking: boolean, target: string) => void;

  constructor(socket: Socket, onUserTalking: (userId: string, isTalking: boolean, target: string) => void) {
    this.socket = socket;
    this.onUserTalking = onUserTalking;
    this.setupSocketListeners();
  }

  async initializeLocalStream() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("getUserMedia is not supported in this browser.");
        return false;
      }
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
      users.forEach(user => {
        this.userToSocket.set(user.id, user.socketId);
        this.createPeerConnection(user.id, user.socketId, true);
      });
    });

    this.socket.on('user-joined', (user: any) => {
      this.userToSocket.set(user.id, user.socketId);
      this.createPeerConnection(user.id, user.socketId, false);
    });

    this.socket.on('user-left', (userId: string) => {
      this.removePeerConnection(userId);
      this.userToSocket.delete(userId);
    });

    this.socket.on('offer', async (data: any) => {
      let pc = this.peers.get(data.callerId);
      if (!pc) {
        this.userToSocket.set(data.callerId, data.callerSocket);
        pc = this.createPeerConnection(data.callerId, data.callerSocket, false);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('answer', { targetSocket: data.callerSocket, sdp: answer });
    });

    this.socket.on('answer', async (data: any) => {
      // Find peer by socketId
      let targetUserId = null;
      for (const [userId, socketId] of this.userToSocket.entries()) {
        if (socketId === data.calleeSocket) {
          targetUserId = userId;
          break;
        }
      }
      if (targetUserId) {
        const pc = this.peers.get(targetUserId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
      }
    });

    this.socket.on('ice-candidate', async (data: any) => {
      let targetUserId = null;
      for (const [userId, socketId] of this.userToSocket.entries()) {
        if (socketId === data.senderSocket) {
          targetUserId = userId;
          break;
        }
      }
      if (targetUserId) {
        const pc = this.peers.get(targetUserId);
        if (pc) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } catch (e) {
            console.error("Error adding received ice candidate", e);
          }
        }
      }
    });

    this.socket.on('ptt-status', (data: any) => {
      this.onUserTalking(data.userId, data.isTalking, data.target);
    });
  }

  private createPeerConnection(targetUserId: string, targetSocketId: string, isInitiator: boolean) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ]
    });

    this.peers.set(targetUserId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', { targetSocket: targetSocketId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      // Route incoming audio to our Web Audio API Engine
      audioEngine.addStream(targetUserId, event.streams[0], true); // Default to team channel
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
        this.socket.emit('offer', { targetSocket: targetSocketId, sdp: pc.localDescription });
      });
    }

    return pc;
  }

  private removePeerConnection(targetUserId: string) {
    const pc = this.peers.get(targetUserId);
    if (pc) {
      pc.close();
      this.peers.delete(targetUserId);
      audioEngine.removeStream(targetUserId);
    }
  }

  broadcastPTT(isTalking: boolean, target: string = 'team') {
    this.setLocalMicEnabled(isTalking);
    this.socket.emit('ptt-status', { isTalking, target });
  }
}
