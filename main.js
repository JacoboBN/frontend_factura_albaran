const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// URL del backend en Render (siempre usa esta URL ya que el backend está en producción)
const BACKEND_URL = 'https://backend-factura-albaran.onrender.com';

// Helper function to get binary paths
function getBinaryPaths() {
  // In production, binaries are in process.resourcesPath/bin
  // In development, they are in the assets folder
  const isPackaged = app.isPackaged;
  const basePath = isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'assets', 'bin', 'win');

  return {
    tesseract: path.join(basePath, 'tesseract', 'tesseract.exe'),
    tessdata: path.join(basePath, 'tesseract', 'tessdata'),
    pdftoppm: path.join(basePath, 'poppler', 'pdftoppm.exe')
  };
}

// Local OCR function using embedded Tesseract and Poppler
async function performLocalOCR(filePath, mimeType, originalName) {
  const tempDir = os.tmpdir();
  const jobId = uuidv4();
  const workDir = path.join(tempDir, `electron-ocr-${jobId}`);
  fs.mkdirSync(workDir, { recursive: true });

  const binaryPaths = getBinaryPaths();

  try {
    const isPdf = mimeType === "application/pdf" || originalName.toLowerCase().endsWith(".pdf");
    let imagePaths = [];

    if (isPdf) {
      // Convert PDF pages to PNG using embedded pdftoppm
      const baseName = `pdf-${jobId}`;
      const outPrefix = path.join(workDir, baseName);
      await new Promise((resolve, reject) => {
        execFile(binaryPaths.pdftoppm, ["-png", filePath, outPrefix], (err, stdout, stderr) => {
          if (err) return reject(new Error(`PDF conversion failed: ${stderr || err.message}`));
          const files = fs.readdirSync(workDir)
            .filter(f => f.startsWith(baseName + "-") && f.endsWith(".png"))
            .map(f => path.join(workDir, f))
            .sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
          imagePaths = files;
          resolve();
        });
      });
      if (!imagePaths.length) throw new Error("No pages rendered from PDF");
    } else {
      imagePaths = [filePath];
    }

    const pageTexts = [];
    let totalConfidence = 0;
    let pageCount = 0;

    for (let i = 0; i < imagePaths.length; i++) {
      const imagePath = imagePaths[i];

      // Run Tesseract OCR using embedded binary
      const outputBase = path.join(workDir, `tesseract-${jobId}-${i}`);
      await new Promise((resolve, reject) => {
        const env = { ...process.env, TESSDATA_PREFIX: binaryPaths.tessdata };
        execFile(binaryPaths.tesseract, [imagePath, outputBase, '-l', 'spa'], { env }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`Tesseract OCR failed: ${stderr || err.message}`));
          resolve();
        });
      });

      // Read the output text file
      const textFile = outputBase + '.txt';
      if (!fs.existsSync(textFile)) {
        throw new Error(`Tesseract did not generate output file for page ${i + 1}`);
      }

      const text = fs.readFileSync(textFile, 'utf8').trim();
      pageTexts.push({ page: i + 1, text });

      // Estimate quality based on text length (simple heuristic)
      totalConfidence += Math.min(text.trim().length / 500, 1);
      pageCount++;
    }

    const averageQuality = pageCount > 0 ? totalConfidence / pageCount : 0;

    // Clean up
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}

    return {
      text: pageTexts.map(p => `--- PAGE ${p.page} ---\n${p.text}`).join("\n\n"),
      quality: averageQuality
    };
  } catch (e) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

const store = new Store();
let mainWindow;

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
}

app.whenReady().then(createWindow);

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
    const response = await axios.post(`${BACKEND_URL}/drive/create-folder`, {
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
    const response = await axios.post(`${BACKEND_URL}/drive/share-folder`, {
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
    // Encontrar o crear la carpeta "No procesado/Albaranes"
    const uploadFolderId = await getOrCreateAlbaranesFolder(sessionId);

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
    const response = await axios.post(`${BACKEND_URL}/drive/list-folders`, { sessionId });
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
    const response = await axios.post(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId });
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
    const response = await axios.post(`${BACKEND_URL}/drive/create-folder`, { sessionId, name, parentId });
    return response.data;
  } catch (error) {
    console.error('Error creando carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al crear carpeta');
  }
});

// Elegir carpeta para un archivo usando diálogos nativos (evita prompt())
ipcMain.handle('choose-folder', async (event, fileName) => {
  const sessionId = store.get('sessionId');
  try {
    const resp = await axios.post(`${BACKEND_URL}/drive/list-folders`, { sessionId });
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
      const created = await axios.post(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: newName });
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
    const response = await axios.post(`${BACKEND_URL}/session/info`, {
      sessionId
    });
    
    return response.data;
  } catch (error) {
    return null;
  }
});

// Generar link para usuarios
ipcMain.handle('get-user-link', () => {
  // En producción, esta sería la URL de descarga del instalador con parámetro
  // Por ahora retornamos instrucción
  return 'https://tu-sitio.com/DriveShare-Setup.exe?mode=user';
});

// Función para encontrar o crear la carpeta "No procesado/Albaranes"
async function getOrCreateAlbaranesFolder(sessionId) {
  try {
    // Listar carpetas en la raíz
    const rootFoldersResp = await axios.post(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: 'root' });
    const rootFolders = rootFoldersResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let noProcesadoFolder = rootFolders.find(f => f.name === 'No procesado');

    if (!noProcesadoFolder) {
      // Crear "No procesado"
      const createResp = await axios.post(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'No procesado' });
      noProcesadoFolder = { id: createResp.data.folderId };
    }

    // Listar contenido de "No procesado"
    const noProcesadoContentsResp = await axios.post(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: noProcesadoFolder.id });
    const noProcesadoContents = noProcesadoContentsResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let albaranesFolder = noProcesadoContents.find(f => f.name === 'Albaranes');

    if (!albaranesFolder) {
      // Crear "Albaranes" dentro de "No procesado"
      const createResp = await axios.post(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'Albaranes', parentId: noProcesadoFolder.id });
      albaranesFolder = { id: createResp.data.folderId };
    }

    return albaranesFolder.id;
  } catch (error) {
    console.error('Error finding or creating Albaranes folder:', error);
    throw new Error('Error al encontrar o crear carpeta Albaranes');
  }
}

// Analyze document with local OCR and AI analysis
ipcMain.handle('analyze-document', async (event, filePath, mimeType, originalName) => {
  try {
    // Perform local OCR
    const ocrResult = await performLocalOCR(filePath, mimeType, originalName);

    // Send extracted text to backend for AI analysis
    const response = await axios.post(`${BACKEND_URL}/analyze/document`, {
      text: ocrResult.text,
      quality: ocrResult.quality
    });

    return response.data;
  } catch (error) {
    console.error('Error analyzing document:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar el documento');
  }
});

// Cerrar sesión
ipcMain.handle('logout', async () => {
  const sessionId = store.get('sessionId');

  try {
    await axios.post(`${BACKEND_URL}/auth/logout`, {
      sessionId
    });
  } catch (error) {
    console.error('Error en logout:', error);
  }

  store.clear();
  app.relaunch();
  app.quit();
});
