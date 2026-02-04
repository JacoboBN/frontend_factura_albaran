const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const Store = require('electron-store');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { spawn } = require('child_process');

const WATCH_SUBFOLDERS = ['Albaranes', 'Facturas'];
const WATCHED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.txt'];
const EMAIL_RECIPIENT = 'bgoptimizing@gmail.com';

// Configurar logging para actualizaciones
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;

// URL del backend en Render (siempre usa esta URL ya que el backend está en producción)
const BACKEND_URL = 'https://backend-factura-albaran.onrender.com';
const DEFAULT_TIMEOUT_MS = 20000;
const OCR_RETRY_ATTEMPTS = 2;
const OCR_RETRY_DELAY_MS = 2000;

const ANALYZE_ENDPOINTS = {
  albaran: '/analyze/document/albaran',
  factura: '/analyze/document/factura'
};

function normalizeDocumentType(value) {
  const normalized = (value || '').toString().toLowerCase();
  if (normalized.includes('factura')) return 'factura';
  return 'albaran';
}

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
}

function extractAnalysisSections(analysisText) {
  if (!analysisText) return null;
  const text = analysisText.toString();
  const markerArticulosFactura = '=== ARTÍCULOS POR ALBARÁN (JSON Lines) ===';
  const markerArticulosAlbaran = '=== ARTÍCULOS (JSON Lines) ===';
  const markerResumenFactura = '=== RESUMEN FACTURA (JSON) ===';
  const markerResumenAlbaran = '=== RESUMEN ALBARÁN (JSON) ===';

  const isFactura = text.includes(markerResumenFactura) || text.includes(markerArticulosFactura);
  const articulosMarker = isFactura ? markerArticulosFactura : markerArticulosAlbaran;
  const resumenMarker = isFactura ? markerResumenFactura : markerResumenAlbaran;

  if (!text.includes(articulosMarker) || !text.includes(resumenMarker)) {
    return null;
  }

  const articulosSplit = text.split(articulosMarker);
  if (articulosSplit.length < 2) return null;
  const afterArticulos = articulosSplit[1];
  const resumenSplit = afterArticulos.split(resumenMarker);
  if (resumenSplit.length < 2) return null;

  return {
    articulosRaw: resumenSplit[0].trim(),
    resumenRaw: resumenSplit[1].trim(),
    isFactura
  };
}

function normalizeArticleName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonLines(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function appendSourceToJsonLines(text, sourceFileName) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const updated = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    try {
      const obj = JSON.parse(trimmed);
      obj.source_file = sourceFileName || null;
      return JSON.stringify(obj);
    } catch (e) {
      return line;
    }
  });
  return updated.join('\n');
}

function appendSourceToJsonObject(text, sourceFileName) {
  if (!text) return text;
  try {
    const obj = JSON.parse(text.trim());
    obj.source_file = sourceFileName || null;
    return JSON.stringify(obj);
  } catch (e) {
    return text;
  }
}

function parseFacturaAnalysis(analysisText) {
  const sections = extractAnalysisSections(analysisText);
  if (!sections || !sections.isFactura) return null;

  const articulos = parseJsonLines(sections.articulosRaw);
  const resumenLine = sections.resumenRaw.split(/\r?\n/).find(line => line.trim());
  let resumenObj = null;
  if (resumenLine) {
    try {
      resumenObj = JSON.parse(resumenLine);
    } catch (e) {
      resumenObj = null;
    }
  }

  let albaranNumbers = Array.isArray(resumenObj?.num_albaran) ? resumenObj.num_albaran : [];
  if (!albaranNumbers.length) {
    albaranNumbers = [...new Set(articulos.map(item => item.num_albaran).filter(Boolean))];
  }

  return {
    articulos,
    resumen: resumenObj,
    albaranNumbers
  };
}

function aggregateArticles(lines, mode = 'factura') {
  const map = new Map();
  lines.forEach(item => {
    const key = normalizeArticleName(item.articulo);
    if (!key) return;
    const quantity = Number(
      mode === 'factura'
        ? (item.kg ?? item.unidades ?? item.bulto ?? 0)
        : (item.kg ?? item.bulto ?? 0)
    );
    const importe = Number(item.importe ?? 0);
    const current = map.get(key) || { quantity: 0, importe: 0 };
    current.quantity += Number.isFinite(quantity) ? quantity : 0;
    current.importe += Number.isFinite(importe) ? importe : 0;
    map.set(key, current);
  });
  return map;
}

function numbersClose(a, b, tolerance) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

