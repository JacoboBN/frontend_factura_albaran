const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// Elementos del DOM
const loginSection = document.getElementById('login-section');
const uploadSection = document.getElementById('upload-section');
const loginBtn = document.getElementById('login-btn');
const fileUpload = document.getElementById('file-upload');
const logoutBtn = document.getElementById('logout-btn');
const menuButtons = document.querySelectorAll('.menu-item');
const tileButtons = document.querySelectorAll('.tile');

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

const queueList = document.getElementById('upload-queue-list');
const uploadQueue = new Map();
const startupStatusEl = document.getElementById('startup-status');
const startupOverlay = document.getElementById('startup-overlay');
const startupOverlayMessage = document.getElementById('startup-overlay-message');
const billingSetupSection = document.getElementById('billing-setup-section');
const billingQuestionText = document.getElementById('billing-question-text');
const billingSameBtn = document.getElementById('billing-same-btn');
const billingDifferentBtn = document.getElementById('billing-different-btn');
const billingDifferentActions = document.getElementById('billing-different-actions');
const billingLoginBtn = document.getElementById('billing-login-btn');
const billingEmailLabel = document.getElementById('billing-email');

const QUEUE_STEPS = ['Subiendo', 'IA', 'Enviando', 'Enviado'];

function guessMimeTypeFromPath(filePath = '') {
  const ext = (path.extname(filePath || '') || '').toLowerCase();
  const mimeByExt = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.txt': 'text/plain'
  };
  return mimeByExt[ext] || '';
}

async function invokeAnalyzeFileWithFallback(filePath, mimeType, originalName, docType) {
  try {
    return await ipcRenderer.invoke('analyze-file', filePath, mimeType, originalName, docType);
  } catch (error) {
    const message = String(error?.message || '');
    if (message.includes("No handler registered for 'analyze-file'")) {
      return ipcRenderer.invoke('analyze-document', filePath, mimeType, originalName, docType);
    }
    throw error;
  }
}

async function invokeAnalyzeFilesBatchWithFallback(items = [], docType = 'albaran') {
  const validItems = (Array.isArray(items) ? items : []).filter(item => item?.filePath);
  if (!validItems.length) return [];

  try {
    const results = await ipcRenderer.invoke('analyze-files-batch', validItems, docType);
    if (Array.isArray(results) && results.length) {
      return results;
    }
    throw new Error('Batch IA sin resultados');
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.includes("No handler registered for 'analyze-files-batch'")) {
      console.warn('Batch IA falló en renderer; fallback individual:', error);
    }

    const fallback = [];
    for (const item of validItems) {
      try {
        const single = await invokeAnalyzeFileWithFallback(
          item.filePath,
          item.mimeType || '',
          item.originalName || '',
          docType
        );
        fallback.push({ success: true, analysis: single?.analysis || '', raw: single });
      } catch (singleError) {
        fallback.push({ success: false, analysis: '', error: singleError?.message || String(singleError) });
      }
    }
    return fallback;
  }
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

