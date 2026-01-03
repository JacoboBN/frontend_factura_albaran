const { ipcRenderer } = require('electron');

// Elementos del DOM
const uploadSection = document.getElementById('upload-section');
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

// Nota: el login se gestiona en index.html. Esta página solo muestra la UI principal.

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
      // Recargar contenido de la carpeta actual para mostrar la nueva carpeta
      await loadFolderContents(currentFolderId, false);
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

    if (!currentFolderId) {
      showStatus('Selecciona una carpeta real primero (no la raíz)', 'error');
      return;
    }

    try {
      shareBtn.textContent = 'Compartiendo...';
      shareBtn.disabled = true;
      // compartir la carpeta actualmente seleccionada
      await ipcRenderer.invoke('share-folder', emails, currentFolderId);
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

// Navegación de carpetas y listado de archivos (mejorado)
let currentFolderId = null;
let breadcrumb = [];

async function loadFolderContents(folderId = null, pushToBreadcrumb = true, folderName = null) {
  try {
    const res = await ipcRenderer.invoke('list-contents', folderId);
    const files = res.files || [];
    const folderIdUsed = res.folderId || folderId || null;
    currentFolderId = folderIdUsed;

    // actualizar breadcrumbs
    if (pushToBreadcrumb) {
      breadcrumb.push({ id: folderIdUsed, name: folderName || (folderIdUsed ? 'Carpeta' : 'Mi unidad') });
    }
    renderBreadcrumbs();

    const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    const folderTree = document.getElementById('folder-tree');
    const filesList = document.getElementById('files-list');

    // Render folders in folder-tree (children of current folder)
    if (folderTree) {
      folderTree.innerHTML = '';
      folders.forEach(f => {
        const el = document.createElement('div');
        el.textContent = f.name;
        el.addEventListener('click', () => loadFolderContents(f.id, true, f.name));
        folderTree.appendChild(el);
      });
    }

    // Render files as tiles
    if (filesList) {
      filesList.innerHTML = '';
      const items = [...folders, ...docs];
      if (items.length === 0) {
        filesList.innerHTML = '<p style="color:#666">Esta carpeta está vacía</p>';
      }

      items.forEach(item => {
        const tile = document.createElement('div');
        tile.className = 'file-tile';
        const isFolder = item.mimeType === 'application/vnd.google-apps.folder';

        const icon = document.createElement('div');
        icon.textContent = isFolder ? '📁' : '📄';
        icon.style.fontSize = '20px';

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = item.name;

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = isFolder ? 'Carpeta' : `${item.mimeType || ''} ${formatBytes(item.size)}`;

        const actions = document.createElement('div');
        actions.style.marginTop = 'auto';
        if (isFolder) {
          const openBtn = document.createElement('button');
          openBtn.className = 'btn small';
          openBtn.textContent = 'Abrir';
          openBtn.addEventListener('click', () => loadFolderContents(item.id, true, item.name));
          actions.appendChild(openBtn);
        } else {
          const openBtn = document.createElement('button');
          openBtn.className = 'btn small';
          openBtn.textContent = 'Abrir';
          openBtn.addEventListener('click', () => {
            const url = `https://drive.google.com/file/d/${item.id}/view`;
            ipcRenderer.invoke('open-external', url);
          });
          actions.appendChild(openBtn);
        }

        tile.appendChild(icon);
        tile.appendChild(name);
        tile.appendChild(meta);
        tile.appendChild(actions);
        filesList.appendChild(tile);
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
      loadFolderContents(b.id, false, b.name);
    });
    bc.appendChild(span);
  });
}

// When showing upload section initially, load root or session.folderId
async function showUploadSection(info) {
  uploadSection.classList.add('active');
  document.getElementById('user-email').textContent = info.email;

  // start breadcrumb with root
  breadcrumb = [];
  const rootId = info.folderId || null;
  breadcrumb.push({ id: rootId, name: 'Mi unidad' });
  await loadFolderContents(rootId, false, 'Mi unidad');
}

function pathBasename(p) {
  try { return p.split(/[\\/]/).pop(); } catch (e) { return p; }
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed( (i===0)?0:1 ) + ' ' + sizes[i];
}

async function chooseFolderForFile(filePath) {
  const name = pathBasename(filePath);
  const folderId = await ipcRenderer.invoke('choose-folder', name);
  if (!folderId) throw new Error('Operación cancelada o sin selección');
  return folderId;
}

// Botón atrás
const backBtn = document.getElementById('back-btn');
if (backBtn) {
  backBtn.addEventListener('click', () => {
    if (breadcrumb.length > 1) {
      breadcrumb.pop();
      const prev = breadcrumb[breadcrumb.length - 1];
      loadFolderContents(prev.id, false, prev.name);
    }
  });
}

// Cerrar sesión
logoutBtn.addEventListener('click', async () => {
  if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
    await ipcRenderer.invoke('logout');
  }
});
// (showUploadSection está implementada arriba con navegación mejorada)

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