function compareArticleMaps(facturaMap, albaranMap) {
  const issues = [];
  const qtyTolerance = 0.01;
  const importeTolerance = 0.5;

  facturaMap.forEach((fact, key) => {
    const alb = albaranMap.get(key);
    if (!alb) {
      issues.push(`Artículo en factura no encontrado en albarán: ${key}`);
      return;
    }
    if (!numbersClose(fact.quantity, alb.quantity, qtyTolerance)) {
      issues.push(`Cantidad distinta para ${key}: factura=${fact.quantity}, albarán=${alb.quantity}`);
    }
    if (!numbersClose(fact.importe, alb.importe, importeTolerance)) {
      issues.push(`Importe distinto para ${key}: factura=${fact.importe}, albarán=${alb.importe}`);
    }
  });

  albaranMap.forEach((alb, key) => {
    if (!facturaMap.has(key)) {
      issues.push(`Artículo en albarán no encontrado en factura: ${key}`);
    }
  });

  return issues;
}

function buildTxtFilesFromAnalysis(analysisText, sourceFileName = null) {
  const sections = extractAnalysisSections(analysisText);
  if (!sections) return null;

  const { articulosRaw, resumenRaw, isFactura } = sections;
  const resumenLine = resumenRaw.split(/\r?\n/).find(line => line.trim());
  let resumenObj = null;
  let firstArticuloObj = null;

  if (resumenLine) {
    try {
      resumenObj = JSON.parse(resumenLine);
    } catch (e) {
      resumenObj = null;
    }
  }

  const firstArticuloLine = articulosRaw.split(/\r?\n/).find(line => line.trim());
  if (firstArticuloLine) {
    try {
      firstArticuloObj = JSON.parse(firstArticuloLine);
    } catch (e) {
      firstArticuloObj = null;
    }
  }

  const docNum = isFactura
    ? (resumenObj?.num_factura || firstArticuloObj?.num_factura)
    : (resumenObj?.num_albaran || firstArticuloObj?.num_albaran);

  const safeNum = sanitizeFileName(docNum || 'SinNumero');
  const suffix = isFactura ? 'Fact' : 'Alb';
  const files = [];

  const enrichedArticulos = appendSourceToJsonLines(articulosRaw, sourceFileName);
  const enrichedResumen = resumenLine ? appendSourceToJsonObject(resumenLine, sourceFileName) : resumenLine;

  if (enrichedArticulos) {
    files.push({
      name: `${safeNum}${suffix}.txt`,
      content: enrichedArticulos
    });
  }

  if (enrichedResumen) {
    files.push({
      name: `Total${safeNum}${suffix}.txt`,
      content: enrichedResumen
    });
  }

  return { files, isFactura };
}

function getAnalyzeEndpoint(docType) {
  const key = normalizeDocumentType(docType);
  const endpoint = ANALYZE_ENDPOINTS[key] || ANALYZE_ENDPOINTS.albaran;
  return `${BACKEND_URL}${endpoint}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  const code = error?.code || '';
  const status = error?.response?.status;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    (status && status >= 500)
  );
}

async function postWithRetry(url, data, options = {}) {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? 3000;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const axiosOptions = options.axiosOptions || {};

  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await axios.post(url, data, { timeout, ...axiosOptions });
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error)) {
        throw error;
      }
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

async function uploadLocalFileToDrive(sessionId, filePath, targetFolderId) {
  const formData = new FormData();
  formData.append('sessionId', sessionId);
  if (targetFolderId) {
    formData.append('targetFolderId', targetFolderId);
  }
  formData.append('file', fs.createReadStream(filePath));

  const response = await axios.post(`${BACKEND_URL}/drive/upload`, formData, {
    headers: {
      ...formData.getHeaders()
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  return response.data;
}

async function uploadGeneratedTxtFiles(targetFolderId, analysisText, sourceFileName = null) {
  const sessionId = store.get('sessionId');
  if (!sessionId || !targetFolderId) return;

  const payload = buildTxtFilesFromAnalysis(analysisText, sourceFileName);
  if (!payload || !payload.files.length) return;

  const tempDir = path.join(app.getPath('temp'), 'ia-json');
  fs.mkdirSync(tempDir, { recursive: true });

  for (const file of payload.files) {
    const safeName = sanitizeFileName(file.name);
    const tempPath = path.join(tempDir, safeName);
    fs.writeFileSync(tempPath, file.content || '', 'utf8');

    try {
      await uploadLocalFileToDrive(sessionId, tempPath, targetFolderId);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

async function waitForFileReady(filePath, attempts = 8, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        return true;
      }
    } catch (e) {
      // ignore until file exists
    }
    await sleep(delayMs);
  }
  return false;
}

async function performLocalOCRWithRetry(filePath, mimeType, originalName) {
  let attempt = 0;
  while (attempt <= OCR_RETRY_ATTEMPTS) {
    try {
      return await performLocalOCR(filePath, mimeType, originalName);
    } catch (error) {
      if (attempt >= OCR_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(OCR_RETRY_DELAY_MS);
      attempt += 1;
    }
  }
}

// Helper function to get binary paths
function getBinaryPaths() {
  // In production, binaries are in process.resourcesPath/bin
  // In development, they are in the assets folder
  const isPackaged = app.isPackaged;
  const basePath = isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'assets', 'bin', 'win');

  const buildPath = isPackaged
    ? path.join(process.resourcesPath, 'ocr')
    : path.join(__dirname, 'ocr');

  return {
    tesseract: path.join(basePath, 'tesseract', 'tesseract.exe'),
    tessdata: path.join(basePath, 'tesseract', 'tessdata'),
    pdftoppm: path.join(basePath, 'poppler', 'pdftoppm.exe'),
    ocr: path.join(buildPath,  'ocr.exe')
    // ocr: path.join(buildPath, 'ocr', 'ocr.exe')
  };
}

// Local OCR function using ocr.exe from build folder
async function performLocalOCR(filePath, mimeType, originalName) {
  return new Promise((resolve, reject) => {
    const binPaths = getBinaryPaths();
    const ocrExePath = binPaths.ocr;

    // Verify ocr.exe exists
    if (!fs.existsSync(ocrExePath)) {
      reject(new Error(`OCR executable not found at: ${ocrExePath}`));
      return;
    }

    const ocrProcess = spawn(ocrExePath, [filePath]);

    let stdout = '';
    let stderr = '';

    ocrProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ocrProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ocrProcess.on('close', (code) => {
      if (code !== 0) {
        const message = stderr || 'OCR failed with no stderr output';
        reject(new Error(`OCR failed: ${message}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(new Error('Invalid JSON output from OCR'));
        }
      }
    });
  });
}