async function uploadGeneratedTxtFiles(targetFolderId, analysisText, sourceFileName = null) {
  if (!targetFolderId) return;
  const payload = buildTxtFilesFromAnalysis(analysisText, sourceFileName);
  if (!payload || !payload.files.length) return;

  const tempDir = path.join(require('os').tmpdir(), 'ia-json');
  fs.mkdirSync(tempDir, { recursive: true });

  for (const file of payload.files) {
    const safeName = sanitizeFileName(file.name);
    const tempPath = path.join(tempDir, safeName);
    fs.writeFileSync(tempPath, file.content || '', 'utf8');

    try {
      await ipcRenderer.invoke('upload-file', tempPath, targetFolderId);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

function showSection(sectionName) {
  const login = sectionName === 'login';
  const billing = sectionName === 'billing';
  const upload = sectionName === 'upload';

  loginSection.classList.toggle('active', login);
  if (billingSetupSection) {
    billingSetupSection.classList.toggle('active', billing);
  }
  uploadSection.classList.toggle('active', upload);
}

function setBillingEmailLabel(email) {
  if (!billingEmailLabel) return;
  if (email) {
    billingEmailLabel.textContent = email;
    billingEmailLabel.classList.remove('placeholder');
    return;
  }
  billingEmailLabel.textContent = 'Pendiente';
  billingEmailLabel.classList.add('placeholder');
}

async function ensureBillingSetup(info, { forceSetup = false } = {}) {
  const driveEmail = info?.email || 'este email';
  const billingConfig = await ipcRenderer.invoke('get-billing-config');

  if (billingConfig?.configured && !forceSetup) {
    setBillingEmailLabel(billingConfig.email || null);
    await ipcRenderer.invoke('start-billing-monitor');
    return billingConfig;
  }

  if (billingQuestionText) {
    billingQuestionText.textContent = `Has iniciado sesión en Drive con ${driveEmail}. ¿Quieres recibir las facturas en este mismo email o en otro?`;
  }
  if (billingDifferentActions) {
    billingDifferentActions.style.display = 'none';
  }

  showSection('billing');

  return new Promise((resolve, reject) => {
    let resolved = false;

    const cleanUp = () => {
      if (billingSameBtn) billingSameBtn.onclick = null;
      if (billingDifferentBtn) billingDifferentBtn.onclick = null;
      if (billingLoginBtn) billingLoginBtn.onclick = null;
    };

    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      cleanUp();
      resolve(value);
    };

    if (billingSameBtn) {
      billingSameBtn.onclick = async () => {
        try {
          billingSameBtn.disabled = true;
          showStatus('Guardando email de facturas...', 'loading');
          const result = await ipcRenderer.invoke('set-billing-email-same');
          setBillingEmailLabel(result?.email || driveEmail || null);
          await ipcRenderer.invoke('start-billing-monitor');
          showStatus('Email de facturas configurado.', 'success');
          finish(result || { configured: true, mode: 'same', email: driveEmail });
        } catch (error) {
          billingSameBtn.disabled = false;
          showStatus(`Error al configurar email de facturas: ${error.message || error}`, 'error');
        }
      };
    }

    if (billingDifferentBtn) {
      billingDifferentBtn.onclick = () => {
        if (billingDifferentActions) {
          billingDifferentActions.style.display = 'block';
        }
      };
    }

    if (billingLoginBtn) {
      billingLoginBtn.onclick = async () => {
        try {
          billingLoginBtn.disabled = true;
          showStatus('Inicia sesión con el email que recibirá facturas...', 'loading');
          const billingUser = await ipcRenderer.invoke('google-login', false, 'billing');
          const billingEmail = billingUser?.email || null;
          setBillingEmailLabel(billingEmail);
          await ipcRenderer.invoke('start-billing-monitor');
          showStatus('Email de facturas alternativo configurado.', 'success');
          finish({ configured: true, mode: 'separate', email: billingEmail });
        } catch (error) {
          billingLoginBtn.disabled = false;
          showStatus(`Error en login del email de facturas: ${error.message || error}`, 'error');
        }
      };
    }
  });
}

// Verificar si ya hay sesión (se lanza tras login o recarga)
checkSession();

// Login con Google
loginBtn.addEventListener('click', async () => {
  try {
    loginBtn.textContent = 'Abriendo navegador...';
    loginBtn.disabled = true;
    showStatus('Se abrirá tu navegador para iniciar sesión con Google. Autoriza la app y vuelve aquí.', 'loading');

    await ipcRenderer.invoke('google-login', false);
    checkSession({ forceBillingSetup: true });

  } catch (error) {
    alert('Error al iniciar sesión: ' + error.message);
    loginBtn.textContent = 'Iniciar sesión con Google';
    loginBtn.disabled = false;
    document.getElementById('status').style.display = 'none';
  }
});

async function checkSession({ forceBillingSetup = false } = {}) {
  const info = await ipcRenderer.invoke('get-user-info');

  if (info && info.email) {
    try {
      toggleStartupOverlay(true, 'Sesión iniciada. Esperando sincronización con Drive...');
      showStatus('Sesión iniciada. Esperando sincronización con Drive...', 'loading');
      await new Promise(resolve => setTimeout(resolve, 15000));
      toggleStartupOverlay(true, 'Comprobando carpetas estándar en Drive...');
      showStatus('Comprobando carpetas estándar en Drive...', 'loading');
      await ipcRenderer.invoke('ensure-standard-folders');
      showStatus('Carpetas estándar verificadas en Drive.', 'success');
    } catch (folderError) {
      showStatus('Error al verificar carpetas estándar en Drive.', 'error');
      console.warn('No se pudieron crear carpetas estándar:', folderError);
    }
    // IMPORTANTE: quitar overlay antes de preguntar el email de facturas
    // para que la pantalla de selección sea usable y no se quede bloqueada.
    toggleStartupOverlay(false);
    await ensureBillingSetup(info, { forceSetup: forceBillingSetup });
    showUploadSection(info);
    await ipcRenderer.invoke('scan-no-procesado');
  } else {
    showSection('login');
    toggleStartupOverlay(false);
  }
}

// Nota: el login se gestiona en user.html. Esta página solo muestra la UI principal.

// Subir archivo a carpeta específica (albaranes o facturas) dentro de "No procesado"
async function uploadFilesToFolder(parentFolderName) {
  try {
    const filePaths = await ipcRenderer.invoke('select-file');

    if (filePaths && filePaths.length > 0) {
      try {
        showStatus('Comprobando carpetas estándar en Drive...', 'loading');
        await ipcRenderer.invoke('ensure-standard-folders');
        showStatus('Carpetas estándar verificadas en Drive.', 'success');
      } catch (folderError) {
        showStatus('Error al verificar carpetas estándar en Drive.', 'error');
        console.warn('No se pudieron crear carpetas estándar:', folderError);
      }
      const docType = (parentFolderName || '').toLowerCase().includes('factura') ? 'factura' : 'albaran';
      const parentFolder = await findFolderByName(parentFolderName, true);
      if (!parentFolder) {
        showStatus(`No se encontró la carpeta "${parentFolderName}" en Drive`, 'error');
        return;
      }

      const target = await getOrCreateNoProcesadoFolder(parentFolder.id);
      const targetLabel = `${parentFolderName}/No procesado`;

      let noComparadoFolder = null;
      let documentosFolder = null;
      try {
        noComparadoFolder = await getOrCreateChildFolder(parentFolder.id, 'No comparado');
        documentosFolder = await getOrCreateChildFolder(parentFolder.id, 'Documentos');
      } catch (folderError) {
        console.warn('No se pudo preparar carpeta No comparado:', folderError);
      }

      const preparedItems = [];

      for (const p of filePaths) {
        const fileName = pathBasename(p);
        const queueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        initQueueItem(queueId, fileName);

        try {
          updateQueueStep(queueId, 'Subiendo');
          showStatus(`Subiendo ${fileName}...`, 'loading');
          const uploadResult = await ipcRenderer.invoke('upload-file', p, target.id);
          if (!uploadResult || !uploadResult.success) {
            throw new Error('Error al subir archivo');
          }

          preparedItems.push({
            filePath: p,
            fileName,
            queueId,
            mimeType: guessMimeTypeFromPath(p),
            uploadResult,
            uploadedFileId: uploadResult?.file?.id || uploadResult?.fileId || uploadResult?.id
          });
        } catch (error) {
          markQueueError(queueId, error.message || 'Error desconocido');
          showStatus(`Error al subir ${fileName}: ${error.message}`, 'error');
        }
      }

      if (preparedItems.length > 0) {
        preparedItems.forEach(item => updateQueueStep(item.queueId, 'IA'));

        const batchResults = await invokeAnalyzeFilesBatchWithFallback(
          preparedItems.map(item => ({
            filePath: item.filePath,
            mimeType: item.mimeType,
            originalName: item.fileName
          })),
          docType
        );

        for (let idx = 0; idx < preparedItems.length; idx += 1) {
          const item = preparedItems[idx];
          const analysisResult = batchResults[idx] || null;

          try {
            const analysisSuccess = Boolean(
              analysisResult
              && analysisResult.success !== false
              && (analysisResult.analysis || analysisResult?.raw?.analysis)
            );
            if (!analysisSuccess) {
              throw new Error(analysisResult?.error || 'Error al analizar archivo');
            }

            const analysisText = analysisResult.analysis || analysisResult?.raw?.analysis || '';
            updateQueueStep(item.queueId, 'Enviando');

            if (noComparadoFolder?.id) {
              await uploadGeneratedTxtFiles(noComparadoFolder.id, analysisText, item.fileName);
              if (item.uploadedFileId) {
                await ipcRenderer.invoke('move-file', item.uploadedFileId, [noComparadoFolder.id], [target.id]);
              }
            }

            if (docType === 'factura') {
              try {
                const compareResult = await ipcRenderer.invoke('compare-factura-albaranes', {
                  facturaAnalysisText: analysisText,
                  rootFolderName: parentFolderName
                });

                if (compareResult && !compareResult.ok) {
                  try {
                    await ipcRenderer.invoke('send-email', {
                      to: 'bgoptimizing@gmail.com',
                      subject: `Incongruencias en factura ${item.fileName}`,
                      text: [
                        `Factura: ${item.fileName}`,
                        compareResult.message || 'Se encontraron incongruencias.',
                        '',
                        'Detalles:',
                        ...(compareResult.issues || []).map(issue => `- ${issue}`)
                      ].join('\n')
                    });
                    showStatus(`Email de incongruencias enviado para ${item.fileName}`, 'success');
                  } catch (emailError) {
                    console.error('Error enviando email de incongruencias:', emailError);
                    showStatus(`No se pudo enviar email de incongruencias: ${emailError.message || emailError}`, 'error');
                  }
                }

                if (documentosFolder?.id) {
                  const shouldMoveFactura = compareResult?.ok
                    || (compareResult?.matchedAlbaranes && compareResult.matchedAlbaranes.length > 0);
                  if (shouldMoveFactura) {
                    const targetId = documentosFolder.id;
                    const removeId = noComparadoFolder?.id || target.id;
                    if (item.uploadedFileId) {
                      await ipcRenderer.invoke('move-file', item.uploadedFileId, [targetId], removeId ? [removeId] : []);
                    }

                    const payload = buildTxtFilesFromAnalysis(analysisText, item.fileName);
                    if (payload?.files?.length) {
                      const txtContents = await ipcRenderer.invoke('list-contents', noComparadoFolder?.id || target.id);
                      const txtFiles = (txtContents?.files || []).filter(existing => existing.mimeType !== 'application/vnd.google-apps.folder');
                      for (const file of payload.files) {
                        const match = txtFiles.find(existing => (existing.name || '').toLowerCase() === (file.name || '').toLowerCase());
                        if (match) {
                          await ipcRenderer.invoke('move-file', match.id, [targetId], removeId ? [removeId] : []);
                        }
                      }
                    }
                  }
                }
              } catch (compareError) {
                console.warn('Error comparando factura con albaranes:', compareError);
              }
            }

            updateQueueStep(item.queueId, 'Enviado');
            const finalLabel = noComparadoFolder?.name
              ? `${parentFolderName}/No comparado`
              : targetLabel;
            showStatus(`¡${item.fileName} procesado y enviado a ${finalLabel}!`, 'success');
          } catch (error) {
            markQueueError(item.queueId, error.message || 'Error desconocido');
            showStatus(`Error al procesar ${item.fileName}: ${error.message}`, 'error');
          }
        }
      }

      await loadFolderContents(noComparadoFolder?.id || target.id, true, noComparadoFolder?.name || target.name || 'No procesado');
    }
  } catch (error) {
    showStatus('Error al subir archivo: ' + error.message, 'error');
  }
}

if (fileUpload) {
  fileUpload.addEventListener('click', async () => {
    await uploadFilesToFolder('Albaranes');
  });
}

let searchDebounce = null;

function renderSearchResults(items = [], query = '') {
  if (!searchResults) return;

  const trimmed = query.trim();
  if (!trimmed) {
    searchResults.classList.remove('active');
    searchResults.innerHTML = '';
    return;
  }

  searchResults.classList.add('active');
  searchResults.innerHTML = '';

  if (!items.length) {
    searchResults.innerHTML = '<p style="color:#666">No se encontraron documentos.</p>';
    return;
  }

  items.forEach(item => {
    const wrapper = document.createElement('div');
    wrapper.className = 'search-result-item';

    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = item.name || 'Documento';

    const path = document.createElement('div');
    path.className = 'search-result-path';
    const folderPath = item.folderPath || 'Mi unidad';
    path.textContent = folderPath;

    const actions = document.createElement('div');
    actions.className = 'search-result-actions';

    const openFileBtn = document.createElement('button');
    openFileBtn.className = 'btn small';
    openFileBtn.textContent = 'Abrir archivo';
    openFileBtn.addEventListener('click', () => {
      if (!item.id) return;
      const url = `https://drive.google.com/file/d/${item.id}/view`;
      ipcRenderer.invoke('open-external', url);
    });

    const openFolderBtn = document.createElement('button');
    openFolderBtn.className = 'btn small btn-secondary';
    openFolderBtn.textContent = 'Abrir carpeta';
    openFolderBtn.addEventListener('click', async () => {
      if (!item.parentId) return;
      await loadFolderContents(item.parentId, true, item.parentName || 'Carpeta');
    });

    actions.appendChild(openFileBtn);
    actions.appendChild(openFolderBtn);

    wrapper.appendChild(title);
    wrapper.appendChild(path);
    wrapper.appendChild(actions);
    searchResults.appendChild(wrapper);
  });
}

async function performSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    renderSearchResults([], '');
    return;
  }

  try {
    const response = await ipcRenderer.invoke('search-drive-files', trimmed);
    const items = Array.isArray(response?.files) ? response.files : [];
    renderSearchResults(items, trimmed);
  } catch (error) {
    console.error('Error en búsqueda:', error);
    renderSearchResults([], trimmed);
    showStatus('No se pudo completar la búsqueda', 'error');
  }
}

