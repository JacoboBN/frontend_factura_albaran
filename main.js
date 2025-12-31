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

// Compartir carpeta con usuarios
ipcMain.handle('share-folder', async (event, emails) => {
  const sessionId = store.get('sessionId');
  
  try {
    const response = await axios.post(`${BACKEND_URL}/drive/share-folder`, {
      sessionId,
      emails
    });
    
    return response.data;
  } catch (error) {
    console.error('Error compartiendo carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al compartir carpeta');
  }
});

// Subir archivo
ipcMain.handle('upload-file', async (event, filePath) => {
  const sessionId = store.get('sessionId');
  const targetFolderId = arguments.length >= 2 ? arguments[1] : null;

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