import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';

let globalSocket = null;

export function useSocket(token) {
  const [socket, setSocket] = useState(null);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [documentLocks, setDocumentLocks] = useState({});

  useEffect(() => {
    if (!token) return;

    // Reuse existing socket or create new one
    if (globalSocket && globalSocket.connected) {
      setSocket(globalSocket);
      return;
    }

    const s = io('http://localhost:3001', {
      auth: { token },
      transports: ['websocket', 'polling']
    });

    s.on('connect', () => {
      console.log('🔌 WebSocket conectado');
    });

    // Presence updates
    s.on('presence_update', (users) => {
      setOnlineUsers(users);
    });

    // Live notifications
    s.on('notification', (notif) => {
      setNotifications(prev => [notif, ...prev].slice(0, 20));
      // Auto-remove after 5s
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n !== notif));
      }, 5000);
    });

    // Document lock events
    s.on('document_locked', ({ documentId, documentName, lockedBy, lockedAt }) => {
      setDocumentLocks(prev => ({ ...prev, [documentId]: { lockedBy, lockedAt, documentName } }));
    });

    s.on('document_unlocked', ({ documentId }) => {
      setDocumentLocks(prev => {
        const copy = { ...prev };
        delete copy[documentId];
        return copy;
      });
    });

    s.on('lock_denied', ({ documentId, lockedBy, lockedAt }) => {
      setNotifications(prev => [{
        type: 'lock_denied',
        message: `Documento bloqueado por ${lockedBy}`,
        timestamp: new Date().toISOString()
      }, ...prev].slice(0, 20));
    });

    s.on('current_locks', (locks) => {
      setDocumentLocks(locks);
    });

    // New activity from other users
    s.on('new_activity', (activity) => {
      setNotifications(prev => [{
        type: 'activity',
        message: activity.descripcion || `${activity.user.nombre} realizó una acción`,
        user: activity.user,
        timestamp: activity.timestamp
      }, ...prev].slice(0, 20));
    });

    s.on('disconnect', () => {
      console.log('🔌 WebSocket desconectado');
    });

    globalSocket = s;
    setSocket(s);

    return () => {
      s.disconnect();
      globalSocket = null;
    };
  }, [token]);

  const changePage = useCallback((page) => {
    if (globalSocket) globalSocket.emit('page_change', page);
  }, []);

  const lockDocument = useCallback((documentId, documentName) => {
    if (globalSocket) globalSocket.emit('lock_document', { documentId, documentName });
  }, []);

  const unlockDocument = useCallback((documentId) => {
    if (globalSocket) globalSocket.emit('unlock_document', { documentId });
  }, []);

  const emitActivity = useCallback((data) => {
    if (globalSocket) globalSocket.emit('activity', data);
  }, []);

  const requestLocks = useCallback(() => {
    if (globalSocket) globalSocket.emit('get_locks');
  }, []);

  const dismissNotification = useCallback((index) => {
    setNotifications(prev => prev.filter((_, i) => i !== index));
  }, []);

  return {
    socket,
    onlineUsers,
    notifications,
    documentLocks,
    changePage,
    lockDocument,
    unlockDocument,
    emitActivity,
    requestLocks,
    dismissNotification
  };
}