if (searchInput) {
  searchInput.addEventListener('input', (event) => {
    const value = event.target.value || '';
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      performSearch(value);
    }, 350);
  });
}

// Crear carpeta en Drive (desde UI)
const createFolderBtn = document.getElementById('create-folder-btn');
const createFolderNameInput = document.getElementById('create-folder-name');
const shareBtn = document.getElementById('share-btn');
const shareEmailsInput = document.getElementById('share-emails');
const noProcesadoShareBtn = document.getElementById('no-procesado-share-btn');
const noProcesadoShareEmailInput = document.getElementById('no-procesado-share-email');

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
    } catch (err) {
      showStatus('Error al compartir: ' + err.message, 'error');
    } finally {
      shareBtn.textContent = 'Compartir acceso';
      shareBtn.disabled = false;
    }
  });
}

if (noProcesadoShareBtn) {
  noProcesadoShareBtn.addEventListener('click', async () => {
    const email = noProcesadoShareEmailInput?.value.trim();
    if (!email) {
      showStatus('Por favor ingresa un email válido', 'error');
      return;
    }

    try {
      noProcesadoShareBtn.textContent = 'Compartiendo...';
      noProcesadoShareBtn.disabled = true;
      await ipcRenderer.invoke('share-no-procesado-albaranes', [email]);
      showStatus('Carpeta No procesado compartida', 'success');
      noProcesadoShareEmailInput.value = '';
    } catch (err) {
      showStatus('Error al compartir: ' + err.message, 'error');
    } finally {
      noProcesadoShareBtn.textContent = 'Compartir';
      noProcesadoShareBtn.disabled = false;
    }
  });
}

