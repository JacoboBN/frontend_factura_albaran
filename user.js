const { ipcRenderer } = require('electron');

// Elementos del DOM
const loginSection = document.getElementById('login-section');
const uploadSection = document.getElementById('upload-section');
const loginBtn = document.getElementById('login-btn');
const fileUpload = document.getElementById('file-upload');
const logoutBtn = document.getElementById('logout-btn');

// Verificar si ya hay sesión
checkSession();

// Login con Google
loginBtn.addEventListener('click', async () => {
  try {
    loginBtn.textContent = 'Abriendo navegador...';
    loginBtn.disabled = true;
    showStatus('Se abrirá tu navegador para iniciar sesión con Google. Autoriza la app y vuelve aquí.', 'loading');

    const user = await ipcRenderer.invoke('google-login', false);
    checkSession();

  } catch (error) {
    alert('Error al iniciar sesión: ' + error.message);
    loginBtn.textContent = 'Iniciar sesión con Google';
    loginBtn.disabled = false;
    document.getElementById('status').style.display = 'none';
  }
});

async function checkSession() {
  const info = await ipcRenderer.invoke('get-user-info');

  if (info && info.email) {
    showUploadSection(info);
  } else {
    loginSection.classList.add('active');
    uploadSection.classList.remove('active');
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

      // Refresh the current folder contents after upload
      await loadFolderContents(currentFolderId, false);

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
      // Reload folder tree and current contents
      await loadFolderTree();
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

    try {
      shareBtn.textContent = 'Compartiendo...';
      shareBtn.disabled = true;
      // compartir la carpeta actualmente seleccionada
      const folderToShare = currentFolderId || null;
      await ipcRenderer.invoke('share-folder', emails, folderToShare);
      showStatus('Carpeta compartida exitosamente', 'success');
      shareEmailsInput.value = '';
      // Refresh shared lists to reflect the new permissions
      await refreshSharedLists();
    } catch (err) {
      showStatus('Error al compartir: ' + err.message, 'error');
    } finally {
      shareBtn.textContent = 'Compartir acceso';
      shareBtn.disabled = false;
    }
  });
}

// Refrescar listas de usuarios compartidos en la UI (admin y main)
async function refreshSharedLists() {
  try {
    const info = await ipcRenderer.invoke('get-user-info');
    const shared = (info && info.sharedEmails) ? info.sharedEmails : [];

    const sharedEmailsList = document.getElementById('shared-emails-list');
    if (sharedEmailsList) {
      sharedEmailsList.innerHTML = '';
      if (shared.length === 0) {
        sharedEmailsList.innerHTML = '<p style="color:#666">No hay usuarios con acceso</p>';
      } else {
        shared.forEach(email => {
          const div = document.createElement('div');
          div.className = 'shared-item';
          div.innerHTML = `<span>${email}</span>`;
          sharedEmailsList.appendChild(div);
        });
      }
    }

    const mainShared = document.getElementById('main-shared-list');
    if (mainShared) {
      mainShared.innerHTML = '';
      if (shared.length === 0) {
        mainShared.innerHTML = '<p style="color:#666">No hay usuarios con acceso</p>';
      } else {
        shared.forEach(email => {
          const div = document.createElement('div');
          div.className = 'shared-item';
          div.textContent = email;
          mainShared.appendChild(div);
        });
      }
    }
  } catch (e) {
    console.error('Error refrescando shared lists:', e);
  }
}

// Navegación de carpetas y listado de archivos (mejorado)
let currentFolderId = null;
let breadcrumb = [];
let folderTreeData = null;

async function loadFolderTree() {
  try {
    const res = await ipcRenderer.invoke('list-folders');
    const folders = res.folders || [];

    // Build tree structure
    const tree = {};
    const nodes = {};

    // Create nodes
    folders.forEach(f => {
      nodes[f.id] = { ...f, children: [], expanded: false };
    });

    // Build hierarchy
    folders.forEach(f => {
      const parentId = f.parents && f.parents[0];
      if (parentId && nodes[parentId]) {
        nodes[parentId].children.push(nodes[f.id]);
      } else {
        // Root level
        tree[f.id] = nodes[f.id];
      }
    });
    // Sort children of every node alphabetically for consistent order
    Object.values(nodes).forEach(n => {
      if (n.children && n.children.length > 0) {
        n.children.sort((a, b) => (a.name || '').toString().localeCompare((b.name || '').toString()));
      }
    });

    folderTreeData = tree;
    return tree;
  } catch (err) {
    console.error('Error loading folder tree:', err);
    return {};
  }
}

