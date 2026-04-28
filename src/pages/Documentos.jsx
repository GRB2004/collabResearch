import { useState, useEffect, useRef } from 'react';
import api from '../api';

export default function Documentos({ user, documentLocks = {}, lockDocument, unlockDocument, emitActivity, requestLocks }) {
  const [documentos, setDocumentos] = useState([]);
  const [showCreateDoc, setShowCreateDoc] = useState(false);
  const [showCreateBranch, setShowCreateBranch] = useState(null);
  const [showUpload, setShowUpload] = useState(null);
  const [expandedDoc, setExpandedDoc] = useState(null);
  const [ramas, setRamas] = useState({});
  const [versiones, setVersiones] = useState({});
  const [expandedBranch, setExpandedBranch] = useState(null);
  const [docForm, setDocForm] = useState({ nombre: '', descripcion: '' });
  const [branchName, setBranchName] = useState('');
  const [uploadMsg, setUploadMsg] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    loadDocs();
    if (requestLocks) requestLocks();
  }, []);

  const loadDocs = async () => {
    try {
      const docs = await api.getDocumentos();
      setDocumentos(docs);
    } catch (err) { console.error(err); }
  };

  const createDoc = async (e) => {
    e.preventDefault();
    try {
      await api.createDocumento(docForm);
      setShowCreateDoc(false);
      setDocForm({ nombre: '', descripcion: '' });
      loadDocs();
      if (emitActivity) emitActivity({ tipo: 'documento_creado', descripcion: `Documento "${docForm.nombre}" creado` });
    } catch (err) { alert(err.message); }
  };

  const deleteDoc = async (id) => {
    if (!confirm('¿Eliminar este documento y todas sus versiones?')) return;
    // Check if document is locked
    const lock = documentLocks[id];
    if (lock && lock.userId !== user.id) {
      alert(`No puedes eliminar. ${lock.lockedBy?.nombre || lock.nombre} está editando este documento.`);
      return;
    }
    try {
      await api.deleteDocumento(id);
      loadDocs();
    } catch (err) { alert(err.message); }
  };

  const toggleDoc = async (docId) => {
    if (expandedDoc === docId) { setExpandedDoc(null); return; }
    setExpandedDoc(docId);
    try {
      const r = await api.getRamas(docId);
      setRamas(prev => ({ ...prev, [docId]: r }));
    } catch (err) { console.error(err); }
  };

  const toggleBranch = async (ramaId) => {
    if (expandedBranch === ramaId) { setExpandedBranch(null); return; }
    setExpandedBranch(ramaId);
    try {
      const v = await api.getVersiones(ramaId);
      setVersiones(prev => ({ ...prev, [ramaId]: v }));
    } catch (err) { console.error(err); }
  };

  const createBranch = async (e) => {
    e.preventDefault();
    try {
      await api.createRama(showCreateBranch, { nombre: branchName });
      setShowCreateBranch(null);
      setBranchName('');
      const r = await api.getRamas(expandedDoc);
      setRamas(prev => ({ ...prev, [expandedDoc]: r }));
      loadDocs();
      if (emitActivity) emitActivity({ tipo: 'rama_creada', descripcion: `Rama "${branchName}" creada` });
    } catch (err) { alert(err.message); }
  };

  const handleLockDocument = (doc) => {
    const lock = documentLocks[doc.id];
    if (lock && lock.userId !== user.id) {
      alert(`Documento bloqueado por ${lock.nombre}. Espera a que lo libere.`);
      return;
    }
    if (lock && lock.userId === user.id) {
      // Unlock
      if (unlockDocument) unlockDocument(doc.id);
    } else {
      // Lock
      if (lockDocument) lockDocument(doc.id, doc.nombre);
    }
  };

  const uploadFile = async (e) => {
    e.preventDefault();
    const file = fileRef.current?.files[0];
    if (!file) return alert('Selecciona un archivo');

    // Check lock on the parent document
    const rama = ramas[expandedDoc]?.find(r => r.id === showUpload);
    const docId = rama?.documento_id || expandedDoc;
    const lock = documentLocks[docId];
    if (lock && lock.userId !== user.id) {
      alert(`Documento bloqueado por ${lock.nombre}. No puedes subir versiones.`);
      return;
    }

    const formData = new FormData();
    formData.append('archivo', file);
    formData.append('mensaje', uploadMsg);
    try {
      await api.uploadVersion(showUpload, formData);
      setShowUpload(null);
      setUploadMsg('');
      if (fileRef.current) fileRef.current.value = '';
      const v = await api.getVersiones(showUpload);
      setVersiones(prev => ({ ...prev, [showUpload]: v }));
      loadDocs();
      if (emitActivity) emitActivity({ tipo: 'version_subida', descripcion: `Nueva versión subida a "${file.name}"` });
    } catch (err) { alert(err.message); }
  };

  const downloadFile = async (versionId) => {
    try {
      const res = await api.downloadVersion(versionId);
      if (!res.ok) throw new Error('Error al descargar');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const cd = res.headers.get('content-disposition');
      const match = cd && cd.match(/filename="?(.+?)"?$/);
      const filename = match ? match[1] : 'archivo';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert(err.message); }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  const getDocLock = (docId) => documentLocks[docId];
  const isLockedByMe = (docId) => {
    const lock = documentLocks[docId];
    return lock && lock.userId === user.id;
  };
  const isLockedByOther = (docId) => {
    const lock = documentLocks[docId];
    return lock && lock.userId !== user.id;
  };

  return (
    <div className="animate-in">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Documentos 📄</h2>
          <p>Control de versiones con ramas y concurrencia — bloquea documentos para evitar conflictos</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreateDoc(true)}>➕ Nuevo Documento</button>
      </div>


      {documentos.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">📂</div>
            <h3>No hay documentos</h3>
            <p>Crea tu primer documento para comenzar a gestionar versiones</p>
            <button className="btn btn-primary" onClick={() => setShowCreateDoc(true)}>➕ Crear Documento</button>
          </div>
        </div>
      ) : (
        <div className="doc-list">
          {documentos.map(doc => {
            const lock = getDocLock(doc.id);
            const lockedByMe = isLockedByMe(doc.id);
            const lockedByOther = isLockedByOther(doc.id);

            return (
              <div key={doc.id} className={`doc-card ${lockedByOther ? 'doc-locked-overlay' : ''}`}>
                <div className="doc-card-header">
                  <div className="doc-card-title" onClick={() => toggleDoc(doc.id)} style={{ cursor: 'pointer' }}>
                    <span>{expandedDoc === doc.id ? '📂' : '📁'}</span>
                    {doc.nombre}
                    {lock && (
                      <div className="doc-lock-badge">
                        <span className="lock-icon">🔒</span>
                        {lockedByMe ? 'Bloqueado por ti' : `${lock.nombre || lock.lockedBy?.nombre} editando`}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      className={`btn btn-sm ${lockedByMe ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => handleLockDocument(doc)}
                      title={lockedByMe ? 'Liberar documento' : 'Bloquear para editar'}
                    >
                      {lockedByMe ? '🔓 Liberar' : '🔒 Bloquear'}
                    </button>
                    <button className="btn btn-sm btn-secondary" onClick={() => toggleDoc(doc.id)}>
                      {expandedDoc === doc.id ? '▲ Cerrar' : '▼ Ramas'}
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => deleteDoc(doc.id)} disabled={lockedByOther}>🗑️</button>
                  </div>
                </div>
                {doc.descripcion && <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>{doc.descripcion}</p>}
                <div className="doc-card-meta">
                  <span>🌿 {doc.total_ramas || 0} ramas</span>
                  <span>📎 {doc.total_versiones || 0} versiones</span>
                  <span>👤 {doc.creador_nombre || 'Desconocido'}</span>
                </div>

                {expandedDoc === doc.id && (
                  <div className="branches-section">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <h4 style={{ fontSize: '14px', fontWeight: 600 }}>🌿 Ramas</h4>
                      <button className="btn btn-sm btn-secondary" onClick={() => setShowCreateBranch(doc.id)}>➕ Nueva Rama</button>
                    </div>

                    {(ramas[doc.id] || []).map(rama => (
                      <div key={rama.id}>
                        <div className="branch-item" onClick={() => toggleBranch(rama.id)} style={{ cursor: 'pointer' }}>
                          <div className="branch-name">
                            <span>{expandedBranch === rama.id ? '📂' : '📁'}</span>
                            {rama.nombre}
                            {rama.es_principal === 1 && <span className="branch-main-badge">Principal</span>}
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({rama.total_versiones} versiones)</span>
                          </div>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={(e) => { e.stopPropagation(); setShowUpload(rama.id); }}
                            disabled={lockedByOther}
                          >
                            ⬆️ Subir
                          </button>
                        </div>

                        {expandedBranch === rama.id && (
                          <div className="version-list">
                            {(versiones[rama.id] || []).length === 0 ? (
                              <div style={{ padding: '12px', fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                No hay versiones. Sube el primer archivo.
                              </div>
                            ) : (
                              (versiones[rama.id] || []).map(v => (
                                <div key={v.id} className="version-item">
                                  <div className="version-info">
                                    <div className="version-number">v{v.numero_version} — {v.archivo_nombre}</div>
                                    <div className="version-meta">
                                      {v.mensaje && <span>💬 {v.mensaje} · </span>}
                                      📐 {formatSize(v.archivo_size)} · 👤 {v.subidor_nombre || 'Desconocido'} · 📅 {new Date(v.fecha + 'Z').toLocaleDateString('es-MX')}
                                    </div>
                                  </div>
                                  <button className="btn btn-sm btn-secondary" onClick={() => downloadFile(v.id)}>⬇️ Descargar</button>
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Document Modal */}
      {showCreateDoc && (
        <div className="modal-overlay" onClick={() => setShowCreateDoc(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>📄 Nuevo Documento</h3>
              <button className="modal-close" onClick={() => setShowCreateDoc(false)}>×</button>
            </div>
            <form onSubmit={createDoc}>
              <div className="form-group">
                <label>Nombre del documento *</label>
                <input className="form-input" value={docForm.nombre} onChange={e => setDocForm({ ...docForm, nombre: e.target.value })} placeholder="Ej: Informe de Investigación" required />
              </div>
              <div className="form-group">
                <label>Descripción</label>
                <textarea className="form-textarea" value={docForm.descripcion} onChange={e => setDocForm({ ...docForm, descripcion: e.target.value })} placeholder="Describe el documento..." />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateDoc(false)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">✨ Crear</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Branch Modal */}
      {showCreateBranch && (
        <div className="modal-overlay" onClick={() => setShowCreateBranch(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>🌿 Nueva Rama</h3>
              <button className="modal-close" onClick={() => setShowCreateBranch(null)}>×</button>
            </div>
            <form onSubmit={createBranch}>
              <div className="form-group">
                <label>Nombre de la rama *</label>
                <input className="form-input" value={branchName} onChange={e => setBranchName(e.target.value)} placeholder="Ej: revision-equipo-3" required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowCreateBranch(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">✨ Crear Rama</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload Version Modal */}
      {showUpload && (
        <div className="modal-overlay" onClick={() => setShowUpload(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>⬆️ Subir Nueva Versión</h3>
              <button className="modal-close" onClick={() => setShowUpload(null)}>×</button>
            </div>
            <form onSubmit={uploadFile}>
              <div className="form-group">
                <label>Archivo *</label>
                <input className="form-input" type="file" ref={fileRef} required />
              </div>
              <div className="form-group">
                <label>Mensaje de versión</label>
                <input className="form-input" value={uploadMsg} onChange={e => setUploadMsg(e.target.value)} placeholder="Ej: Correcciones del capítulo 3" />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowUpload(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary">⬆️ Subir Archivo</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