// // Refrescar listas de usuarios compartidos en la UI (admin y main)
// async function refreshSharedLists() {
//   try {
//     const info = await ipcRenderer.invoke('get-user-info');
//     const shared = (info && info.sharedEmails) ? info.sharedEmails : [];
//     let sharedNoProcesado = [];

//     try {
//       const noProcesadoResp = await ipcRenderer.invoke('get-no-procesado-shared-emails');
//       sharedNoProcesado = Array.isArray(noProcesadoResp?.emails) ? noProcesadoResp.emails : [];
//     } catch (e) {
//       console.warn('No se pudo leer permisos en vivo de No procesado:', e);
//       sharedNoProcesado = (info && info.sharedNoProcesadoEmails)
//         ? info.sharedNoProcesadoEmails
//         : [];
//     }

//     const sharedEmailsList = document.getElementById('shared-emails-list');
//     if (sharedEmailsList) {
//       sharedEmailsList.innerHTML = '';
//       if (shared.length === 0) {
//         sharedEmailsList.innerHTML = '<p style="color:#666">No hay usuarios con acceso</p>';
//       } else {
//         shared.forEach(email => {
//           const div = document.createElement('div');
//           div.className = 'shared-item';
//           div.innerHTML = `<span>${email}</span>`;
//           sharedEmailsList.appendChild(div);
//         });
//       }
//     }

