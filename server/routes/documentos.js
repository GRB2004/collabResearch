import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../database.js';
import { authMiddleware } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

const router = Router();
router.use(authMiddleware);

// GET /api/documentos
router.get('/', (req, res) => {
  try {
    const docs = db.prepare(`
      SELECT d.*, u.nombre as creador_nombre,
        (SELECT COUNT(*) FROM ramas WHERE documento_id = d.id) as total_ramas,
        (SELECT COUNT(*) FROM versiones v JOIN ramas r ON v.rama_id = r.id WHERE r.documento_id = d.id) as total_versiones
      FROM documentos d LEFT JOIN users u ON d.creado_por = u.id ORDER BY d.fecha_creacion DESC
    `).all();
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documentos
router.post('/', (req, res) => {
  try {
    const { nombre, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    const result = db.prepare('INSERT INTO documentos (nombre, descripcion, creado_por) VALUES (?, ?, ?)').run(nombre, descripcion || '', req.user.id);
    // Create main branch
    db.prepare('INSERT INTO ramas (documento_id, nombre, creada_por, es_principal) VALUES (?, ?, ?, 1)').run(result.lastInsertRowid, 'principal', req.user.id);

    db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
      req.user.id, 'documento_creado', `Documento "${nombre}" creado`
    );

    const doc = db.prepare('SELECT * FROM documentos WHERE id = ?').get(result.lastInsertRowid);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/documentos/:id
router.delete('/:id', (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documentos WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

    // Delete files from disk
    const versiones = db.prepare('SELECT v.archivo_path FROM versiones v JOIN ramas r ON v.rama_id = r.id WHERE r.documento_id = ?').all(req.params.id);
    for (const v of versiones) {
      const fp = path.join(uploadsDir, v.archivo_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    db.prepare('DELETE FROM versiones WHERE rama_id IN (SELECT id FROM ramas WHERE documento_id = ?)').run(req.params.id);
    db.prepare('DELETE FROM ramas WHERE documento_id = ?').run(req.params.id);
    db.prepare('DELETE FROM documentos WHERE id = ?').run(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documentos/:id/ramas
router.get('/:id/ramas', (req, res) => {
  try {
    const ramas = db.prepare(`
      SELECT r.*, u.nombre as creador_nombre,
        (SELECT COUNT(*) FROM versiones WHERE rama_id = r.id) as total_versiones
      FROM ramas r LEFT JOIN users u ON r.creada_por = u.id WHERE r.documento_id = ? ORDER BY r.es_principal DESC, r.fecha_creacion ASC
    `).all(req.params.id);
    res.json(ramas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documentos/:id/ramas
router.post('/:id/ramas', (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre de rama requerido' });

    const doc = db.prepare('SELECT * FROM documentos WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

    const existing = db.prepare('SELECT id FROM ramas WHERE documento_id = ? AND nombre = ?').get(req.params.id, nombre);
    if (existing) return res.status(409).json({ error: 'Ya existe una rama con ese nombre' });

    const result = db.prepare('INSERT INTO ramas (documento_id, nombre, creada_por) VALUES (?, ?, ?)').run(req.params.id, nombre, req.user.id);

    db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
      req.user.id, 'rama_creada', `Rama "${nombre}" creada en "${doc.nombre}"`
    );

    const rama = db.prepare('SELECT * FROM ramas WHERE id = ?').get(result.lastInsertRowid);
    res.json(rama);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ramas/:id/versiones
router.get('/ramas/:id/versiones', (req, res) => {
  try {
    const versiones = db.prepare(`
      SELECT v.*, u.nombre as subidor_nombre, u.avatar_color as subidor_color
      FROM versiones v LEFT JOIN users u ON v.subido_por = u.id WHERE v.rama_id = ? ORDER BY v.numero_version DESC
    `).all(req.params.id);
    res.json(versiones);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ramas/:id/versiones — upload file
router.post('/ramas/:id/versiones', upload.single('archivo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });

    const rama = db.prepare('SELECT r.*, d.nombre as doc_nombre FROM ramas r JOIN documentos d ON r.documento_id = d.id WHERE r.id = ?').get(req.params.id);
    if (!rama) return res.status(404).json({ error: 'Rama no encontrada' });

    const lastVersion = db.prepare('SELECT MAX(numero_version) as max_v FROM versiones WHERE rama_id = ?').get(req.params.id);
    const newVersion = (lastVersion.max_v || 0) + 1;

    const result = db.prepare(
      'INSERT INTO versiones (rama_id, numero_version, archivo_path, archivo_nombre, archivo_size, subido_por, mensaje) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, newVersion, req.file.filename, req.file.originalname, req.file.size, req.user.id, req.body.mensaje || '');

    db.prepare('INSERT INTO actividad (usuario_id, tipo_accion, descripcion) VALUES (?, ?, ?)').run(
      req.user.id, 'version_subida', `Versión ${newVersion} subida a "${rama.doc_nombre}" (rama: ${rama.nombre})`
    );

    const version = db.prepare('SELECT * FROM versiones WHERE id = ?').get(result.lastInsertRowid);
    res.json(version);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/versiones/:id/descargar
router.get('/versiones/:id/descargar', (req, res) => {
  try {
    const version = db.prepare('SELECT * FROM versiones WHERE id = ?').get(req.params.id);
    if (!version) return res.status(404).json({ error: 'Versión no encontrada' });

    const filePath = path.join(uploadsDir, version.archivo_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo no encontrado en disco' });

    res.download(filePath, version.archivo_nombre);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