const store = new Store();
let mainWindow;
let windowReadyResolve;
const windowReadyPromise = new Promise((resolve) => {
  windowReadyResolve = resolve;
});
const startupScanState = {
  inProgress: false,
  completed: false,
  waitingForSession: false
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  mainWindow.loadFile('user.html');

  mainWindow.webContents.once('did-finish-load', () => {
    if (windowReadyResolve) {
      windowReadyResolve();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // Verificar actualizaciones disponibles
  autoUpdater.checkForUpdatesAndNotify();

  // Event listeners para actualizaciones
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available', info);
  });

  autoUpdater.on('error', (err) => {
    log.error('Updater error', err);
  });

  autoUpdater.on('download-progress', (p) => {
    log.info('Download progress', p);
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('Update downloaded; will install now');
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Reiniciar ahora', 'Luego'],
        title: 'Actualización lista',
        message: 'Se descargó una actualización. ¿Quieres reiniciar para instalarla?'
      })
      .then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
      });
  });

  // El escaneo de "No procesado" se lanzará desde el renderer tras iniciar sesión.
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Iniciar proceso de login
ipcMain.handle('google-login', async (event, isUser = false) => {
  try {
    // Obtener URL de autenticación del backend
    const response = await axios.get(`${BACKEND_URL}/auth/url`, {
      params: { isUser }
    });
    
    const { authUrl, sessionId } = response.data;
    
    // Guardar sessionId
    store.set('sessionId', sessionId);
    
    // Abrir navegador externo para login
    await shell.openExternal(authUrl);
    
    // Esperar a que el usuario complete el login (polling)
    return await waitForAuth(sessionId);
    
  } catch (error) {
    console.error('Error en login:', error);
    throw new Error('Error al iniciar sesión con Google');
  }
});

// Función para esperar autenticación
async function waitForAuth(sessionId, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos
    
    try {
      const response = await axios.post(`${BACKEND_URL}/auth/verify`, {
        sessionId
      });
      
      if (response.data.email) {
        return response.data;
      }
    } catch (error) {
      // Continuar esperando
    }
  }
  
  throw new Error('Timeout: No se completó la autenticación');
}

// Crear carpeta compartida
ipcMain.handle('create-shared-folder', async () => {
  const sessionId = store.get('sessionId');
  
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
      sessionId
    });
    
    return response.data;
  } catch (error) {
    console.error('Error creando carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al crear carpeta');
  }
});

// Compartir carpeta con usuarios (acepta folderId opcional)
ipcMain.handle('share-folder', async (event, emails, folderId = null) => {
  const sessionId = store.get('sessionId');
  
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/share-folder`, {
      sessionId,
      emails,
      folderId
    });
    
    return response.data;
  } catch (error) {
    console.error('Error compartiendo carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al compartir carpeta');
  }
});

// Subir archivo
ipcMain.handle('upload-file', async (event, filePath, targetFolderId = null) => {
  const sessionId = store.get('sessionId');

  try {
    // Encontrar o crear la carpeta "Albaranes/No procesado" si no hay destino
    const uploadFolderId = targetFolderId || await getOrCreateAlbaranesNoProcesadoFolder(sessionId);

    // Support single filePath string or array of paths
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    const results = [];

    for (const p of paths) {
      const formData = new FormData();
      formData.append('sessionId', sessionId);
      formData.append('targetFolderId', uploadFolderId);
      formData.append('file', fs.createReadStream(p));

      const response = await axios.post(`${BACKEND_URL}/drive/upload`, formData, {
        headers: {
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      results.push(response.data);
    }

    return results.length === 1 ? results[0] : results;
  } catch (error) {
    console.error('Error subiendo archivo:', error);
    throw new Error(error.response?.data?.error || 'Error al subir archivo');
  }
});

// Seleccionar archivo
ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Todos los archivos', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths; // return array of paths
  }
  return null;
});

// Listar carpetas disponibles en Drive para la sesión
ipcMain.handle('list-folders', async () => {
  const sessionId = store.get('sessionId');
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/list-folders`, { sessionId });
    return response.data.folders || [];
  } catch (error) {
    console.error('Error listando carpetas:', error);
    return [];
  }
});

