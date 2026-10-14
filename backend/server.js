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

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

// In-memory state store now holds video state AND recent chat history
const roomStates = {}; 
const emptyRoomTimers = {};
const roomPlaybackAnnouncementTimers = {};
const ROOM_RECONNECT_GRACE_MS = 60 * 1000;
const ROOM_PLAYBACK_ANNOUNCEMENT_INTERVAL_MS = 5 * 60 * 1000;
const PLAYBACK_STATE_REQUEST_TIMEOUT_MS = 5000;

function formatPlaybackTimestamp(seconds) {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  const secondsText = String(remainingSeconds).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`
    : `${minutes}:${secondsText}`;
}

function getRoomUserList(room) {
  const usernames = [...new Set(room.users.map(user => user.username))];
  const hostIndex = usernames.indexOf(room.host);
  if (hostIndex > 0) usernames.unshift(usernames.splice(hostIndex, 1)[0]);
  return usernames;
}

function getCurrentRoomVideoState(room) {
  const video = room.video;
  const elapsed = video.status === 'playing'
    ? Math.max(0, Date.now() - video.updatedAt) / 1000
    : 0;
  return {
    ...video,
    timestamp: Math.max(0, video.timestamp + elapsed)
  };
}

function requestExtensionPlaybackState(roomId, extension) {
  return new Promise((resolve) => {
    io.to(extension.socketId).timeout(PLAYBACK_STATE_REQUEST_TIMEOUT_MS).emit(
      'request-playback-state',
      { roomId },
      (error, responses = []) => {
        const state = responses[0];
        const isAvailable = !error
          && state?.available === true
          && ['playing', 'paused'].includes(state.status)
          && Number.isFinite(state.timestamp)
          && state.timestamp >= 0;
        resolve({
          socketId: extension.socketId,
          username: extension.username,
          status: isAvailable ? state.status : null,
          timestamp: isAvailable ? state.timestamp : null
        });
      }
    );
  });
}

async function syncJoiningUserWithHost(roomId, room, joiningSocketId) {
  const host = room.host;
  const extensions = room.users.filter(user => (
    user.clientType === 'extension'
    && user.username === host
    && user.socketId !== joiningSocketId
    && io.sockets.sockets.has(user.socketId)
  ));
  if (extensions.length === 0) return;

  const requestStartedAt = Date.now();
  const states = await Promise.all(
    extensions.map(extension => requestExtensionPlaybackState(roomId, extension))
  );
  if (
    roomStates[roomId] !== room
    || room.host !== host
    || room.video.updatedAt > requestStartedAt
    || !room.users.some(user => user.socketId === joiningSocketId)
  ) {
    return;
  }

  const currentHostExtensions = new Set(room.users
    .filter(user => user.clientType === 'extension' && user.username === host)
    .map(user => user.socketId));
  const hostState = states.find(state => (
    currentHostExtensions.has(state.socketId)
    && state.status
    && Number.isFinite(state.timestamp)
  ));
  if (!hostState) return;

  const state = {
    status: hostState.status,
    timestamp: hostState.timestamp,
    updatedAt: Date.now()
  };
  room.video = state;
  io.to(joiningSocketId).emit('sync-playback-state', { roomId, ...state });
}

async function announceRoomPlaybackPositions(roomId) {
  const room = roomStates[roomId];
  if (!room) return;

  const extensions = room.users.filter(user => user.clientType === 'extension');
  if (extensions.length === 0) return;

  const playbackStates = await Promise.all(
    extensions.map(extension => requestExtensionPlaybackState(roomId, extension))
  );
  if (roomStates[roomId] !== room) return;

  const currentExtensions = room.users.filter(user => user.clientType === 'extension');
  if (currentExtensions.length === 0) return;
  const currentExtensionSocketIds = new Set(currentExtensions.map(user => user.socketId));
  const playbackByUsername = new Map();
  for (const state of playbackStates) {
    if (
      currentExtensionSocketIds.has(state.socketId)
      && state.timestamp !== null
      && !playbackByUsername.has(state.username)
    ) {
      playbackByUsername.set(state.username, state.timestamp);
    }
  }

  const usernames = [...new Set(currentExtensions.map(user => user.username))];
  const hostIndex = usernames.indexOf(room.host);
  if (hostIndex > 0) usernames.unshift(usernames.splice(hostIndex, 1)[0]);
  const participants = usernames.map(username => {
    const timestamp = playbackByUsername.get(username);
    return {
      username,
      isHost: username === room.host,
      position: timestamp === undefined ? 'unavailable' : formatPlaybackTimestamp(timestamp)
    };
  });
  const announcement = participants.map(({ username, isHost, position }) => (
    `${username}${isHost ? ' (host)' : ''}: ${position}`
  )).join('\n');
  const message = {
    sender: 'System',
    text: `Status check every 5 mins\n${announcement}`,
    type: 'playback-position-announcement',
    highlightedUsernames: usernames,
    participants,
    time: Date.now()
  };

  if (room.chatHistory.length >= 50) room.chatHistory.shift();
  room.chatHistory.push(message);
  io.in(roomId).emit('new-message', message);
}

function scheduleRoomPlaybackAnnouncement(roomId) {
  if (roomPlaybackAnnouncementTimers[roomId]) return;
  roomPlaybackAnnouncementTimers[roomId] = setTimeout(() => {
    delete roomPlaybackAnnouncementTimers[roomId];
    const room = roomStates[roomId];
    if (!room) return;

    scheduleRoomPlaybackAnnouncement(roomId);
    announceRoomPlaybackPositions(roomId).catch(error => {
      console.error(`Could not announce playback positions for room ${roomId}:`, error);
    });
  }, ROOM_PLAYBACK_ANNOUNCEMENT_INTERVAL_MS);
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  function broadcastRoomUsers(roomId) {
    const room = roomStates[roomId];
    if (!room) return;
    io.in(roomId).emit('room-users', {
      users: getRoomUserList(room),
      host: room.host
    });
  }

  // --- JOIN ROOM EVENT ---
  socket.on('join-room', ({ roomId, username, action, clientType }, callback) => {
    if (action === 'join' && !roomStates[roomId]) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room does not exist!' });
      }
      return; 
    }

    socket.join(roomId);

    if (emptyRoomTimers[roomId]) {
      clearTimeout(emptyRoomTimers[roomId]);
      delete emptyRoomTimers[roomId];
    }

    if (!roomStates[roomId]) {
      roomStates[roomId] = {
        video: { status: 'paused', timestamp: 0, updatedAt: Date.now() },
        chatHistory: [],
        host: username,
        hostSocketId: socket.id,
        users: [] 
      };
    }

    if (!Array.isArray(roomStates[roomId].users)) {
      roomStates[roomId].users = [];
    }

    // Check if this specific socket/user is already registered in the room
    const userExists = roomStates[roomId].users.some(u => u.socketId === socket.id);

    if (!userExists) {
      const participantType = clientType === 'remote' ? 'remote' : 'extension';
      roomStates[roomId].users.push({
        socketId: socket.id,
        username,
        clientType: participantType
      });
      
      const joinMessage = participantType === 'extension'
        ? {
            sender: 'System',
            text: `${username} joined the party.`,
            highlightedUsernames: [username],
            time: Date.now()
          }
        : null;
      if (joinMessage) roomStates[roomId].chatHistory.push(joinMessage);

      // Send current room state to the joining user
      socket.emit('sync-room', {
        ...roomStates[roomId],
        video: getCurrentRoomVideoState(roomStates[roomId])
      });

      // Broadcast the join message ONLY to other existing members in the room
      if (joinMessage) socket.to(roomId).emit('new-message', joinMessage);
    } else {
      // If already joined, just re-sync state without adding a duplicate system message
      const participant = roomStates[roomId].users.find(user => user.socketId === socket.id);
      participant.clientType = clientType === 'remote' ? 'remote' : 'extension';
      socket.emit('sync-room', {
        ...roomStates[roomId],
        video: getCurrentRoomVideoState(roomStates[roomId])
      });
    }

    const participant = roomStates[roomId].users.find(user => user.socketId === socket.id);
    if (participant.clientType === 'remote') {
      const extensions = roomStates[roomId].users.filter(user => (
        user.clientType === 'extension' && user.username === participant.username
      ));
      if (extensions.length === 0) {
        socket.emit('video-volume-state', { available: false, volume: null });
      } else {
        extensions.forEach(user => io.to(user.socketId).emit('request-video-volume'));
      }
    }

    scheduleRoomPlaybackAnnouncement(roomId);
    broadcastRoomUsers(roomId);
    if (typeof callback === 'function') {
      callback({ success: true, host: roomStates[roomId].host });
    }
    syncJoiningUserWithHost(roomId, roomStates[roomId], socket.id).catch(error => {
      console.error(`Could not sync joining user with host playback in room ${roomId}:`, error);
    });
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
      emptyRoomTimers[roomId] = setTimeout(() => {
        if (roomStates[roomId]?.users.length === 0) {
          delete roomStates[roomId];
          delete emptyRoomTimers[roomId];
          clearTimeout(roomPlaybackAnnouncementTimers[roomId]);
          delete roomPlaybackAnnouncementTimers[roomId];
          console.log(`Room ${roomId} expired after the reconnect grace period.`);
        }
      }, ROOM_RECONNECT_GRACE_MS);
      console.log(`Room ${roomId} has 0 participants and is available for reconnecting for 60 seconds.`);
      return;
    }

    // 5. If the departing user was the host, pass the title to the NEW first user in the array
    if (wasHost) {
      const newHostUser = room.users[0]; // The next person in line
      room.hostSocketId = newHostUser.socketId;
      room.host = newHostUser.username;
      
      if (departingUser.clientType !== 'remote') {
        const systemMessage = {
          sender: 'System',
          text: `${departingUser.username} left. ${room.host} is now the room host.`,
          highlightedUsernames: [departingUser.username, room.host],
          time: Date.now()
        };
        room.chatHistory.push(systemMessage);
        io.in(roomId).emit('new-message', systemMessage);
      }
      
      // Broadcast the correct new host to all remaining clients
      io.in(roomId).emit('update-host', { newHost: room.host });
    } else {
      if (departingUser.clientType !== 'remote') {
        const systemMessage = {
          sender: 'System',
          text: `${departingUser.username} left the party.`,
          highlightedUsernames: [departingUser.username],
          time: Date.now()
        };
        room.chatHistory.push(systemMessage);
        io.in(roomId).emit('new-message', systemMessage);
      }
    }
    broadcastRoomUsers(roomId);
  }

  // --- LEAVE ROOM EVENT ---
  socket.on('leave-room', ({ roomId, username }) => {
    if (!roomStates[roomId]) return;
    socket.leave(roomId);
    console.log(`${username} (${socket.id}) left room ${roomId}`);
    removeUserAndReassignHost(roomId, socket.id);
  });

  socket.on('video-volume-state', ({ roomId, available, volume }) => {
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    if (!room || participant?.clientType !== 'extension' || typeof available !== 'boolean') return;
    if (available && (!Number.isFinite(volume) || volume < 0 || volume > 1)) return;

    room.users
      .filter(user => user.clientType === 'remote' && user.username === participant.username)
      .forEach(user => io.to(user.socketId).emit('video-volume-state', {
        available,
        volume: available ? volume : null
      }));
  });

  socket.on('set-video-volume', ({ roomId, volume }, callback) => {
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    if (!room || participant?.clientType !== 'remote' || !Number.isFinite(volume) || volume < 0 || volume > 1) {
      if (typeof callback === 'function') callback({ success: false });
      return;
    }

    const targets = room.users.filter(user => (
      user.clientType === 'extension' && user.username === participant.username
    ));
    targets.forEach(user => io.to(user.socketId).emit('set-video-volume', { volume }));
    if (typeof callback === 'function') callback({ success: targets.length > 0 });
  });

  socket.on('request-playback-state', ({ roomId }, callback) => {
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    if (!room || participant?.clientType !== 'remote') {
      if (typeof callback === 'function') callback({ success: false, message: 'Join a room before syncing playback.' });
      return;
    }

    const extensions = room.users.filter(user => (
      user.clientType === 'extension' && user.username === participant.username
    ));
    if (extensions.length === 0) {
      if (typeof callback === 'function') callback({ success: false, message: 'No matching Couch extension is connected.' });
      return;
    }

    io.to(extensions.map(user => user.socketId)).timeout(5000).emit(
      'request-playback-state',
      { roomId },
      (error, responses = []) => {
        const state = responses.find(response => (
          response?.available === true
          && ['playing', 'paused'].includes(response.status)
          && Number.isFinite(response.timestamp)
          && response.timestamp >= 0
        ));

        if (state) {
          if (typeof callback === 'function') callback({
            success: true,
            state: { status: state.status, timestamp: state.timestamp }
          });
        } else if (typeof callback === 'function') {
          callback({
            success: false,
            message: error
              ? 'The extension did not respond. Make sure Couch is open and try again.'
              : 'No video is available in the matching Couch extension.'
          });
        }
      }
    );
  });

  socket.on('request-room-playback-state', ({ roomId }, callback) => {
    if (typeof callback !== 'function') return;
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    if (!room || participant?.clientType !== 'extension') {
      callback({ success: false, message: 'Join a room from the extension before requesting playback state.' });
      return;
    }

    const now = Date.now();
    const timestamp = room.video.timestamp + (
      room.video.status === 'playing'
        ? Math.max(0, now - room.video.updatedAt) / 1000
        : 0
    );
    callback({
      success: true,
      state: {
        status: room.video.status,
        timestamp,
        updatedAt: now
      }
    });
  });

  // --- VIDEO EVENTS ---
  socket.on('play-video', ({ roomId, timestamp }, callback) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    const updatedAt = Date.now();
    roomStates[roomId].video = { status: 'playing', timestamp, updatedAt };
    socket.to(roomId).emit('play-video', { timestamp, updatedAt });
    if (typeof callback === 'function') callback({ updatedAt });
  });

  socket.on('pause-video', ({ roomId, timestamp }, callback) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    const updatedAt = Date.now();
    roomStates[roomId].video = { status: 'paused', timestamp, updatedAt };
    socket.to(roomId).emit('pause-video', { timestamp, updatedAt });
    if (typeof callback === 'function') callback({ updatedAt });
  });

  socket.on('seek-video', ({ roomId, timestamp }, callback) => {
    if (!roomStates[roomId]) return; // Safety check for missing room state
    roomStates[roomId].video.timestamp = timestamp;
    roomStates[roomId].video.updatedAt = Date.now();
    socket.to(roomId).emit('seek-video', {
      timestamp,
      updatedAt: roomStates[roomId].video.updatedAt
    });
    if (typeof callback === 'function') callback({ updatedAt: roomStates[roomId].video.updatedAt });
  });

  socket.on('media-change', ({ roomId, title, mediaKey }) => {
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    const trimmedTitle = typeof title === 'string' ? title.trim() : '';
    const trimmedMediaKey = typeof mediaKey === 'string' ? mediaKey.trim() : '';

    if (!room || !participant || !trimmedTitle || !trimmedMediaKey) return;

    const systemMessage = {
      sender: 'System',
      text: `${participant.username} is playing "${trimmedTitle}".`,
      highlightedUsernames: [participant.username],
      time: Date.now()
    };

    if (room.chatHistory.length >= 50) room.chatHistory.shift();
    room.chatHistory.push(systemMessage);
    io.in(roomId).emit('new-message', systemMessage);
  });

  socket.on('video-action', ({ roomId, action, timestamp }) => {
    const room = roomStates[roomId];
    const participant = room?.users.find(user => user.socketId === socket.id);
    const actionText = {
      play: 'resumed playback',
      pause: 'paused playback',
      seek: 'changed the playback time'
    }[action];

    if (!room || !participant || !actionText || !Number.isFinite(timestamp)) return;

    const totalSeconds = Math.floor(timestamp);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const timestampText = hours > 0
      ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      : `${minutes}:${seconds.toString().padStart(2, '0')}`;
    const systemMessage = {
      sender: 'System',
      text: `${participant.username} ${actionText} at ${timestampText}.`,
      highlightedUsernames: [participant.username],
      time: Date.now()
    };

    if (room.chatHistory.length >= 50) room.chatHistory.shift();
    room.chatHistory.push(systemMessage);
    io.in(roomId).emit('new-message', systemMessage);
  });

  // --- CHAT EVENTS ---
  socket.on('send-message', ({ roomId, username, text }) => {
    // NEW: Log exactly what the server receives!
    console.log(`[CHAT] ${username} in ${roomId}: ${text}`);

    if (!roomStates[roomId]) {
      roomStates[roomId] = {
        video: { status: 'paused', timestamp: 0, updatedAt: Date.now() },
        chatHistory: []
      };
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
        const participant = roomStates[roomId].users.find(user => user.socketId === socket.id);
        if (participant?.clientType === 'remote') return;

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

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Watch Party & Chat Server running on port ${port}`);
});