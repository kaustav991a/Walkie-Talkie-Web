import { Peer, MediaConnection } from 'peerjs';
import { audioEngine } from './audio';

export class WebRTCManager {
  userId: string;
  forceRelay: boolean;
  localStream: MediaStream | null = null;
  peer: Peer | null = null;
  calls: Map<string, MediaConnection> = new Map();
  
  onPeerId: (peerId: string) => void;
  onConnectionStateChange?: (userId: string, state: string) => void;

  constructor(
    userId: string,
    forceRelay: boolean,
    onPeerId: (peerId: string) => void,
    onConnectionStateChange?: (userId: string, state: string) => void
  ) {
    this.userId = userId;
    this.forceRelay = forceRelay;
    this.onPeerId = onPeerId;
    this.onConnectionStateChange = onConnectionStateChange;
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

  public startSignaling() {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:openrelay.metered.ca:80' },
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
    ];

    this.peer = new Peer({
      config: {
        iceTransportPolicy: this.forceRelay ? 'relay' : 'all',
        iceServers: iceServers
      },
      debug: 2
    });

    this.peer.on('open', (id) => {
      console.log('Connected to PeerJS server. My Peer ID:', id);
      this.onPeerId(id);
    });

    this.peer.on('call', (call) => {
      const callerId = call.metadata?.callerId;
      if (!callerId) {
        console.warn("Incoming call missing callerId metadata, rejecting.");
        call.close();
        return;
      }
      
      console.log(`Receiving call from ${callerId}`);
      
      if (this.localStream) {
        call.answer(this.localStream);
      } else {
        call.answer();
      }
      
      this.handleCall(call, callerId);
    });

    this.peer.on('error', (err) => {
      console.error('PeerJS Error:', err);
    });
  }

  public connectToPeer(targetUserId: string, targetPeerId: string) {
    if (!this.peer || !this.localStream) return;
    if (this.calls.has(targetUserId)) return;

    console.log(`Initiating call to ${targetUserId} (${targetPeerId})`);
    
    const call = this.peer.call(targetPeerId, this.localStream, {
      metadata: { callerId: this.userId }
    });
    
    if (call) {
      this.handleCall(call, targetUserId);
    }
  }

  private handleCall(call: MediaConnection, targetUserId: string) {
    this.calls.set(targetUserId, call);

    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(targetUserId, 'connecting');
    }

    call.on('stream', (remoteStream) => {
      console.log(`Received stream from ${targetUserId}`);
      audioEngine.addStream(targetUserId, remoteStream, true);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(targetUserId, 'connected');
      }
    });

    call.on('close', () => {
      console.log(`Call closed with ${targetUserId}`);
      this.calls.delete(targetUserId);
      audioEngine.removeStream(targetUserId);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(targetUserId, 'disconnected');
      }
    });

    call.on('error', (err) => {
      console.error(`Call error with ${targetUserId}:`, err);
      this.calls.delete(targetUserId);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(targetUserId, 'failed');
      }
    });
  }

  public removePeerConnection(targetUserId: string) {
    const call = this.calls.get(targetUserId);
    if (call) {
      call.close();
      this.calls.delete(targetUserId);
    }
    audioEngine.removeStream(targetUserId);
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(targetUserId, 'disconnected');
    }
  }

  public disconnect() {
    this.calls.forEach(call => call.close());
    this.calls.clear();
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }
}