// Listar contenido de una carpeta (carpetas y archivos)
ipcMain.handle('list-contents', async (event, folderId = null) => {
  const sessionId = store.get('sessionId');
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId });
    return response.data;
  } catch (error) {
    console.error('Error listando contenido:', error);
    return { files: [], folderId: null };
  }
});

// Abrir URL externa
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (e) {
    console.error('Error abriendo URL externa:', e);
    return false;
  }
});

// Crear carpeta en Drive
ipcMain.handle('create-folder', async (event, name, parentId = null) => {
  const sessionId = store.get('sessionId');
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name, parentId });
    return response.data;
  } catch (error) {
    console.error('Error creando carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al crear carpeta');
  }
});

// Obtener contenido de database.sql desde Drive (Mi unidad/Bases de datos)
ipcMain.handle('get-drive-database-sql', async () => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para cargar la base de datos');
  }

  const rootContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: 'root'
  });
  const rootFolders = (rootContents.data?.files || [])
    .filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  const basesFolder = rootFolders.find(folder => (folder.name || '').toLowerCase() === 'bases de datos');
  if (!basesFolder) {
    throw new Error('No se encontró la carpeta "Bases de datos" en Mi unidad');
  }

  const basesContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: basesFolder.id
  });
  const files = (basesContents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder');
  const dbFile = files.find(item => (item.name || '').toLowerCase() === 'database.sql');
  if (!dbFile) {
    throw new Error('No se encontró el archivo database.sql en Bases de datos');
  }

  const sqlText = await downloadDriveFileToString(dbFile);
  if (!sqlText) {
    throw new Error('El archivo database.sql está vacío o no se pudo leer');
  }

  return { sqlText, fileName: dbFile.name, fileId: dbFile.id };
});

// Elegir carpeta para un archivo usando diálogos nativos (evita prompt())
ipcMain.handle('choose-folder', async (event, fileName) => {
  const sessionId = store.get('sessionId');
  try {
    const resp = await postWithRetry(`${BACKEND_URL}/drive/list-folders`, { sessionId });
    const folders = resp.data.folders || [];

    const buttons = folders.map(f => f.name).slice(0, 20); // limit buttons for UI
    buttons.push('Crear nueva');
    buttons.push('Cancelar');

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      message: `Selecciona carpeta para ${fileName}`
    });

    if (response === buttons.length - 1) {
      return null; // cancel
    }

    if (response === buttons.length - 2) {
      // Crear nueva carpeta: pedir nombre en una ventana modal (no crear en disco)
      const newName = await promptForFolderName(`DriveShare - ${new Date().toLocaleString()}`);
      if (!newName) return null;
      const created = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: newName });
      return created.data.folderId;
    }

    // Selección de carpeta existente
    return folders[response].id;
  } catch (error) {
    console.error('Error en choose-folder:', error);
    return null;
  }
});