function renderFolderTree(container, tree, currentFolderId, level = 0) {
  container.innerHTML = '';

  // Add "Mi unidad" root
  const rootEl = document.createElement('div');
  rootEl.style.paddingLeft = '0px';
  rootEl.style.cursor = 'pointer';
  rootEl.style.fontWeight = (!currentFolderId) ? 'bold' : 'normal';
  rootEl.textContent = '📁 Mi unidad';
  rootEl.addEventListener('click', () => loadFolderContents(null, true, 'Mi unidad'));
  container.appendChild(rootEl);

  // Render tree roots in sorted order for stable UI
  const roots = Object.values(tree || {}).sort((a, b) => (a.name || '').toString().localeCompare((b.name || '').toString()));
  roots.forEach(node => {
    renderTreeNode(container, node, currentFolderId, level + 1);
  });
}

// Helper: check if a node (or any descendant) has id === targetId
function nodeContains(node, targetId) {
  if (!targetId) return false;
  if (node.id === targetId) return true;
  for (const child of node.children || []) {
    if (nodeContains(child, targetId)) return true;
  }
  return false;
}

function renderTreeNode(container, node, currentFolderId, level) {
  const el = document.createElement('div');
  el.style.paddingLeft = (level * 20) + 'px';
  el.style.cursor = 'pointer';
  el.style.fontWeight = (node.id === currentFolderId) ? 'bold' : 'normal';

  const toggleIcon = node.children.length > 0 ? (node.expanded ? '📂' : '📁') : '📄';
  el.innerHTML = `${toggleIcon} ${node.name}`;
  // Auto-expand this branch if it contains the current folder
  if (currentFolderId && nodeContains(node, currentFolderId)) {
    node.expanded = true;
  }
  // Open folder on click. If it has children, expand it and navigate into it.
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    node.expanded = true;
    loadFolderContents(node.id, true, node.name);
  });

  container.appendChild(el);

  if (node.expanded && node.children.length > 0) {
    node.children.forEach(child => {
      renderTreeNode(container, child, currentFolderId, level + 1);
    });
  }
}

async function loadFolderContents(folderId = null, pushToBreadcrumb = true, folderName = null) {
  try {
    const res = await ipcRenderer.invoke('list-contents', folderId);
    const files = res.files || [];
    const folderIdUsed = res.folderId || folderId || null;
    currentFolderId = folderIdUsed;

    // actualizar breadcrumbs
    if (pushToBreadcrumb) {
      // If navigating to root, reset breadcrumb to single root entry
      if (!folderIdUsed) {
        breadcrumb = [{ id: null, name: 'Mi unidad' }];
      } else {
        // If this folder already exists in breadcrumb, trim to it
        const existingIndex = breadcrumb.findIndex(b => b && b.id === folderIdUsed);
        if (existingIndex >= 0) {
          breadcrumb = breadcrumb.slice(0, existingIndex + 1);
        } else {
          breadcrumb.push({ id: folderIdUsed, name: folderName || 'Carpeta' });
        }
      }
    }
    renderBreadcrumbs();

    const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    const folderTree = document.getElementById('folder-tree');
    const filesList = document.getElementById('files-list');

    // Render full folder tree
    if (folderTree && folderTreeData) {
      renderFolderTree(folderTree, folderTreeData, currentFolderId);
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

  // Also update sidebar path if present so user can jump from the left panel
  const sp = document.getElementById('sidebar-path');
  if (sp) {
    sp.innerHTML = '';
    breadcrumb.forEach((b, idx) => {
      const s = document.createElement('span');
      s.style.cursor = 'pointer';
      s.style.marginRight = '6px';
      s.style.color = '#333';
      s.textContent = b.name || 'Carpeta';
      s.addEventListener('click', () => {
        breadcrumb = breadcrumb.slice(0, idx + 1);
        loadFolderContents(b.id, false, b.name);
      });
      sp.appendChild(s);
      if (idx < breadcrumb.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = ' / ';
        sep.style.color = '#777';
        sp.appendChild(sep);
      }
    });
  }
}

// When showing upload section initially, load root or session.folderId
async function showUploadSection(info) {
  loginSection.classList.remove('active');
  uploadSection.classList.add('active');
  document.getElementById('user-email').textContent = info.email;

  // Load the full folder tree
  await loadFolderTree();

  // start breadcrumb with root
  breadcrumb = [];
  // Use Drive root as "Mi unidad" (null) so the breadcrumb represents the real root
  const rootId = null;
  breadcrumb.push({ id: rootId, name: 'Mi unidad' });
  await loadFolderContents(null, false, 'Mi unidad');
  // Refresh shared lists for the UI
  await refreshSharedLists();
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
