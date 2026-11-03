const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { Storage } = require('@google-cloud/storage');
const path = require('path');

const app = express();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // Límite de 20 MB por archivo

// Configuración de PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST, // En Cloud Run usaremos '/cloudsql/INSTANCE_CONNECTION_NAME'
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
});

// Configuración de Cloud Storage
const storage = new Storage();
const BUCKET_NAME = process.env.BUCKET_NAME;

app.use(express.json());
app.use(express.static('public'));

// Inicialización de la base de datos (crear tabla de denuncias)
async function initDb() {
  const queryText = `
    CREATE TABLE IF NOT EXISTS denuncias (
      numero VARCHAR(50) PRIMARY KEY,
      recibida TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      canal VARCHAR(50),
      estado VARCHAR(50) DEFAULT 'Recibida',
      notas TEXT,
      datos JSONB NOT NULL
    );
  `;
  try {
    await pool.query(queryText);
    console.log('Tabla "denuncias" verificada/creada correctamente.');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err);
  }
}
initDb();

// Endpoint para guardar nuevas denuncias
app.post('/api/denuncias', upload.array('adjuntos', 10), async (req, res) => {
  try {
    const rawData = req.body.payload ? JSON.parse(req.body.payload) : req.body;
    const files = req.files || [];
    const adjuntosInfo = [];

    // 1. Subir archivos a Cloud Storage
    for (const file of files) {
      const gcsFileName = `adjuntos/${Date.now()}-${path.basename(file.originalname)}`;
      const bucketFile = storage.bucket(BUCKET_NAME).file(gcsFileName);

      await bucketFile.save(file.buffer, {
        contentType: file.mimetype,
        metadata: { originalName: file.originalname }
      });

      adjuntosInfo.push({
        nombre: file.originalname,
        tipo: file.mimetype,
        gcsPath: `gs://${BUCKET_NAME}/${gcsFileName}`,
        url: `https://storage.googleapis.com/${BUCKET_NAME}/${gcsFileName}`
      });
    }

    // Unir los adjuntos subidos al objeto del formulario
    const denunciaCompleta = {
      ...rawData,
      adjuntos: adjuntosInfo
    };

    // 2. Guardar el JSON completo en PostgreSQL usando JSONB
    const query = `
      INSERT INTO denuncias (numero, canal, estado, notas, datos)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (numero) DO UPDATE SET datos = EXCLUDED.datos;
    `;
    const values = [
      denunciaCompleta.numero,
      denunciaCompleta.canal || 'Formulario web',
      denunciaCompleta.estado || 'Recibida',
      denunciaCompleta.notas || '',
      JSON.stringify(denunciaCompleta)
    ];

    await pool.query(query, values);

    res.status(200).json({
      success: true,
      numero: denunciaCompleta.numero,
      message: 'Denuncia registrada correctamente'
    });

  } catch (error) {
    console.error('Error procesando la denuncia:', error);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// Endpoint opcional para consultar denuncias
app.get('/api/denuncias', async (req, res) => {
  try {
    const result = await pool.query('SELECT datos FROM denuncias ORDER BY recibida DESC');
    const rows = result.rows.map(r => r.datos);
    res.json(rows);
  } catch (error) {
    console.error('Error al consultar denuncias:', error);
    res.status(500).json({ error: 'Error en la base de datos' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});