// Modal simple para pedir nombre de carpeta (devuelve string o null)
function promptForFolderName(defaultName) {
  return new Promise((resolve) => {
    const modal = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 420,
      height: 150,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    const safeDefault = String(defaultName).replace(/"/g, '&quot;');
    const html = `<!doctype html><html><body style="font-family: sans-serif; padding:12px;">
      <h3>Nombre de la nueva carpeta</h3>
      <input id="name" style="width:100%; font-size:14px; padding:6px;" value="${safeDefault}" />
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
        <button id="cancel">Cancelar</button>
        <button id="ok">Crear</button>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        document.getElementById('ok').addEventListener('click', () => {
          ipcRenderer.send('new-folder-name', document.getElementById('name').value || '');
        });
        document.getElementById('cancel').addEventListener('click', () => {
          ipcRenderer.send('new-folder-name', null);
        });
        window.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') ipcRenderer.send('new-folder-name', document.getElementById('name').value || '');
          if (e.key === 'Escape') ipcRenderer.send('new-folder-name', null);
        });
      </script>
    </body></html>`;

    ipcMain.once('new-folder-name', (ev, name) => {
      resolve(name);
      try { modal.close(); } catch (e) {}
    });

    modal.removeMenu();
    modal.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

// Obtener información de la sesión
ipcMain.handle('get-user-info', async () => {
  const sessionId = store.get('sessionId');
  
  if (!sessionId) {
    return null;
  }
  
  try {
    const response = await postWithRetry(`${BACKEND_URL}/session/info`, {
      sessionId
    });
    
    return response.data;
  } catch (error) {
    return null;
  }
});

ipcMain.handle('scan-no-procesado', async () => {
  await scanNoProcesado('login');
  return { success: true };
});

ipcMain.handle('ensure-standard-folders', async () => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para crear carpetas');
  }
  return ensureStandardFolders();
});

// Generar link para usuarios
ipcMain.handle('get-user-link', () => {
  // En producción, esta sería la URL de descarga del instalador con parámetro
  // Por ahora retornamos instrucción
  return 'https://tu-sitio.com/DriveShare-Setup.exe?mode=user';
});

// Función para encontrar o crear la carpeta "Albaranes/No procesado"
async function getOrCreateAlbaranesNoProcesadoFolder(sessionId) {
  try {
    // Listar carpetas en la raíz
    const rootFoldersResp = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: 'root' });
    const rootFolders = rootFoldersResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let albaranesFolder = rootFolders.find(f => f.name === 'Albaranes');

    if (!albaranesFolder) {
      // Crear "Albaranes"
    const createResp = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'Albaranes' });
      albaranesFolder = { id: createResp.data.folderId };
    }

    // Listar contenido de "Albaranes"
    const albaranesContentsResp = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: albaranesFolder.id });
    const albaranesContents = albaranesContentsResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let noProcesadoFolder = albaranesContents.find(f => f.name === 'No procesado');

    if (!noProcesadoFolder) {
      // Crear "No procesado" dentro de "Albaranes"
      const createResp = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'No procesado', parentId: albaranesFolder.id });
      noProcesadoFolder = { id: createResp.data.folderId };
    }

    return noProcesadoFolder.id;
  } catch (error) {
    console.error('Error finding or creating Albaranes/No procesado folder:', error);
    throw new Error('Error al encontrar o crear carpeta Albaranes/No procesado');
  }
}

// Analyze document with local OCR and AI analysis
ipcMain.handle('analyze-document', async (event, filePath, mimeType, originalName, docType = 'albaran') => {
  const sessionId = store.get('sessionId');

  try {
    // Perform local OCR
    const ocrResult = await performLocalOCR(filePath, mimeType, originalName);

    // Send extracted text to backend for AI analysis
    const response = await postWithRetry(getAnalyzeEndpoint(docType), {
      text: ocrResult.text,
      quality: ocrResult.quality,
      sessionId: sessionId
    });

    return response.data;
  } catch (error) {
    console.error('Error analyzing document:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar el documento');
  }
});

ipcMain.handle('ocr-document', async (event, filePath, mimeType, originalName) => {
  try {
    return await performLocalOCR(filePath, mimeType, originalName);
  } catch (error) {
    console.error('Error en OCR:', error);
    throw new Error(error.message || 'Error en OCR');
  }
});

ipcMain.handle('analyze-text', async (event, text, quality = 0.5, docType = 'albaran') => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para analizar texto');
  }

  try {
    const response = await postWithRetry(getAnalyzeEndpoint(docType), {
      text,
      quality,
      sessionId
    });
    return response.data;
  } catch (error) {
    console.error('Error analizando texto:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar texto');
  }
});