//     const mainShared = document.getElementById('main-shared-list');
//     if (mainShared) {
//       mainShared.innerHTML = '';
//       if (shared.length === 0) {
//         mainShared.innerHTML = '<p style="color:#666">No hay usuarios con acceso</p>';
//       } else {
//         shared.forEach(email => {
//           const div = document.createElement('div');
//           div.className = 'shared-item';
//           div.textContent = email;
//           mainShared.appendChild(div);
//         });
//       }
//     }

//     const noProcesadoList = document.getElementById('no-procesado-shared-list');
//     if (noProcesadoList) {
//       noProcesadoList.innerHTML = '';
//       if (sharedNoProcesado.length === 0) {
//         noProcesadoList.innerHTML = '<p style="color:#666">No hay usuarios con acceso</p>';
//       } else {
//         sharedNoProcesado.forEach(email => {
//           const div = document.createElement('div');
//           div.className = 'shared-item';
//           div.textContent = email;
//           noProcesadoList.appendChild(div);
//         });
//       }
//     }
//   } catch (e) {
//     console.error('Error refrescando shared lists:', e);
//   }
// }

// Navegación de carpetas y listado de archivos (mejorado)
let currentFolderId = null;
let breadcrumb = [];
let folderTreeData = null;

async function loadFolderTree() {
  try {
    const res = await ipcRenderer.invoke('list-folders');
    const folders = Array.isArray(res) ? res : (res.folders || []);

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

async function findFolderByName(targetName, rootOnly = false) {
  try {
    if (rootOnly) {
      const res = await ipcRenderer.invoke('list-contents', null);
      const items = res.files || [];
      return items.find(item => item.mimeType === 'application/vnd.google-apps.folder'
        && (item.name || '').toLowerCase() === targetName.toLowerCase()) || null;
    }

    const res = await ipcRenderer.invoke('list-folders');
    const folders = Array.isArray(res) ? res : (res.folders || []);
    return folders.find(f => (f.name || '').toLowerCase() === targetName.toLowerCase()) || null;
  } catch (err) {
    console.error('Error buscando carpeta:', err);
    return null;
  }
}

async function getOrCreateNoProcesadoFolder(parentId) {
  try {
    const res = await ipcRenderer.invoke('list-contents', parentId);
    const folders = (res.files || []).filter(item => item.mimeType === 'application/vnd.google-apps.folder');
    let noProcesado = folders.find(folder => (folder.name || '').toLowerCase() === 'no procesado');

    if (!noProcesado) {
      const created = await ipcRenderer.invoke('create-folder', 'No procesado', parentId);
      noProcesado = { id: created.folderId, name: created.folderName || 'No procesado' };
    }

    return noProcesado;
  } catch (error) {
    console.error('Error obteniendo/creando No procesado:', error);
    throw new Error('Error al encontrar o crear carpeta No procesado');
  }
}

async function getOrCreateChildFolder(parentId, childName) {
  const res = await ipcRenderer.invoke('list-contents', parentId);
  const folders = (res.files || []).filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  let target = folders.find(folder => (folder.name || '').toLowerCase() === childName.toLowerCase());

  if (!target) {
    const created = await ipcRenderer.invoke('create-folder', childName, parentId);
    target = { id: created.folderId, name: created.folderName || childName };
  }

  return target;
}

async function navigateToFolderByName(targetName, rootOnly = false) {
  const folder = await findFolderByName(targetName, rootOnly);
  if (!folder) {
    showStatus(`No se encontró la carpeta "${targetName}" en Drive`, 'error');
    return;
  }
  await loadFolderContents(folder.id, true, folder.name);
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

    // Ocultar la opción de compartir cuando estamos en la raíz de Drive ('root' o null)
    try {
      const shareBtnEl = document.getElementById('share-btn');
      const shareInputEl = document.getElementById('share-emails');
      if (shareBtnEl && shareInputEl) {
        if (folderIdUsed === 'root' || folderIdUsed === null) {
          shareBtnEl.style.display = 'none';
          shareInputEl.style.display = 'none';
        } else {
          shareBtnEl.style.display = '';
          shareInputEl.style.display = '';
        }
      }
    } catch (e) {
      console.warn('No se pudo ajustar visibilidad de compartir:', e);
    }

    const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

    const folderTree = document.getElementById('folder-tree');
    const folderSummary = document.getElementById('folder-summary');
    const filesList = document.getElementById('files-list');

    // Render full folder tree (if present)
    if (folderTree && folderTreeData) {
      renderFolderTree(folderTree, folderTreeData, currentFolderId);
    }

    // Render lightweight summary instead of full file list
    const currentName = (breadcrumb[breadcrumb.length - 1] && breadcrumb[breadcrumb.length - 1].name)
      ? breadcrumb[breadcrumb.length - 1].name
      : (folderName || 'Mi unidad');
    const total = files.length;
    const folderCount = folders.length;
    const fileCount = docs.length;
    if (folderSummary) {
      const summaryHtml = `
        <h4 style="margin-bottom:8px;">${currentName}</h4>
        <p style="color:#555; margin-bottom:6px;">Contenido total: <strong>${total}</strong></p>
        <p style="color:#666; margin-bottom:4px;">Carpetas: <strong>${folderCount}</strong></p>
        <p style="color:#666;">Archivos: <strong>${fileCount}</strong></p>
      `;

      folderSummary.innerHTML = summaryHtml;
    }

    const currentNameLower = (currentName || '').toLowerCase();
    const showFiles = currentNameLower !== 'mi unidad';

    if (filesList) {
      if (!showFiles) {
        filesList.innerHTML = '';
        filesList.style.display = 'none';
      } else {
        filesList.style.display = '';
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
  showSection('upload');
  document.getElementById('user-email').textContent = info.email;
  const billingConfig = await ipcRenderer.invoke('get-billing-config');
  setBillingEmailLabel(billingConfig?.email || null);

  // Load the full folder tree
  await loadFolderTree();

  // start breadcrumb with root
  breadcrumb = [];
  // Use Drive root as "Mi unidad" (null) so the breadcrumb represents the real root
  const rootId = null;
  breadcrumb.push({ id: rootId, name: 'Mi unidad' });
  await loadFolderContents(null, false, 'Mi unidad');
}

// Enlazar botones de menú lateral
menuButtons.forEach(button => {
  button.addEventListener('click', async () => {
    const action = button.dataset.action;
    if (action === 'open-albaranes') {
      await navigateToFolderByName('Albaranes', true);
      return;
    }
    if (action === 'open-facturas') {
      await navigateToFolderByName('Facturas', true);
      return;
    }
    if (action === 'upload-albaran') {
      await uploadFilesToFolder('Albaranes', true);
      return;
    }
    if (action === 'upload-factura') {
      await uploadFilesToFolder('Facturas', true);
      return;
    }
  });
});

// Enlazar tarjetas principales
tileButtons.forEach(tile => {
  tile.addEventListener('click', async () => {
    const action = tile.dataset.action;
    if (tile.classList.contains('disabled')) {
      return;
    }
    if (action === 'bases-datos') {
      await ipcRenderer.invoke('open-bd-window');
      return;
    }

    if (action === 'facturas') {
      await navigateToFolderByName('Facturas', true);
      return;
    }
    if (action === 'albaranes') {
      await navigateToFolderByName('Albaranes', true);
      return;
    }
  });
});

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


function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  status.style.display = 'block';

  if (type === 'success' || type === 'error') {
    setTimeout(() => { status.style.display = 'none'; }, 5000);
  }
}

function toggleStartupOverlay(isVisible, message) {
  if (!startupOverlay) return;
  if (message && startupOverlayMessage) {
    startupOverlayMessage.textContent = message;
  }
  startupOverlay.classList.toggle('active', Boolean(isVisible));
}

ipcRenderer.on('startup-status', (event, payload) => {
  if (!startupStatusEl) return;
  const message = payload?.message || 'Estado de inicio: esperando...';
  startupStatusEl.textContent = message;
  // Mantener el indicador pequeño dentro de la UI durante el escaneo
  toggleStartupOverlay(false);
});

ipcRenderer.on('queue-event', (event, payload) => {
  if (!payload || !payload.id) return;

  if (payload.type === 'init') {
    initQueueItem(payload.id, payload.fileName || 'Archivo');
    return;
  }

  if (payload.type === 'step') {
    updateQueueStep(payload.id, payload.step);
    return;
  }

  if (payload.type === 'error') {
    markQueueError(payload.id, payload.message || 'Error');
  }
});

function initQueueItem(id, fileName) {
  uploadQueue.set(id, { fileName, status: 'Pendiente', error: null });
  renderQueue();
}

function updateQueueStep(id, step) {
  const item = uploadQueue.get(id);
  if (!item) return;
  item.status = step;
  item.error = null;
  uploadQueue.set(id, item);
  renderQueue();
}

function markQueueError(id, message) {
  const item = uploadQueue.get(id);
  if (!item) return;
  item.status = 'Error';
  item.error = message || 'Error';
  uploadQueue.set(id, item);
  renderQueue();
}

function renderQueue() {
  if (!queueList) return;

  if (uploadQueue.size === 0) {
    queueList.innerHTML = '<p style="color:#666">No hay archivos en cola.</p>';
    return;
  }

  queueList.innerHTML = '';
  Array.from(uploadQueue.entries()).forEach(([id, item]) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'queue-item';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.fileName;

    const statusRow = document.createElement('div');
    statusRow.className = 'status-row';

    QUEUE_STEPS.forEach(step => {
      const stepEl = document.createElement('div');
      stepEl.className = 'queue-step';
      stepEl.textContent = step;

      if (item.status === 'Error') {
        stepEl.classList.add('error');
      } else if (item.status === step) {
        stepEl.classList.add('active');
      } else if (QUEUE_STEPS.indexOf(step) < QUEUE_STEPS.indexOf(item.status)) {
        stepEl.classList.add('done');
      }

      statusRow.appendChild(stepEl);
    });

    if (item.error) {
      const errorText = document.createElement('div');
      errorText.style.color = '#721c24';
      errorText.style.fontSize = '12px';
      errorText.textContent = `Error: ${item.error}`;
      wrapper.appendChild(errorText);
    }

    wrapper.appendChild(name);
    wrapper.appendChild(statusRow);

    queueList.appendChild(wrapper);
  });
}