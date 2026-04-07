import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' }
  });
  const PORT = 3000;

  // Signaling Server Logic
  const users = new Map(); // socketId -> { id, name, status }

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (name) => {
      users.set(socket.id, { id: socket.id, name, status: 'online' });
      socket.broadcast.emit('user-joined', { id: socket.id, name });
      
      // Send existing users to the new user
      const existingUsers = Array.from(users.values()).filter(u => u.id !== socket.id);
      socket.emit('existing-users', existingUsers);
    });

    // WebRTC Signaling
    socket.on('offer', (data) => {
      socket.to(data.target).emit('offer', {
        caller: socket.id,
        callerName: users.get(socket.id)?.name,
        sdp: data.sdp
      });
    });

    socket.on('answer', (data) => {
      socket.to(data.target).emit('answer', {
        callee: socket.id,
        sdp: data.sdp
      });
    });

    socket.on('ice-candidate', (data) => {
      socket.to(data.target).emit('ice-candidate', {
        sender: socket.id,
        candidate: data.candidate
      });
    });

    // PTT Status
    socket.on('ptt-status', (data) => {
      socket.broadcast.emit('ptt-status', {
        userId: socket.id,
        isTalking: data.isTalking,
        target: data.target // 'team' or specific userId
      });
    });

    // Text Messaging
    socket.on('chat-message', (data) => {
      const senderName = users.get(socket.id)?.name || 'Unknown';
      const message = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        senderId: socket.id,
        senderName,
        text: data.text,
        timestamp: new Date().toISOString(),
        target: data.target
      };
      
      if (data.target === 'team') {
        io.emit('chat-message', message);
      } else {
        socket.to(data.target).emit('chat-message', message);
        socket.emit('chat-message', message); // Send to self
      }
    });

    socket.on('disconnect', () => {
      users.delete(socket.id);
      socket.broadcast.emit('user-left', socket.id);
      console.log('User disconnected:', socket.id);
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