// Mover archivo en Drive (agregar/quitar padres)
ipcMain.handle('move-file', async (event, fileId, addParents = [], removeParents = []) => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para mover archivo');
  }
  if (!fileId) {
    throw new Error('fileId requerido para mover archivo');
  }

  const addList = Array.isArray(addParents) ? addParents : (addParents ? [addParents] : []);
  const removeList = Array.isArray(removeParents) ? removeParents : (removeParents ? [removeParents] : []);

  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/move`, {
      sessionId,
      fileId,
      addParents: addList,
      removeParents: removeList
    });
    return response.data;
  } catch (error) {
    console.error('Error moviendo archivo:', error);
    throw new Error(error.response?.data?.error || 'Error al mover archivo');
  }
});

function isAllowedExtension(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return WATCHED_EXTENSIONS.includes(ext);
}


function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch (e) {
    log.warn(`No se pudo enviar evento ${channel}:`, e);
  }
}

async function waitForWindowReady() {
  try {
    await windowReadyPromise;
  } catch (e) {
    // ignore
  }
}

async function processNoProcesadoFileWithEvents(fileMeta, queueId) {
  const fileName = fileMeta.name || 'Archivo';

  emitToRenderer('queue-event', { type: 'init', id: queueId, fileName, source: 'startup' });
  emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'OCR' });

  const { localPath, mimeType } = await downloadDriveFileToTemp(fileMeta, fileName);
  const ready = await waitForFileReady(localPath);
  if (!ready) {
    throw new Error('Archivo descargado no disponible para OCR');
  }
  const ocrResult = await performLocalOCRWithRetry(localPath, mimeType, fileName);

  try {
    if (localPath && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  } catch (cleanupError) {
    log.warn('No se pudo limpiar archivo temporal descargado:', cleanupError);
  }

  emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'IA' });
  const docType = normalizeDocumentType(fileMeta?.sourceRoot);
  const analysisResult = await postWithRetry(getAnalyzeEndpoint(docType), {
    text: ocrResult.text,
    quality: ocrResult.quality,
    sessionId: store.get('sessionId')
  }).then(res => res.data);

  emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Enviando' });

  // Sin envío de email: se eliminó notificación por JSON

  try {
    const rootName = fileMeta.sourceRoot || '';
    if (rootName) {
      const noComparado = await getOrCreateNoComparadoFolder(rootName);
      await uploadGeneratedTxtFiles(noComparado.id, analysisResult.analysis || '', fileName);
      await postWithRetry(`${BACKEND_URL}/drive/move`, {
        sessionId: store.get('sessionId'),
        fileId: fileMeta.id,
        addParents: [noComparado.id],
        removeParents: fileMeta.noProcesadoId ? [fileMeta.noProcesadoId] : []
      });
    }
  } catch (moveError) {
    log.warn('No se pudo mover archivo a No comparado:', moveError);
  }

  emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Enviado' });
}

async function downloadDriveFileToTemp(fileMeta, fallbackName) {
  const sessionId = store.get('sessionId');
  const attempts = 2;
  let lastError;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const downloadResponse = await postWithRetry(
        `${BACKEND_URL}/drive/download`,
        { sessionId, fileId: fileMeta.id },
        { timeout: 60000, axiosOptions: { responseType: 'stream' } }
      );

      const mimeType = decodeURIComponent(downloadResponse.headers['content-type'] || '');
      const localPath = await saveDownloadedFileToTemp(downloadResponse, fallbackName);
      const stats = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
      if (!stats || stats.size === 0) {
        throw new Error('Descarga completada pero el archivo está vacío');
      }

      return { localPath, mimeType };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(2000);
    }
  }

  throw lastError || new Error('No se pudo descargar archivo de Drive');
}

async function saveDownloadedFileToTemp(downloadResponse, fallbackName) {
  const tempDir = path.join(app.getPath('temp'), 'drive-downloads');
  fs.mkdirSync(tempDir, { recursive: true });
  const headerName = downloadResponse.headers['x-file-name'];
  const safeName = decodeURIComponent(headerName || fallbackName || 'documento').replace(/[\\/]/g, '_');
  const localPath = path.join(tempDir, `${Date.now()}-${safeName}`);

  if (downloadResponse.data && typeof downloadResponse.data.pipe === 'function') {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(localPath);
      downloadResponse.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return localPath;
  }

  if (Buffer.isBuffer(downloadResponse.data)) {
    fs.writeFileSync(localPath, downloadResponse.data);
    return localPath;
  }

  throw new Error('Descarga inválida desde Drive');
}

async function getDriveFolderByName(parentId, name) {
  const res = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: parentId || null
  });

  const folders = (res.data?.files || []).filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  return folders.find(folder => (folder.name || '').toLowerCase() === name.toLowerCase()) || null;
}

async function getOrCreateChildFolder(parentId, childName) {
  const existing = await getDriveFolderByName(parentId, childName);
  if (existing) {
    return existing;
  }

  const created = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
    sessionId: store.get('sessionId'),
    name: childName,
    parentId
  });

  return { id: created.data.folderId, name: created.data.folderName || childName };
}

async function getOrCreateNoComparadoFolder(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) {
    throw new Error(`No se encontró la carpeta "${rootFolderName}" en Drive`);
  }

  return getOrCreateChildFolder(rootFolder.id, 'No comparado');
}

async function ensureRootFolderWithChildren(rootName, childNames) {
  const created = [];
  let rootFolder = await getDriveFolderByName(null, rootName);
  if (!rootFolder) {
    const createdRoot = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
      sessionId: store.get('sessionId'),
      name: rootName,
      parentId: null
    });
    rootFolder = { id: createdRoot.data.folderId, name: createdRoot.data.folderName || rootName };
    created.push(rootName);
  }

  const ensuredChildren = {};
  for (const childName of childNames) {
    const existing = await getDriveFolderByName(rootFolder.id, childName);
    if (!existing) {
      created.push(`${rootName}/${childName}`);
    }
    ensuredChildren[childName] = existing || await getOrCreateChildFolder(rootFolder.id, childName);
  }

  return { rootFolder, children: ensuredChildren, created };
}

async function ensureStandardFolders() {
  const childNames = ['No procesado', 'No comparado', 'Documentos'];
  const albaranes = await ensureRootFolderWithChildren('Albaranes', childNames);
  const facturas = await ensureRootFolderWithChildren('Facturas', childNames);
  const created = [...albaranes.created, ...facturas.created];
  return { albaranes, facturas, created };
}

async function getOrCreateDocumentosFolder(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) {
    throw new Error(`No se encontró la carpeta "${rootFolderName}" en Drive`);
  }

  return getOrCreateChildFolder(rootFolder.id, 'Documentos');
}

async function moveDriveFileToFolder(fileMeta, targetFolderId, currentFolderId) {
  if (!fileMeta?.id || !targetFolderId) return;
  await postWithRetry(`${BACKEND_URL}/drive/move`, {
    sessionId: store.get('sessionId'),
    fileId: fileMeta.id,
    addParents: [targetFolderId],
    removeParents: currentFolderId ? [currentFolderId] : []
  });
}

async function moveAlbaranAssetsToDocumentos({
  albaranNum,
  albaranTxt,
  albaranLines,
  noComparadoFolderId,
  documentosFolderId
}) {
  if (!albaranTxt || !documentosFolderId || !noComparadoFolderId) return;

  await moveDriveFileToFolder(albaranTxt, documentosFolderId, noComparadoFolderId);

  const totalName = `Total${albaranNum}Alb.txt`;
  const totalFiles = await findDriveFileInFolder(noComparadoFolderId, totalName);
  const totalTxt = totalFiles.find(file => (file.name || '').toLowerCase() === totalName.toLowerCase());
  if (totalTxt) {
    await moveDriveFileToFolder(totalTxt, documentosFolderId, noComparadoFolderId);
  }

  const sourceFileName = albaranLines.find(item => item?.source_file)?.source_file;
  if (sourceFileName) {
    const sourceFiles = await findDriveFileInFolder(noComparadoFolderId, sourceFileName);
    const sourceFile = sourceFiles.find(file => (file.name || '').toLowerCase() === sourceFileName.toLowerCase());
    if (sourceFile) {
      await moveDriveFileToFolder(sourceFile, documentosFolderId, noComparadoFolderId);
    }
  }
}

async function findDriveFileInFolder(folderId, nameIncludes) {
  const contents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId
  });

  const files = (contents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
    .filter(item => (item.name || '').toLowerCase().includes((nameIncludes || '').toLowerCase()));

  return files;
}

async function downloadDriveFileToString(fileMeta) {
  const { localPath } = await downloadDriveFileToTemp(fileMeta, fileMeta.name);
  const text = fs.readFileSync(localPath, 'utf8');
  try {
    fs.unlinkSync(localPath);
  } catch (e) {}
  return text;
}

async function compareFacturaWithAlbaranes({ facturaAnalysisText, rootFolderName }) {
  const parsed = parseFacturaAnalysis(facturaAnalysisText);
  if (!parsed || !parsed.albaranNumbers.length) {
    return { ok: true, message: 'No se detectaron albaranes en la factura.', issues: [], matchedAlbaranes: [], expectedAlbaranes: [] };
  }

  const albaranesRoot = await getDriveFolderByName(null, 'Albaranes');
  if (!albaranesRoot) {
    return { ok: false, message: 'No se encontró la carpeta "Albaranes" en Drive.', issues: [] };
  }

  const noComparadoFolder = await getDriveFolderByName(albaranesRoot.id, 'No comparado');
  if (!noComparadoFolder) {
    return { ok: false, message: 'No se encontró carpeta No comparado en Drive.', issues: [], matchedAlbaranes: [], expectedAlbaranes: parsed.albaranNumbers };
  }

  const documentosFolder = await getOrCreateDocumentosFolder('Albaranes');

  const facturaArticulos = parsed.articulos || [];
  const facturaByAlbaran = new Map();
  facturaArticulos.forEach(item => {
    const num = item.num_albaran;
    if (!num) return;
    const list = facturaByAlbaran.get(num) || [];
    list.push(item);
    facturaByAlbaran.set(num, list);
  });

  const overallIssues = [];
  const matchedAlbaranes = [];

  for (const albaranNum of parsed.albaranNumbers) {
    const expectedName = `${albaranNum}Alb.txt`.toLowerCase();
    const albaranFiles = await findDriveFileInFolder(noComparadoFolder.id, expectedName);
    const albaranTxt = albaranFiles.find(file => (file.name || '').toLowerCase() === expectedName)
      || albaranFiles.find(file => (file.name || '').toLowerCase().endsWith('alb.txt'))
      || albaranFiles[0];

    if (!albaranTxt) {
      overallIssues.push(`No se encontró .txt del albarán ${albaranNum} en No comparado.`);
      continue;
    }

    const albaranText = await downloadDriveFileToString(albaranTxt);
    const albaranLines = parseJsonLines(albaranText);
    const facturaLinesForAlbaran = facturaByAlbaran.get(albaranNum) || [];

    if (!facturaLinesForAlbaran.length) {
      overallIssues.push(`No hay artículos de la factura para el albarán ${albaranNum}.`);
      continue;
    }

    const facturaMap = aggregateArticles(facturaLinesForAlbaran, 'factura');
    const albaranMap = aggregateArticles(albaranLines, 'albaran');
    const issues = compareArticleMaps(facturaMap, albaranMap);
    if (issues.length) {
      overallIssues.push(`Albarán ${albaranNum}:`, ...issues.map(issue => ` - ${issue}`));
    }

    try {
      await moveAlbaranAssetsToDocumentos({
        albaranNum,
        albaranTxt,
        albaranLines,
        noComparadoFolderId: noComparadoFolder.id,
        documentosFolderId: documentosFolder.id
      });
    } catch (moveError) {
      log.warn(`No se pudo mover albarán ${albaranNum} a Documentos:`, moveError);
    }
    matchedAlbaranes.push(albaranNum);
  }

  if (!overallIssues.length) {
    return { ok: true, message: 'No se encontraron incongruencias.', issues: [], matchedAlbaranes, expectedAlbaranes: parsed.albaranNumbers };
  }

  return {
    ok: false,
    message: `Incongruencias encontradas en ${overallIssues.length} línea(s).`,
    issues: overallIssues,
    matchedAlbaranes,
    expectedAlbaranes: parsed.albaranNumbers
  };
}

ipcMain.handle('compare-factura-albaranes', async (event, payload) => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para comparar albaranes');
  }

  const { facturaAnalysisText, rootFolderName } = payload || {};
  if (!facturaAnalysisText || !rootFolderName) {
    throw new Error('Datos insuficientes para comparar albaranes');
  }

  return compareFacturaWithAlbaranes({ facturaAnalysisText, rootFolderName });
});

async function listDriveFilesInNoProcesado(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) return [];

  const noProcesado = await getDriveFolderByName(rootFolder.id, 'No procesado');
  if (!noProcesado) return [];

  const contents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: noProcesado.id
  });

  const files = (contents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
    .filter(item => isAllowedExtension(item.name || ''))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(item => ({
      ...item,
      sourceRoot: rootFolderName,
      noProcesadoId: noProcesado.id
    }));

  return files;
}

async function scanNoProcesado(trigger = 'startup') {
  if (startupScanState.inProgress) return;
  if (startupScanState.completed && trigger !== 'manual' && trigger !== 'login') return;

  startupScanState.inProgress = true;
  await waitForWindowReady();

  const sessionId = store.get('sessionId');
  if (!sessionId) {
    emitToRenderer('startup-status', {
      message: 'No hay sesión activa; no se puede procesar No procesado.'
    });
    startupScanState.inProgress = false;
    startupScanState.waitingForSession = true;
    return;
  }

  try {
    await postWithRetry(`${BACKEND_URL}/auth/verify`, { sessionId }, { retries: 1 });
    await ensureStandardFolders();
  } catch (error) {
    if (error?.response?.status === 401) {
      store.delete('sessionId');
      emitToRenderer('startup-status', {
        message: 'Sesión caducada. Inicia sesión de nuevo para procesar No procesado.'
      });
      startupScanState.inProgress = false;
      startupScanState.waitingForSession = true;
      return;
    }
  }

  emitToRenderer('startup-status', { message: 'Revisando carpeta Albaranes (1/2)' });
  const albaranesFiles = await listDriveFilesInNoProcesado('Albaranes');

  emitToRenderer('startup-status', { message: 'Revisando carpeta Facturas (2/2)' });
  const facturasFiles = await listDriveFilesInNoProcesado('Facturas');

  const allFiles = [...albaranesFiles, ...facturasFiles];
  if (allFiles.length === 0) {
    emitToRenderer('startup-status', { message: 'No se encontraron archivos en No procesado.' });
    startupScanState.inProgress = false;
    startupScanState.completed = true;
    startupScanState.waitingForSession = false;
    return;
  }

  emitToRenderer('startup-status', {
    message: `Encontrados ${allFiles.length} nuevos archivos en No procesado.`
  });

  let idx = 0;
  for (const fileMeta of allFiles) {
    idx += 1;
    const queueId = `startup-${idx}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = fileMeta?.name || 'Archivo';
    emitToRenderer('startup-status', {
      message: `Analizando ${fileName} (${idx}/${allFiles.length})`
    });

    try {
      await processNoProcesadoFileWithEvents(fileMeta, queueId);
    } catch (error) {
      emitToRenderer('queue-event', {
        type: 'error',
        id: queueId,
        message: error.message || 'Error desconocido'
      });
      log.error('Error procesando archivo en scan inicial:', error);
    }
  }

  emitToRenderer('startup-status', { message: 'Análisis inicial completado.' });
  startupScanState.inProgress = false;
  startupScanState.completed = true;
  startupScanState.waitingForSession = false;
}

// Cerrar sesión
ipcMain.handle('logout', async () => {
  const sessionId = store.get('sessionId');

  try {
    await postWithRetry(`${BACKEND_URL}/auth/logout`, {
      sessionId
    });
  } catch (error) {
    console.error('Error en logout:', error);
  }

  store.clear();
  app.relaunch();
  app.quit();
});
