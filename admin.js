const { ipcRenderer } = require('electron');

let userInfo = null;

// Elementos del DOM
const loginSection = document.getElementById('login-section');
const setupSection = document.getElementById('setup-section');
const mainSection = document.getElementById('main-section');
const loginBtn = document.getElementById('login-btn');
const shareBtn = document.getElementById('share-btn');
const shareEmailsInput = document.getElementById('share-emails');
const fileUpload = document.getElementById('file-upload');
const copyLinkBtn = document.getElementById('copy-link-btn');
const logoutBtn = document.getElementById('logout-btn');

// Verificar si ya hay sesión
checkSession();

async function checkSession() {
  const info = await ipcRenderer.invoke('get-user-info');
  
  if (info.email) {
    userInfo = info;
    
    if (info.folderId) {
      showMainSection();
    } else {
      showSetupSection();
    }
  }
}

// Login con Google
loginBtn.addEventListener('click', async () => {
  try {
    loginBtn.textContent = 'Abriendo navegador...';
    loginBtn.disabled = true;
    
    showStatus('Se abrirá tu navegador para iniciar sesión con Google. Autoriza la app y vuelve aquí.', 'loading');
    
    const user = await ipcRenderer.invoke('google-login', false);
    
    showStatus('¡Sesión iniciada! Creando carpeta compartida...', 'loading');
    
    // Crear carpeta compartida
    await ipcRenderer.invoke('create-shared-folder');
    
    userInfo = await ipcRenderer.invoke('get-user-info');
    showSetupSection();
    
  } catch (error) {
    alert('Error al iniciar sesión: ' + error.message);
    loginBtn.textContent = 'Iniciar sesión con Google';
    loginBtn.disabled = false;
    document.getElementById('status').style.display = 'none';
  }
});

// Compartir con usuarios
shareBtn.addEventListener('click', async () => {
  const emailsText = shareEmailsInput.value.trim();
  
  if (!emailsText) {
    showStatus('Por favor ingresa al menos un email', 'error');
    return;
  }
  
  const emails = emailsText.split(',').map(e => e.trim()).filter(e => e);
  
  if (emails.length === 0) {
    showStatus('Por favor ingresa emails válidos', 'error');
    return;
  }
  
  try {
    shareBtn.textContent = 'Compartiendo...';
    shareBtn.disabled = true;
    
    await ipcRenderer.invoke('share-folder', emails);
    
    showStatus('Carpeta compartida exitosamente', 'success');
    shareEmailsInput.value = '';
    
    // Actualizar info y mostrar pantalla principal
    userInfo = await ipcRenderer.invoke('get-user-info');
    setTimeout(() => showMainSection(), 1500);
    
  } catch (error) {
    showStatus('Error al compartir: ' + error.message, 'error');
  } finally {
    shareBtn.textContent = 'Compartir acceso';
    shareBtn.disabled = false;
  }
});

// Subir archivo
fileUpload.addEventListener('click', async () => {
  try {
    const filePaths = await ipcRenderer.invoke('select-file');

    if (filePaths && filePaths.length > 0) {
      // Obtener carpetas disponibles
      const folders = await ipcRenderer.invoke('list-folders');

      for (const p of filePaths) {
        // Elegir carpeta para este archivo
        const folderId = await chooseFolderForFile(p, folders);

        showMainStatus(`Subiendo ${pathBasename(p)}...`, 'loading');
        await ipcRenderer.invoke('upload-file', p, folderId);
        showMainStatus(`¡${pathBasename(p)} subido!`, 'success');
      }

      setTimeout(() => {
        document.getElementById('main-status').style.display = 'none';
      }, 2000);
    }
  } catch (error) {
    showMainStatus('Error al subir archivo: ' + error.message, 'error');
  }
});

function pathBasename(p) {
  try { return p.split(/[\\/]/).pop(); } catch (e) { return p; }
}

