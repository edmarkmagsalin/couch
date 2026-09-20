import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// In-memory state store now holds video state AND recent chat history
const roomStates = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);


  // --- JOIN ROOM EVENT ---
  socket.on('join-room', ({ roomId, username, action }, callback) => {
    if (action === 'join' && !roomStates[roomId]) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room does not exist!' });
      }
      return; 
    }

    socket.join(roomId);
    console.log(`${username} (${socket.id}) joined room ${roomId}`);

    if (!roomStates[roomId]) {
      roomStates[roomId] = {
        video: { status: 'paused', timestamp: 0 },
        chatHistory: [],
        host: username,
        hostSocketId: socket.id,
        users: [] 
      };
    }

    if (!Array.isArray(roomStates[roomId].users)) {
      roomStates[roomId].users = [];
    }

    // Prevent duplicate entries if a socket re-triggers
    if (!roomStates[roomId].users.some(u => u.socketId === socket.id)) {
      roomStates[roomId].users.push({ socketId: socket.id, username });
      
      // Push and emit join message only once
      const systemMessage = { sender: 'System', text: `${username} joined the party.`, time: Date.now() };
      roomStates[roomId].chatHistory.push(systemMessage);
      io.in(roomId).emit('new-message', systemMessage);
    }

    socket.emit('sync-room', roomStates[roomId]);

    if (typeof callback === 'function') {
      callback({ success: true, host: roomStates[roomId].host });
    }
  });
  
  // Helper function to handle user removal, host reassignment, and room deletion
  function removeUserAndReassignHost(roomId, socketId) {
    if (!roomStates[roomId]) return;
    
    const room = roomStates[roomId];
    
    // 1. Find the user who is leaving
    const departingUser = room.users.find(u => u.socketId === socketId);
    if (!departingUser) return;

    // 2. Check if the departing user is currently the host
    const wasHost = (room.hostSocketId === socketId) || (room.host === departingUser.username);

    // 3. Now remove them from the users array
    room.users = room.users.filter(u => u.socketId !== socketId);
    
    // 4. If room is empty, delete it completely
    if (room.users.length === 0) {
      delete roomStates[roomId];
      console.log(`Room ${roomId} has 0 participants and was deleted from memory.`);
      return;
    }

    // 5. If the departing user was the host, pass the title to the NEW first user in the array
    if (wasHost) {
      const newHostUser = room.users[0]; // The next person in line
      room.hostSocketId = newHostUser.socketId;
      room.host = newHostUser.username;
      
      const systemMessage = { 
        sender: 'System', 
        text: `${departingUser.username} left. ${room.host} is now the room host.`, 
        time: Date.now() 
      };
      room.chatHistory.push(systemMessage);
      io.in(roomId).emit('new-message', systemMessage);
      
      // Broadcast the correct new host to all remaining clients
      io.in(roomId).emit('update-host', { newHost: room.host });
    } else {
      const systemMessage = { 
        sender: 'System', 
        text: `${departingUser.username} left the party.`, 
        time: Date.now() 
      };
      room.chatHistory.push(systemMessage);
      io.in(roomId).emit('new-message', systemMessage);
    }
  }

  socket.on('join-room', ({ roomId, username, action }, callback) => {
    if (action === 'join' && !roomStates[roomId]) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room does not exist!' });
      }
      return; 
    }

    socket.join(roomId);
    console.log(`${username} (${socket.id}) joined room ${roomId}`);

    // Initialize room state if it doesn't exist
    if (!roomStates[roomId]) {
      roomStates[roomId] = {
        video: { status: 'paused', timestamp: 0 },
        chatHistory: [],
        host: username,
        hostSocketId: socket.id, // Explicit tracking
        users: [] 
      };
    }

    if (!Array.isArray(roomStates[roomId].users)) {
      roomStates[roomId].users = [];
    }

    roomStates[roomId].users.push({ socketId: socket.id, username });

    socket.emit('sync-room', roomStates[roomId]);

    const systemMessage = { sender: 'System', text: `${username} joined the party.`, time: Date.now() };
    roomStates[roomId].chatHistory.push(systemMessage);
    io.in(roomId).emit('new-message', systemMessage);

    if (typeof callback === 'function') {
      callback({ success: true, host: roomStates[roomId].host });
    }
  });

  // --- LEAVE ROOM EVENT ---
  socket.on('leave-room', ({ roomId, username }) => {
    if (!roomStates[roomId]) return;
    socket.leave(roomId);
    console.log(`${username} (${socket.id}) left room ${roomId}`);
    removeUserAndReassignHost(roomId, socket.id);
  });

  // --- VIDEO EVENTS ---
  socket.on('play-video', ({ roomId, timestamp }) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    roomStates[roomId].video = { status: 'playing', timestamp };
    socket.to(roomId).emit('play-video', { timestamp });
  });

  socket.on('pause-video', ({ roomId, timestamp }) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    roomStates[roomId].video = { status: 'paused', timestamp };
    socket.to(roomId).emit('pause-video', { timestamp });
  });

  socket.on('seek-video', ({ roomId, timestamp }) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    roomStates[roomId].video.timestamp = timestamp;
    socket.to(roomId).emit('seek-video', { timestamp });
  });

  // --- CHAT EVENTS ---
  socket.on('send-message', ({ roomId, username, text }) => {
    // NEW: Log exactly what the server receives!
    console.log(`[CHAT] ${username} in ${roomId}: ${text}`);

    if (!roomStates[roomId]) {
      roomStates[roomId] = { video: { status: 'paused', timestamp: 0 }, chatHistory: [] };
    }

    const chatMessage = { sender: username, text: text, time: Date.now() };

    if (roomStates[roomId].chatHistory.length >= 50) {
      roomStates[roomId].chatHistory.shift(); 
    }
    roomStates[roomId].chatHistory.push(chatMessage);

    socket.to(roomId).emit('new-message', chatMessage);
  });

  // --- DISCONNECT EVENT ---
  socket.on('disconnecting', () => {
    // socket.rooms contains all rooms this socket was a part of
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id && roomStates[roomId]) {
        // Announce to remaining users that someone dropped off
        const systemMessage = { sender: 'System', text: `A user disconnected.`, time: Date.now() };
        roomStates[roomId].chatHistory.push(systemMessage);
        io.in(roomId).emit('new-message', systemMessage);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Check all rooms this socket might have belonged to
    Object.keys(roomStates).forEach((roomId) => {
      removeUserAndReassignHost(roomId, socket.id);
    });
  });

  // Listen for host reassignment if the current host leaves
  socket.on('update-host', ({ newHost }) => {
    const displayHostName = shadow.getElementById('display-host-name');
    if (displayHostName) {
      displayHostName.textContent = newHost;
      console.log(`Host title transferred to: ${newHost}`);
    }
  });
});

server.listen(3000, () => {
  console.log('Watch Party & Chat Server running on port 3000');
});