const { ipcRenderer } = require('electron');

// Elementos del DOM
const loginSection = document.getElementById('login-section');
const uploadSection = document.getElementById('upload-section');
const loginBtn = document.getElementById('login-btn');
const fileUpload = document.getElementById('file-upload');
const logoutBtn = document.getElementById('logout-btn');

// Verificar si ya hay sesión
checkSession();

async function checkSession() {
  const info = await ipcRenderer.invoke('get-user-info');
  
  if (info.email && info.folderId) {
    showUploadSection(info);
  }
}

// Login con Google
loginBtn.addEventListener('click', async () => {
  try {
    loginBtn.textContent = 'Abriendo navegador...';
    loginBtn.disabled = true;
    
    showStatus('Se abrirá tu navegador para iniciar sesión. Autoriza la app y vuelve aquí.', 'loading');
    
    const user = await ipcRenderer.invoke('google-login', true);
    const info = await ipcRenderer.invoke('get-user-info');
    
    if (info.folderId) {
      showUploadSection(info);
    } else {
      showStatus('Error: No se encontró la carpeta compartida. Contacta al administrador.', 'error');
      loginBtn.textContent = 'Iniciar sesión con Google';
      loginBtn.disabled = false;
    }
    
  } catch (error) {
    showStatus('Error al iniciar sesión: ' + error.message, 'error');
    loginBtn.textContent = 'Iniciar sesión con Google';
    loginBtn.disabled = false;
  }
});

// Subir archivo
fileUpload.addEventListener('click', async () => {
  try {
    const filePaths = await ipcRenderer.invoke('select-file');

    if (filePaths && filePaths.length > 0) {
      const folders = await ipcRenderer.invoke('list-folders');

      for (const p of filePaths) {
        const folderId = await chooseFolderForFile(p, folders);
        showStatus(`Subiendo ${pathBasename(p)}...`, 'loading');
        await ipcRenderer.invoke('upload-file', p, folderId);
        showStatus(`¡${pathBasename(p)} subido!`, 'success');
      }

      setTimeout(() => {
        document.getElementById('status').style.display = 'none';
      }, 2000);
    }
  } catch (error) {
    showStatus('Error al subir archivo: ' + error.message, 'error');
  }
});

function pathBasename(p) {
  try { return p.split(/[\\/]/).pop(); } catch (e) { return p; }
}

async function chooseFolderForFile(filePath) {
  const name = pathBasename(filePath);
  const folderId = await ipcRenderer.invoke('choose-folder', name);
  if (!folderId) throw new Error('Operación cancelada o sin selección');
  return folderId;
}

// Cerrar sesión
logoutBtn.addEventListener('click', async () => {
  if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
    await ipcRenderer.invoke('logout');
  }
});

// Mostrar sección de subida
function showUploadSection(info) {
  loginSection.classList.remove('active');
  uploadSection.classList.add('active');
  
  document.getElementById('user-email').textContent = info.email;
}

// Mostrar mensajes de estado
function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  
  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      status.style.display = 'none';
    }, 5000);
  }
}