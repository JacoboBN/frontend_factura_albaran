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

  if (info && info.email) {
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

// Crear carpeta en Drive (desde UI)
const createFolderBtn = document.getElementById('create-folder-btn');
const createFolderNameInput = document.getElementById('create-folder-name');
const shareBtn = document.getElementById('share-btn');
const shareEmailsInput = document.getElementById('share-emails');

if (createFolderBtn) {
  createFolderBtn.addEventListener('click', async () => {
    const name = createFolderNameInput.value.trim();
    if (!name) { showStatus('Por favor ingresa un nombre de carpeta', 'error'); return; }

    try {
      createFolderBtn.textContent = 'Creando...';
      createFolderBtn.disabled = true;
      const res = await ipcRenderer.invoke('create-folder', name, null);
      showStatus('Carpeta creada: ' + (res.folderName || res.folderId), 'success');
      createFolderNameInput.value = '';
    } catch (err) {
      showStatus('Error al crear carpeta: ' + err.message, 'error');
    } finally {
      createFolderBtn.textContent = 'Crear carpeta';
      createFolderBtn.disabled = false;
    }
  });
}

if (shareBtn) {
  shareBtn.addEventListener('click', async () => {
    const emailsText = shareEmailsInput.value.trim();
    if (!emailsText) { showStatus('Por favor ingresa al menos un email', 'error'); return; }
    const emails = emailsText.split(',').map(e => e.trim()).filter(e => e);
    if (emails.length === 0) { showStatus('Emails inválidos', 'error'); return; }

    try {
      shareBtn.textContent = 'Compartiendo...';
      shareBtn.disabled = true;
      await ipcRenderer.invoke('share-folder', emails);
      showStatus('Carpeta compartida exitosamente', 'success');
      shareEmailsInput.value = '';
    } catch (err) {
      showStatus('Error al compartir: ' + err.message, 'error');
    } finally {
      shareBtn.textContent = 'Compartir acceso';
      shareBtn.disabled = false;
    }
  });
}

// Navegación de carpetas y listado de archivos
let currentFolderId = null;
let breadcrumb = [];

async function loadFolderContents(folderId = null, pushToBreadcrumb = true) {
  try {
    const res = await ipcRenderer.invoke('list-contents', folderId);
    const files = res.files || [];
    const folderIdUsed = res.folderId || folderId || null;
    currentFolderId = folderIdUsed;

    // actualizar breadcrumbs
    if (pushToBreadcrumb) {
      breadcrumb.push({ id: folderIdUsed, name: files.length === 0 ? (folderIdUsed || 'Raíz') : (folderIdUsed || 'Raíz') });
    }
    renderBreadcrumbs();

    const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    const folderTree = document.getElementById('folder-tree');
    const filesList = document.getElementById('files-list');

    // Render folders in folder-tree (only children of current folder)
    if (folderTree) {
      folderTree.innerHTML = '';
      // Add parent/back if applicable
      if (breadcrumb.length > 1) {
        const back = document.createElement('div');
        back.textContent = '⬅ Volver';
        back.style.padding = '8px';
        back.style.cursor = 'pointer';
        back.addEventListener('click', () => {
          breadcrumb.pop();
          const parent = breadcrumb[breadcrumb.length - 1];
          // reload parent without pushing
          loadFolderContents(parent.id, false);
        });
        folderTree.appendChild(back);
      }

      folders.forEach(f => {
        const el = document.createElement('div');
        el.textContent = f.name;
        el.style.padding = '8px';
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => loadFolderContents(f.id, true));
        folderTree.appendChild(el);
      });
    }

    // Render files
    if (filesList) {
      filesList.innerHTML = '';
      if (folders.length === 0 && docs.length === 0) {
        filesList.innerHTML = '<p style="color:#666">Esta carpeta está vacía</p>';
      }

      docs.forEach(d => {
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '8px 6px';
        row.style.borderBottom = '1px solid #eee';

        const left = document.createElement('div');
        left.textContent = d.name;
        left.style.flex = '1';

        const right = document.createElement('div');
        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn-secondary';
        openBtn.textContent = 'Abrir en Drive';
        openBtn.style.padding = '6px 10px';
        openBtn.addEventListener('click', () => {
          const url = `https://drive.google.com/file/d/${d.id}/view`;
          ipcRenderer.invoke('open-external', url);
        });
        right.appendChild(openBtn);

        row.appendChild(left);
        row.appendChild(right);
        filesList.appendChild(row);
      });
    }

  } catch (err) {
    showStatus('Error cargando carpeta: ' + (err.message || err), 'error');
  }
}

function renderBreadcrumbs() {
  const bc = document.getElementById('breadcrumbs');
  if (!bc) return;
  bc.innerHTML = '';
  breadcrumb.forEach((b, idx) => {
    const span = document.createElement('span');
    span.style.cursor = 'pointer';
    span.style.marginRight = '8px';
    span.textContent = (b.name || 'Carpeta') + (idx < breadcrumb.length - 1 ? ' /' : '');
    span.addEventListener('click', () => {
      // go to this breadcrumb
      breadcrumb = breadcrumb.slice(0, idx + 1);
      loadFolderContents(b.id, false);
    });
    bc.appendChild(span);
  });
}

// When showing upload section initially, load root or session.folderId
async function showUploadSection(info) {
  loginSection.classList.remove('active');
  uploadSection.classList.add('active');
  document.getElementById('user-email').textContent = info.email;

  // start breadcrumb with root
  breadcrumb = [];
  const rootId = info.folderId || null;
  breadcrumb.push({ id: rootId, name: 'Raíz' });
  await loadFolderContents(rootId, false);
}

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