import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' }
  });
  const PORT = 3000;

  // Simple File-Based Database for Users
  const DB_FILE = path.join(process.cwd(), 'users_db.json');
  
  // Load users from disk or initialize empty
  let registeredUsers: Record<string, any> = {};
  if (fs.existsSync(DB_FILE)) {
    try {
      registeredUsers = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    } catch (e) {
      console.error("Failed to parse users DB", e);
    }
  }

  const saveUsers = () => {
    fs.writeFileSync(DB_FILE, JSON.stringify(registeredUsers, null, 2));
  };

  // API Routes for Auth
  app.use(express.json());

  app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const lowerUser = username.toLowerCase();
    if (registeredUsers[lowerUser]) {
      return res.status(400).json({ error: 'Callsign already taken' });
    }
    
    const userId = 'usr_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    registeredUsers[lowerUser] = {
      id: userId,
      username,
      password, // In a real app, hash this!
      createdAt: new Date().toISOString()
    };
    saveUsers();
    
    res.json({ success: true, user: { id: userId, username } });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const lowerUser = (username || '').toLowerCase();
    const user = registeredUsers[lowerUser];
    
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid callsign or password' });
    }
    
    res.json({ success: true, user: { id: user.id, username: user.username } });
  });

  app.get('/api/users', (req, res) => {
    const safeUsers = Object.values(registeredUsers).map((u: any) => ({
      id: u.id,
      username: u.username
    }));
    res.json(safeUsers);
  });

  // Signaling Server Logic
  const activeSockets = new Map(); // socketId -> { id, name, status }
  const userToSocket = new Map(); // userId -> socketId

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('join', (userData) => {
      // userData should be { id, username } from login
      activeSockets.set(socket.id, { 
        id: userData.id, 
        name: userData.username, 
        socketId: socket.id,
        status: 'online' 
      });
      userToSocket.set(userData.id, socket.id);
      
      socket.broadcast.emit('user-joined', { id: userData.id, name: userData.username, socketId: socket.id });
      
      // Send existing active users to the new user
      const existingUsers = Array.from(activeSockets.values()).filter(u => u.socketId !== socket.id);
      socket.emit('existing-users', existingUsers);
    });

    // WebRTC Signaling (using socketId for routing)
    socket.on('offer', (data) => {
      socket.to(data.targetSocket).emit('offer', {
        callerSocket: socket.id,
        callerId: activeSockets.get(socket.id)?.id,
        callerName: activeSockets.get(socket.id)?.name,
        sdp: data.sdp
      });
    });

    socket.on('answer', (data) => {
      socket.to(data.targetSocket).emit('answer', {
        calleeSocket: socket.id,
        sdp: data.sdp
      });
    });

    socket.on('ice-candidate', (data) => {
      socket.to(data.targetSocket).emit('ice-candidate', {
        senderSocket: socket.id,
        candidate: data.candidate
      });
    });

    // PTT Status
    socket.on('ptt-status', (data) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;
      
      if (data.target === 'team') {
        socket.broadcast.emit('ptt-status', {
          userId: user.id,
          isTalking: data.isTalking,
          target: 'team'
        });
      } else {
        // Target is a userId, find their socket
        const targetSocketId = userToSocket.get(data.target);
        if (targetSocketId) {
          socket.to(targetSocketId).emit('ptt-status', {
            userId: user.id,
            isTalking: data.isTalking,
            target: user.id // Tell them we are talking to them
          });
        }
      }
    });

    // Text Messaging
    socket.on('chat-message', (data) => {
      const user = activeSockets.get(socket.id);
      if (!user) return;

      const message = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        senderId: user.id,
        senderName: user.name,
        text: data.text,
        timestamp: new Date().toISOString(),
        target: data.target
      };
      
      if (data.target === 'team') {
        io.emit('chat-message', message);
      } else {
        const targetSocketId = userToSocket.get(data.target);
        if (targetSocketId) {
          socket.to(targetSocketId).emit('chat-message', message);
        }
        socket.emit('chat-message', message); // Send to self
      }
    });

    socket.on('disconnect', () => {
      const user = activeSockets.get(socket.id);
      if (user) {
        activeSockets.delete(socket.id);
        userToSocket.delete(user.id);
        socket.broadcast.emit('user-left', user.id);
      }
      console.log('Socket disconnected:', socket.id);
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