async function chooseFolderForFile(filePath, folders) {
  // Construir mensaje simple
  let msg = `Selecciona carpeta para ${pathBasename(filePath)}:\n`;
  folders.forEach((f, i) => { msg += `${i}: ${f.name}\n`; });
  msg += "n: crear nueva carpeta\n";
  const choice = prompt(msg, '0');

  if (choice === null) throw new Error('Operación cancelada');

  if (choice.toLowerCase() === 'n') {
    const newName = prompt('Nombre de la nueva carpeta:', `DriveShare - ${new Date().toLocaleString()}`);
    if (!newName) throw new Error('Nombre de carpeta inválido');
    const created = await ipcRenderer.invoke('create-folder', newName, null);
    return created.folderId || created.folderId; 
  }

  const idx = parseInt(choice, 10);
  if (!isNaN(idx) && folders[idx]) return folders[idx].id;
  throw new Error('Selección inválida');
}

// Copiar link
copyLinkBtn.addEventListener('click', async () => {
  const link = document.getElementById('user-link').value;
  
  try {
    await navigator.clipboard.writeText(link);
    copyLinkBtn.textContent = '¡Copiado!';
    setTimeout(() => {
      copyLinkBtn.textContent = 'Copiar link';
    }, 2000);
  } catch (error) {
    alert('Error al copiar: ' + error.message);
  }
});

// Cerrar sesión
logoutBtn.addEventListener('click', async () => {
  if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
    await ipcRenderer.invoke('logout');
  }
});

// Mostrar sección de configuración
function showSetupSection() {
  loginSection.classList.remove('active');
  setupSection.classList.add('active');
  mainSection.classList.remove('active');
  
  document.getElementById('user-name').textContent = userInfo.name;
  document.getElementById('user-email').textContent = userInfo.email;
  
  if (userInfo.sharedEmails && userInfo.sharedEmails.length > 0) {
    updateSharedList();
  }
}

// Mostrar sección principal
function showMainSection() {
  loginSection.classList.remove('active');
  setupSection.classList.remove('active');
  mainSection.classList.add('active');
  
  document.getElementById('main-user-email').textContent = userInfo.email;
  
  // Generar link para usuarios
  ipcRenderer.invoke('get-user-link').then(link => {
    document.getElementById('user-link').value = link;
  });
  
  updateMainSharedList();
}

// Actualizar lista de emails compartidos
function updateSharedList() {
  const listContainer = document.getElementById('shared-emails-list');
  const sharedListDiv = document.getElementById('shared-list');
  
  listContainer.innerHTML = '';
  
  if (userInfo.sharedEmails && userInfo.sharedEmails.length > 0) {
    sharedListDiv.style.display = 'block';
    
    userInfo.sharedEmails.forEach(email => {
      const item = document.createElement('div');
      item.className = 'shared-item';
      item.innerHTML = `<span>${email}</span>`;
      listContainer.appendChild(item);
    });
  }
}

// Actualizar lista principal
function updateMainSharedList() {
  const listContainer = document.getElementById('main-shared-list');
  
  listContainer.innerHTML = '';
  
  if (userInfo.sharedEmails && userInfo.sharedEmails.length > 0) {
    userInfo.sharedEmails.forEach(email => {
      const item = document.createElement('div');
      item.className = 'shared-item';
      item.innerHTML = `<span>${email}</span>`;
      listContainer.appendChild(item);
    });
  } else {
    listContainer.innerHTML = '<p style="color: #999; text-align: center;">No hay usuarios autorizados aún</p>';
  }
}

// Mostrar mensajes de estado
function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  status.style.display = 'block';
  
  if (type === 'success' || type === 'error') {
    setTimeout(() => {
      status.style.display = 'none';
    }, 5000);
  }
}

function showMainStatus(message, type) {
  const status = document.getElementById('main-status');
  status.textContent = message;
  status.className = `status ${type}`;
}