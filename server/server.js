import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

// Initialize database (creates tables & seeds data)
import db from './database.js';

import authRoutes from './routes/auth.js';
import tareasRoutes from './routes/tareas.js';
import documentosRoutes from './routes/documentos.js';
import calendarioRoutes from './routes/calendario.js';
import equiposRoutes from './routes/equipos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const SECRET = process.env.JWT_SECRET || 'groupware-secret-2026';
const PORT = process.env.PORT || 3001;

// ── Socket.io Setup ──
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Connected users tracking (In-memory presence store)
const connectedUsers = new Map(); // socketId -> { userId, nombre, avatar_color, currentPage, connectedAt }
const documentLocks = new Map();  // documentId -> { userId, nombre, lockedAt, socketId }

// Socket.io Authentication Middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token requerido'));
  try {
    const decoded = jwt.verify(token, SECRET);
    const user = db.prepare('SELECT id, nombre, email, avatar_color, equipo_id FROM users WHERE id = ?').get(decoded.id);
    if (!user) return next(new Error('Usuario no encontrado'));
    socket.user = user;
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`🟢 ${user.nombre} conectado (socket: ${socket.id})`);

  // Register user as online
  connectedUsers.set(socket.id, {
    userId: user.id,
    nombre: user.nombre,
    avatar_color: user.avatar_color,
    currentPage: 'dashboard',
    connectedAt: new Date().toISOString()
  });

  // Update DB status
  db.prepare("UPDATE users SET estado = 'online', ultimo_acceso = datetime('now') WHERE id = ?").run(user.id);

  // Broadcast updated presence to all clients
  broadcastPresence();

  // Log activity
  db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
    user.id, 'conexion', `${user.nombre} se ha conectado`
  );

  // Broadcast notification
  socket.broadcast.emit('notification', {
    type: 'user_joined',
    message: `${user.nombre} se ha conectado`,
    user: { id: user.id, nombre: user.nombre, avatar_color: user.avatar_color },
    timestamp: new Date().toISOString()
  });

  // ── Page Navigation (Awareness) ──
  socket.on('page_change', (page) => {
    const entry = connectedUsers.get(socket.id);
    if (entry) {
      entry.currentPage = page;
      broadcastPresence();
    }
  });

  // ── Document Locking (Concurrency Control) ──
  socket.on('lock_document', ({ documentId, documentName }) => {
    const existing = documentLocks.get(documentId);
    if (existing && existing.userId !== user.id) {
      // Document is locked by someone else
      socket.emit('lock_denied', {
        documentId,
        lockedBy: existing.nombre,
        lockedAt: existing.lockedAt
      });
    } else {
      // Lock the document
      documentLocks.set(documentId, {
        userId: user.id,
        nombre: user.nombre,
        lockedAt: new Date().toISOString(),
        socketId: socket.id
      });
      io.emit('document_locked', {
        documentId,
        documentName,
        lockedBy: { id: user.id, nombre: user.nombre, avatar_color: user.avatar_color },
        lockedAt: new Date().toISOString()
      });

      db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
        user.id, 'documento_bloqueado', `${user.nombre} está editando "${documentName}"`
      );
    }
  });

  socket.on('unlock_document', ({ documentId }) => {
    const existing = documentLocks.get(documentId);
    if (existing && existing.userId === user.id) {
      documentLocks.delete(documentId);
      io.emit('document_unlocked', { documentId });
    }
  });

  // ── Real-time Activity Broadcast ──
  socket.on('activity', (data) => {
    // Broadcast activity to all other clients
    socket.broadcast.emit('new_activity', {
      ...data,
      user: { id: user.id, nombre: user.nombre, avatar_color: user.avatar_color },
      timestamp: new Date().toISOString()
    });
  });

  // ── Request current locks ──
  socket.on('get_locks', () => {
    const locks = {};
    for (const [docId, lock] of documentLocks) {
      locks[docId] = lock;
    }
    socket.emit('current_locks', locks);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`🔴 ${user.nombre} desconectado`);

    // Release any document locks held by this user
    for (const [docId, lock] of documentLocks) {
      if (lock.socketId === socket.id) {
        documentLocks.delete(docId);
        io.emit('document_unlocked', { documentId: docId });
      }
    }

    // Remove from connected users
    connectedUsers.delete(socket.id);

    // Check if user has other active connections
    const stillConnected = [...connectedUsers.values()].some(u => u.userId === user.id);
    if (!stillConnected) {
      db.prepare("UPDATE users SET estado = 'offline', ultimo_acceso = datetime('now') WHERE id = ?").run(user.id);

      db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
        user.id, 'desconexion', `${user.nombre} se ha desconectado`
      );

      socket.broadcast.emit('notification', {
        type: 'user_left',
        message: `${user.nombre} se ha desconectado`,
        user: { id: user.id, nombre: user.nombre, avatar_color: user.avatar_color },
        timestamp: new Date().toISOString()
      });
    }

    broadcastPresence();
  });
});

function broadcastPresence() {
  // Deduplicate by userId (a user may have multiple tabs)
  const usersMap = new Map();
  for (const [, entry] of connectedUsers) {
    if (!usersMap.has(entry.userId)) {
      usersMap.set(entry.userId, entry);
    } else {
      // Keep the most recent page
      usersMap.set(entry.userId, entry);
    }
  }
  const onlineUsers = [...usersMap.values()];
  io.emit('presence_update', onlineUsers);
}

// Make io accessible to routes for emitting events
app.set('io', io);

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/tareas', tareasRoutes);
app.use('/api/documentos', documentosRoutes);
app.use('/api/calendario', calendarioRoutes);
app.use('/api/equipos', equiposRoutes);

// Static uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket ready for real-time collaboration`);
});
