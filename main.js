const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const store = new Store();
let mainWindow;

// URL del backend en Render (CAMBIAR POR TU URL)
const BACKEND_URL = 'https://backend-factura-albaran.onrender.com';

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

  // Verificar si es modo usuario
  const isUser = process.argv.includes('--user-mode');
  const userMode = store.get('userMode', false);

  if (isUser || userMode) {
    store.set('userMode', true);
    mainWindow.loadFile('user.html');
  } else {
    mainWindow.loadFile('index.html');
  }
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
    // Support single filePath string or array of paths
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    const results = [];

    for (const p of paths) {
      const formData = new FormData();
      formData.append('sessionId', sessionId);
      if (targetFolderId) formData.append('targetFolderId', targetFolderId);
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