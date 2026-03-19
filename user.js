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
const canceledQueueIds = new Set();
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
const uploadDropModal = document.getElementById('upload-drop-modal');
const uploadDropZone = document.getElementById('upload-drop-zone');
const uploadDropClose = document.getElementById('upload-drop-close');
const uploadDropTitle = document.getElementById('upload-drop-title');

const DEFAULT_QUEUE_STEPS = ['Esperando', 'Subiendo', 'IA', 'Moviendo', 'Movido'];
const STARTUP_QUEUE_STEPS = ['Esperando', 'OCR', 'IA', 'Moviendo', 'Movido'];
const FACTURA_QUEUE_STEPS = ['Esperando', 'Subiendo', 'IA', 'Comparando', 'Comparado', 'Email'];
let currentUploadTargetFolder = null;
let uploadFlowTail = Promise.resolve();

function enqueueUploadFlow(task, meta = {}) {
  const runTask = async () => {
    const label = meta?.label || 'documentos';
    try {
      return await task();
    } catch (error) {
      throw error;
    }
  };

  const next = uploadFlowTail.then(runTask, runTask);
  uploadFlowTail = next.catch(() => {});
  return next;
}

function resolveQueueSteps({ source = '', docType = '', steps = null } = {}) {
  if (Array.isArray(steps) && steps.length > 0) {
    return [...steps];
  }

  const normalizedSource = String(source || '').toLowerCase();
  const normalizedDocType = String(docType || '').toLowerCase();

  if (normalizedDocType === 'factura' || normalizedSource === 'billing-email') {
    return [...FACTURA_QUEUE_STEPS];
  }

  if (normalizedSource === 'startup') {
    return [...STARTUP_QUEUE_STEPS];
  }

  return [...DEFAULT_QUEUE_STEPS];
}

const RENDERER_LOG_PREFIX = '[Frontend-User]';

function serializeUiError(error) {
  if (!error) return null;
  return {
    message: error.message,
    name: error.name,
    stack: error.stack
  };
}

function uiLog(level = 'log', message = '', data = undefined) {
  const normalizedLevel = String(level || '').toLowerCase();
  if (normalizedLevel !== 'error') {
    return;
  }

  const method = 'error';
  const timestamp = new Date().toISOString();
  if (data === undefined) {
    console[method](`${RENDERER_LOG_PREFIX} ${timestamp} ${message}`);
    return;
  }
  console[method](`${RENDERER_LOG_PREFIX} ${timestamp} ${message}`, data);
}

window.addEventListener('error', (event) => {
  uiLog('error', 'window.error', {
    message: event?.message,
    filename: event?.filename,
    lineno: event?.lineno,
    colno: event?.colno,
    error: serializeUiError(event?.error)
  });
});

window.addEventListener('unhandledrejection', (event) => {
  uiLog('error', 'window.unhandledrejection', {
    reason: serializeUiError(event?.reason) || event?.reason
  });
});

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

async function invokeAnalyzeFileWithFallback(filePath, mimeType, originalName, docType, postProcess = null) {
  uiLog('log', 'invokeAnalyzeFileWithFallback:start', {
    filePath,
    mimeType,
    originalName,
    docType
  });
  try {
    const result = await ipcRenderer.invoke('analyze-file', filePath, mimeType, originalName, docType, postProcess);
    uiLog('log', 'invokeAnalyzeFileWithFallback:ok', { docType, hasAnalysis: Boolean(result?.analysis) });
    return result;
  } catch (error) {
    uiLog('warn', 'invokeAnalyzeFileWithFallback:error', { error: serializeUiError(error) });
    const message = String(error?.message || '');
    if (message.includes("No handler registered for 'analyze-file'")) {
      uiLog('warn', 'invokeAnalyzeFileWithFallback:using-legacy-handler', { docType });
      return ipcRenderer.invoke('analyze-document', filePath, mimeType, originalName, docType);
    }
    throw error;
  }
}

async function invokeAnalyzeFilesBatchWithFallback(items = [], docType = 'albaran') {
  const validItems = (Array.isArray(items) ? items : []).filter(item => item?.filePath);
  if (!validItems.length) return [];

  uiLog('log', 'invokeAnalyzeFilesBatchWithFallback:start', {
    docType,
    items: validItems.length
  });

  try {
    const results = await ipcRenderer.invoke('analyze-files-batch', validItems, docType);
    if (Array.isArray(results) && results.length) {
      uiLog('log', 'invokeAnalyzeFilesBatchWithFallback:ok', {
        docType,
        results: results.length
      });
      return results;
    }
    throw new Error('Batch IA sin resultados');
  } catch (error) {
    const message = String(error?.message || '');
    if (!message.includes("No handler registered for 'analyze-files-batch'")) {
      console.warn('Batch IA falló en renderer; fallback individual:', error);
    }
    uiLog('warn', 'invokeAnalyzeFilesBatchWithFallback:fallback-individual', {
      docType,
      error: serializeUiError(error)
    });

    const fallback = [];
    for (const item of validItems) {
      try {
        const single = await invokeAnalyzeFileWithFallback(
          item.filePath,
          item.mimeType || '',
          item.originalName || '',
          docType,
          item.postProcess || null
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

function getFacturaReferenceForEmail(analysisText, fallback = 'XX') {
  try {
    const sections = extractAnalysisSections(analysisText);
    if (sections?.isFactura && sections?.resumenRaw) {
      const resumenLine = sections.resumenRaw.split(/\r?\n/).find(line => line.trim());
      if (resumenLine) {
        const resumenObj = JSON.parse(resumenLine);
        const facturaNum = resumenObj?.num_factura;
        if (facturaNum && facturaNum !== 'NaN') {
          return sanitizeFileName(facturaNum);
        }
      }
    }
  } catch (e) {
    // fallback
  }

  const fallbackBase = path.basename(String(fallback || 'XX'), path.extname(String(fallback || '')));
  return sanitizeFileName(fallbackBase || 'XX');
}

function normalizeConfidenceToPercent(rawConfidence) {
  const value = Number(rawConfidence);
  if (!Number.isFinite(value)) return null;

  if (value >= 0 && value <= 1) {
    return value * 100;
  }

  if (value >= 0 && value <= 100) {
    return value;
  }

  return null;
}

function buildModelConfidenceEmailLines(analysisText) {
  let confidenceRaw = null;

  try {
    const sections = extractAnalysisSections(analysisText);
    if (sections?.isFactura && sections?.resumenRaw) {
      const resumenLine = sections.resumenRaw.split(/\r?\n/).find(line => line.trim());
      if (resumenLine) {
        const resumenObj = JSON.parse(resumenLine);
        confidenceRaw = resumenObj?.confidence;
      }
    }
  } catch (e) {
    confidenceRaw = null;
  }

  const confidencePercent = normalizeConfidenceToPercent(confidenceRaw);

  if (confidencePercent === null) {
    return ['Seguridad del modelo: No disponible'];
  }

  const roundedPercent = Math.round(confidencePercent * 10) / 10;
  const lines = [`Seguridad del modelo: ${roundedPercent}%`];

  if (confidencePercent < 70) {
    lines.push('⚠️ CUIDADO: baja seguridad del modelo (< 70%).');
  }

  return lines;
}

function extractModelConfidenceValue(analysisText) {
  let confidenceRaw = null;

  try {
    const sections = extractAnalysisSections(analysisText);
    if (sections?.isFactura && sections?.resumenRaw) {
      const resumenLine = sections.resumenRaw.split(/\r?\n/).find(line => line.trim());
      if (resumenLine) {
        const resumenObj = JSON.parse(resumenLine);
        confidenceRaw = resumenObj?.confidence;
      }
    }
  } catch (e) {
    confidenceRaw = null;
  }

  const value = Number(confidenceRaw);
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return value;
  if (value >= 0 && value <= 100) return value / 100;
  return null;
}

function getIssueCountByAlbaran(compareResult = {}) {
  const counts = new Map();
  const issues = Array.isArray(compareResult?.issues) ? compareResult.issues : [];
  let currentAlbaran = null;

  for (const raw of issues) {
    const line = String(raw || '').trim();
    const matchHeader = line.match(/^Albar[aá]n\s+(.+?):$/i);
    if (matchHeader) {
      currentAlbaran = String(matchHeader[1] || '').trim() || null;
      if (currentAlbaran && !counts.has(currentAlbaran)) {
        counts.set(currentAlbaran, 0);
      }
      continue;
    }

    if (currentAlbaran && line.startsWith('-')) {
      counts.set(currentAlbaran, (counts.get(currentAlbaran) || 0) + 1);
    }
  }

  if (!counts.size) {
    const fallback = Array.isArray(compareResult?.incongruentAlbaranes)
      ? compareResult.incongruentAlbaranes
      : [];
    fallback.forEach((num) => counts.set(String(num || '').trim(), 1));
  }

  return counts;
}

function normalizeIssueDetail(rawLine = '') {
  return String(rawLine || '').replace(/^\-\s*/, '').trim();
}

function isArticleNotFoundIssue(issueDetail = '') {
  const detail = String(issueDetail || '');
  return /art[ií]culo/i.test(detail) && /no encontrado/i.test(detail);
}

function isZeroComparisonIssue(issueDetail = '') {
  const detail = String(issueDetail || '');
  if (!/^Cantidad distinta para|^Importe distinto para/i.test(detail)) {
    return false;
  }

  const match = detail.match(/factura=([-+]?\d*\.?\d+),\s*albar[aá]n=([-+]?\d*\.?\d+)/i);
  if (!match) return false;

  const facturaValue = Number(match[1]);
  const albaranValue = Number(match[2]);
  if (!Number.isFinite(facturaValue) || !Number.isFinite(albaranValue)) {
    return false;
  }

  return Math.abs(facturaValue) < 1e-9 || Math.abs(albaranValue) < 1e-9;
}

function evaluateEmptyUploadPattern(compareResult = {}) {
  const issues = Array.isArray(compareResult?.issues) ? compareResult.issues : [];
  const detailedIssues = issues
    .map(line => String(line || '').trim())
    .filter(line => line.startsWith('-'))
    .map(normalizeIssueDetail)
    .filter(Boolean);

  if (!detailedIssues.length) {
    return {
      shouldWarnEmptyUpload: false,
      detailedIssueCount: 0,
      suspiciousIssueCount: 0
    };
  }

  const suspiciousIssueCount = detailedIssues.filter((issue) => (
    isArticleNotFoundIssue(issue) || isZeroComparisonIssue(issue)
  )).length;

  return {
    shouldWarnEmptyUpload: detailedIssues.length > 8 && suspiciousIssueCount === detailedIssues.length,
    detailedIssueCount: detailedIssues.length,
    suspiciousIssueCount
  };
}

function buildPrimaryEmailIssueLines(compareResult = {}, severeAlbaranes = []) {
  const severeSet = new Set((Array.isArray(severeAlbaranes) ? severeAlbaranes : []).map(num => String(num || '').trim()));
  const sourceIssues = Array.isArray(compareResult?.issues) ? compareResult.issues : [];
  const normalizedIssues = [];
  let currentAlbaran = null;
  let currentIsSevere = false;

  for (const rawLine of sourceIssues) {
    const line = String(rawLine || '').trim();
    const headerMatch = line.match(/^Albar[aá]n\s+(.+?):$/i);

    if (headerMatch) {
      currentAlbaran = String(headerMatch[1] || '').trim();
      currentIsSevere = severeSet.has(currentAlbaran);
      normalizedIssues.push(line);
      if (currentIsSevere) {
        normalizedIssues.push('- REVISAR EL EMAIL IMPORTANTE');
      }
      continue;
    }

    if (currentIsSevere && line.startsWith('-')) {
      continue;
    }

    normalizedIssues.push(line);
  }

  return normalizedIssues;
}

function buildCriticalAlertContext(compareResult = {}, analysisText = '') {
  const confidence = extractModelConfidenceValue(analysisText);
  const lowConfidence = confidence !== null && confidence < 0.75;
  const issuesByAlbaran = getIssueCountByAlbaran(compareResult);
  const severeAlbaranes = Array.from(issuesByAlbaran.entries())
    .filter(([, issueCount]) => issueCount > 6)
    .map(([albaranNum]) => albaranNum);
  const emptyUploadPattern = evaluateEmptyUploadPattern(compareResult);

  return {
    shouldSend: lowConfidence || severeAlbaranes.length > 0,
    confidence,
    lowConfidence,
    severeAlbaranes,
    issuesByAlbaran,
    emptyUploadPattern
  };
}

function extractExtractionWarningsFromAnalysis(analysisText) {
  if (!analysisText) return [];
  const marker = '=== EXTRACTION WARNINGS (JSON) ===';
  const text = analysisText.toString();
  if (!text.includes(marker)) return [];

  const afterMarker = text.split(marker)[1] || '';
  const firstLine = afterMarker
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  if (!firstLine) return [];

  try {
    const parsed = JSON.parse(firstLine);
    return Array.isArray(parsed)
      ? parsed.map(item => String(item || '').trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function buildExtractionWarningsEmailLines(analysisText) {
  const warnings = extractExtractionWarningsFromAnalysis(analysisText);
  if (!warnings.length) {
    return ['Warnings de extracción: ninguno'];
  }

  return [
    `Warnings de extracción (${warnings.length}):`,
    ...warnings.map(w => `- ${w}`)
  ];
}

function getComparedAlbaranesLabel(compareResult = {}) {
  const fromExpected = Array.isArray(compareResult?.expectedAlbaranes)
    ? compareResult.expectedAlbaranes
    : [];
  const fromMatched = Array.isArray(compareResult?.matchedAlbaranes)
    ? compareResult.matchedAlbaranes
    : [];

  const source = fromExpected.length ? fromExpected : fromMatched;
  const normalized = source
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return normalized.length ? normalized.join(', ') : 'N/A';
}

function buildDriveFileLink(fileId) {
  if (!fileId) return null;
  return `https://drive.google.com/file/d/${fileId}/view`;
}

function buildIncongruentAlbaranesLinks(compareResult = {}) {
  const docs = Array.isArray(compareResult?.incongruentAlbaranDocs)
    ? compareResult.incongruentAlbaranDocs
    : [];
  if (docs.length) {
    return docs.map((doc) => {
      const num = doc?.albaranNum || 'N/A';
      const fileName = doc?.fileName || 'Nombre no disponible';
      const url = doc?.url || buildDriveFileLink(doc?.fileId) || 'No disponible';
      return `- Albarán ${num} (${fileName}): ${url}`;
    });
  }

  const nums = Array.isArray(compareResult?.incongruentAlbaranes)
    ? compareResult.incongruentAlbaranes
    : [];
  if (!nums.length) {
    return ['- No disponible'];
  }

  return nums.map((num) => `- Albarán ${num} (nombre no disponible): link no disponible`);
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatIncongruentAlbaranLineHtml(line = '') {
  const cleaned = String(line || '').replace(/^\-\s*/, '').trim();
  const match = cleaned.match(/^Albar[aá]n\s+(.+?)\s+\((.+?)\):\s*(.+)$/i);
  if (!match) return escapeHtml(cleaned);

  const [, num, fileName, urlRaw] = match;
  const safeNum = escapeHtml(num);
  const safeName = escapeHtml(fileName);
  const safeUrl = escapeHtml(urlRaw);
  const hasLink = /^https?:\/\//i.test(String(urlRaw || '').trim());
  const urlHtml = hasLink ? `<a href="${safeUrl}">Abrir en Drive</a>` : safeUrl;

  return `Albarán <strong>${safeNum}</strong> (<strong>${safeName}</strong>): ${urlHtml}`;
}

function formatCongruentAlbaranLineHtml(line = '') {
  const cleaned = String(line || '').replace(/^\-\s*/, '').trim();
  const match = cleaned.match(/^Albar[aá]n\s+(.+?):\s*(.+)$/i);
  if (!match) return escapeHtml(cleaned);

  const [, num, fileName] = match;
  return `Albarán <strong>${escapeHtml(num)}</strong>: <strong>${escapeHtml(fileName)}</strong>`;
}

function toHtmlList(lines = [], formatter = (line) => escapeHtml(line), emptyText = 'No disponible') {
  if (!Array.isArray(lines) || !lines.length) {
    return `<li>${escapeHtml(emptyText)}</li>`;
  }

  return lines
    .map((line) => `<li>${formatter(line)}</li>`)
    .join('');
}

function buildCongruentAlbaranesSummary(compareResult = {}) {
  const docs = Array.isArray(compareResult?.congruentAlbaranDocs)
    ? compareResult.congruentAlbaranDocs
    : [];

  if (docs.length) {
    return docs.map((doc) => {
      const num = doc?.albaranNum || 'N/A';
      const fileName = doc?.fileName || 'Nombre no disponible';
      return `- Albarán ${num}: ${fileName}`;
    });
  }

  const matched = Array.isArray(compareResult?.matchedAlbaranes)
    ? compareResult.matchedAlbaranes
    : [];
  const incongruent = new Set(
    (Array.isArray(compareResult?.incongruentAlbaranes) ? compareResult.incongruentAlbaranes : [])
      .map((num) => String(num || '').trim())
      .filter(Boolean)
  );

  const congruentNums = matched
    .map((num) => String(num || '').trim())
    .filter((num) => num && !incongruent.has(num));

  if (!congruentNums.length) {
    return ['- No disponible'];
  }

  return congruentNums.map((num) => `- Albarán ${num}: nombre no disponible`);
}

async function getCurrentSessionEmail() {
  const info = await ipcRenderer.invoke('get-user-info');
  const email = info?.email || null;
  if (!email) {
    throw new Error('No se pudo obtener el email del usuario en sesión');
  }
  return email;
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
  uiLog('log', 'ensureBillingSetup:start', { driveEmail, forceSetup });
  const billingConfig = await ipcRenderer.invoke('get-billing-config');

  if (billingConfig?.configured && !forceSetup) {
    uiLog('log', 'ensureBillingSetup:already-configured', billingConfig);
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
          uiLog('log', 'ensureBillingSetup:set-billing-email-same:ok', result);
          setBillingEmailLabel(result?.email || driveEmail || null);
          await ipcRenderer.invoke('start-billing-monitor');
          showStatus('Email de facturas configurado.', 'success');
          finish(result || { configured: true, mode: 'same', email: driveEmail });
        } catch (error) {
          uiLog('error', 'ensureBillingSetup:set-billing-email-same:error', serializeUiError(error));
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
          uiLog('log', 'ensureBillingSetup:billing-login:ok', { billingEmail });
          setBillingEmailLabel(billingEmail);
          await ipcRenderer.invoke('start-billing-monitor');
          showStatus('Email de facturas alternativo configurado.', 'success');
          finish({ configured: true, mode: 'separate', email: billingEmail });
        } catch (error) {
          uiLog('error', 'ensureBillingSetup:billing-login:error', serializeUiError(error));
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
  uiLog('log', 'login button:click');
  try {
    loginBtn.textContent = 'Abriendo navegador...';
    loginBtn.disabled = true;
    showStatus('Se abrirá tu navegador para iniciar sesión con Google. Autoriza la app y vuelve aquí.', 'loading');

    await ipcRenderer.invoke('google-login', false);
    uiLog('log', 'login button:google-login:ok');
    checkSession({ forceBillingSetup: true });

  } catch (error) {
    uiLog('error', 'login button:google-login:error', serializeUiError(error));
    alert('Error al iniciar sesión: ' + error.message);
    loginBtn.textContent = 'Iniciar sesión con Google';
    loginBtn.disabled = false;
    document.getElementById('status').style.display = 'none';
  }
});

async function checkSession({ forceBillingSetup = false } = {}) {
  uiLog('log', 'checkSession:start', { forceBillingSetup });
  const info = await ipcRenderer.invoke('get-user-info');

  if (info && info.email) {
    uiLog('log', 'checkSession:session-found', { email: info.email });
    try {
      toggleStartupOverlay(true, 'Comprobando carpetas estándar en Drive...');
      showStatus('Comprobando carpetas estándar en Drive...', 'loading');
      await ipcRenderer.invoke('ensure-standard-folders');
      uiLog('log', 'checkSession:ensure-standard-folders:ok');
      showStatus('Carpetas estándar verificadas en Drive.', 'success');
    } catch (folderError) {
      uiLog('error', 'checkSession:ensure-standard-folders:error', serializeUiError(folderError));
      showStatus('Error al verificar carpetas estándar en Drive.', 'error');
      console.warn('No se pudieron crear carpetas estándar:', folderError);
    }
    // IMPORTANTE: quitar overlay antes de preguntar el email de facturas
    // para que la pantalla de selección sea usable y no se quede bloqueada.
    toggleStartupOverlay(false);
    await ensureBillingSetup(info, { forceSetup: forceBillingSetup });
    uiLog('log', 'checkSession:billing-setup:ok');
    showUploadSection(info);
    await ipcRenderer.invoke('scan-no-procesado');
    uiLog('log', 'checkSession:scan-no-procesado:ok');
  } else {
    uiLog('warn', 'checkSession:no-active-session');
    showSection('login');
    toggleStartupOverlay(false);
  }
}

// Nota: el login se gestiona en user.html. Esta página solo muestra la UI principal.

// Subir archivo a carpeta específica (albaranes o facturas) dentro de "No procesado"
async function uploadFilesToFolder(parentFolderName, selectedFilePaths = null) {
  uiLog('log', 'uploadFilesToFolder:start', { parentFolderName });
  try {
    const preQueuedItems = (Array.isArray(selectedFilePaths) && selectedFilePaths.length > 0
      && selectedFilePaths.every(item => item && typeof item === 'object' && item.filePath))
      ? selectedFilePaths
      : null;

    const filePaths = preQueuedItems
      ? preQueuedItems.map(item => item.filePath)
      : ((Array.isArray(selectedFilePaths) && selectedFilePaths.length > 0)
        ? selectedFilePaths
        : await ipcRenderer.invoke('select-file'));
    uiLog('log', 'uploadFilesToFolder:selected-files', { count: filePaths?.length || 0 });

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
      uiLog('log', 'uploadFilesToFolder:target-folder', {
        parentFolderName,
        targetId: target?.id
      });
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

      for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex += 1) {
        const p = filePaths[fileIndex];
        const fileName = pathBasename(p);
        const queueId = preQueuedItems?.[fileIndex]?.queueId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        if (!preQueuedItems?.[fileIndex]) {
          initQueueItem(queueId, fileName, { docType });
        }

        if (canceledQueueIds.has(queueId)) {
          markQueueCancelled(queueId);
          showStatus(`${fileName} cancelado antes de subir.`, 'success');
          continue;
        }

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
        uiLog('log', 'uploadFilesToFolder:analyzing-items', {
          parentFolderName,
          count: preparedItems.length,
          docType
        });
        preparedItems.forEach(item => updateQueueStep(item.queueId, 'IA'));

        const batchResults = await invokeAnalyzeFilesBatchWithFallback(
          preparedItems.map(item => ({
            filePath: item.filePath,
            mimeType: item.mimeType,
            originalName: item.fileName,
            postProcess: {
              txtFolderId: noComparadoFolder?.id || null,
              sourceDriveFileId: item.uploadedFileId || null,
              sourceDriveFromFolderId: target?.id || null,
              sourceDriveToFolderId: noComparadoFolder?.id || null,
              sourceFileName: item.fileName
            }
          })),
          docType
        );

        for (let idx = 0; idx < preparedItems.length; idx += 1) {
          const item = preparedItems[idx];
          const analysisResult = batchResults[idx] || null;

          try {
            if (canceledQueueIds.has(item.queueId)) {
              markQueueCancelled(item.queueId);
              showStatus(`${item.fileName} cancelado.`, 'success');
              continue;
            }

            const analysisSuccess = Boolean(
              analysisResult
              && analysisResult.success !== false
              && (analysisResult.analysis || analysisResult?.raw?.analysis)
            );
            if (!analysisSuccess) {
              throw new Error(analysisResult?.error || 'Error al analizar archivo');
            }

            uiLog('log', 'uploadFilesToFolder:item-analysis-ok', {
              fileName: item.fileName,
              docType
            });

            const analysisText = analysisResult.analysis || analysisResult?.raw?.analysis || '';
            if (docType !== 'factura') {
              updateQueueStep(item.queueId, 'Enviando');
            }

            if (canceledQueueIds.has(item.queueId)) {
              markQueueCancelled(item.queueId);
              showStatus(`${item.fileName} cancelado.`, 'success');
              continue;
            }

            if (docType === 'factura') {
              try {
                updateQueueStep(item.queueId, 'Comparando');
                const compareResult = await ipcRenderer.invoke('compare-factura-albaranes', {
                  facturaAnalysisText: analysisText,
                  rootFolderName: parentFolderName
                });
                updateQueueStep(item.queueId, 'comparado');

                uiLog('log', 'uploadFilesToFolder:factura-compare-result', {
                  fileName: item.fileName,
                  ok: compareResult?.ok,
                  issues: compareResult?.issues?.length || 0,
                  matchedAlbaranes: compareResult?.matchedAlbaranes?.length || 0
                });

                updateQueueStep(item.queueId, 'email');

                const facturaRef = getFacturaReferenceForEmail(analysisText, item.fileName || 'XX');
                const albaranesLabel = getComparedAlbaranesLabel(compareResult);
                const confidenceLines = buildModelConfidenceEmailLines(analysisText);
                const extractionWarningsLines = buildExtractionWarningsEmailLines(analysisText);
                const recipientEmail = await getCurrentSessionEmail();
                const criticalAlert = buildCriticalAlertContext(compareResult, analysisText);

                if (compareResult && !compareResult.ok) {
                  try {
                    const facturaDriveLink = buildDriveFileLink(item.uploadedFileId);
                    const incongruentAlbaranLinks = buildIncongruentAlbaranesLinks(compareResult);
                    const congruentAlbaranSummary = buildCongruentAlbaranesSummary(compareResult);
                    const compareIssues = buildPrimaryEmailIssueLines(compareResult, criticalAlert.severeAlbaranes);
                    const htmlIncongruentLinks = toHtmlList(
                      incongruentAlbaranLinks,
                      formatIncongruentAlbaranLineHtml,
                      'No disponible'
                    );
                    const htmlCongruentSummary = toHtmlList(
                      congruentAlbaranSummary,
                      formatCongruentAlbaranLineHtml,
                      'No disponible'
                    );
                    const htmlIssues = compareIssues.length
                      ? compareIssues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')
                      : '<li>Sin detalle adicional</li>';

                    await ipcRenderer.invoke('send-email', {
                      to: recipientEmail,
                      subject: `${item.fileName || 'Factura'} Incongruencias encontradas en factura ${facturaRef}`,
                      text: [
                        'ALERTA DE COMPARACIÓN: FACTURA CON INCONGRUENCIAS',
                        '',
                        `Factura comparada: ${facturaRef}`,
                        `Nombre archivo factura: ${item.fileName || 'N/A'}`,
                        `Albaranes comparados: ${albaranesLabel}`,
                        '',
                        '=== RESUMEN DEL MODELO ===',
                        ...confidenceLines,
                        '',
                        '=== WARNINGS DE EXTRACCIÓN ===',
                        ...extractionWarningsLines,
                        '',
                        '=== FACTURA ORIGINAL ===',
                        `Link factura original: ${facturaDriveLink || 'No disponible'}`,
                        '',
                        '=== ALBARANES CON INCONGRUENCIAS (número y nombre) ===',
                        'Links albaranes con incongruencias:',
                        ...incongruentAlbaranLinks,
                        '',
                        '=== ALBARANES CORRECTOS (número y nombre) ===',
                        'Albaranes correctos (número y nombre guardado):',
                        ...congruentAlbaranSummary,
                        '',
                        '=== RESUMEN DE COMPARACIÓN ===',
                        compareResult.message || 'Se encontraron incongruencias.',
                        '',
                        '=== DETALLES ===',
                        ...compareIssues.map(issue => `- ${issue}`)
                      ].join('\n'),
                      html: `
                        <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
                          <h2 style="margin: 0 0 12px; color: #8a1c1c;">⚠️ <strong>Incongruencias encontradas</strong></h2>

                          <div style="background:#f8f9fb; border:1px solid #e6e9ef; border-radius:8px; padding:12px; margin-bottom:12px;">
                            <p style="margin:0 0 6px;"><strong>Factura comparada:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
                            <p style="margin:0 0 6px;"><strong>Nombre archivo factura:</strong> <strong>${escapeHtml(item.fileName || 'N/A')}</strong></p>
                            <p style="margin:0;"><strong>Albaranes comparados:</strong> <strong>${escapeHtml(albaranesLabel)}</strong></p>
                          </div>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">🔎 Resumen del modelo</h3>
                            <p style="margin:0;"><strong>Seguridad del modelo:</strong><br>${escapeHtml(confidenceLines.join(' | '))}</p>
                          </div>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">🧾 Warnings de extracción</h3>
                            <p style="margin:0;">${escapeHtml(extractionWarningsLines.join(' | '))}</p>
                          </div>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">📄 Factura original</h3>
                            <p style="margin:0;">${facturaDriveLink ? `<a href="${escapeHtml(facturaDriveLink)}">Abrir factura en Drive</a>` : 'No disponible'}</p>
                          </div>

                          <hr style="border:none; border-top:1px solid #eceff3; margin:16px 0;" />

                          <h3 style="margin:0 0 8px; font-size:15px;">❌ Albaranes con incongruencias</h3>
                          <ul style="margin-top:0;">${htmlIncongruentLinks}</ul>

                          <h3 style="margin:14px 0 8px; font-size:15px;">✅ Albaranes correctos</h3>
                          <ul style="margin-top:0;">${htmlCongruentSummary}</ul>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">📌 Resumen</h3>
                            <p style="margin:0;">${escapeHtml(compareResult.message || 'Se encontraron incongruencias.')}</p>
                          </div>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">🧩 Detalles</h3>
                            <ul style="margin-top:0;">${htmlIssues}</ul>
                          </div>
                        </div>
                      `
                    });
                    showStatus(`Email de incongruencias enviado para ${item.fileName}`, 'success');

                    if (criticalAlert.shouldSend) {
                      const failedAlbaranes = (Array.isArray(compareResult?.incongruentAlbaranes)
                        ? compareResult.incongruentAlbaranes
                        : [])
                        .map(num => String(num || '').trim())
                        .filter(Boolean);
                      const confidenceValue = criticalAlert.confidence;
                      const confidenceLabel = confidenceValue === null
                        ? 'No disponible'
                        : `${(Math.round(confidenceValue * 10000) / 100).toFixed(2)}%`;
                      const severeAlbaranesLabel = criticalAlert.severeAlbaranes.length
                        ? criticalAlert.severeAlbaranes.join(', ')
                        : 'Ninguno';
                      const emergencyEmptyUploadWarning = criticalAlert.emptyUploadPattern?.shouldWarnEmptyUpload
                        ? 'REVISAR SI SE HA SUBIDO EL ALBARÁN BIEN PORQUE SALE COMO VACÍO O CON MUCHOS ERRORES'
                        : null;

                      await ipcRenderer.invoke('send-email', {
                        to: recipientEmail,
                        subject: `ERROR IMPORTANTE (${item.fileName || 'archivo'})`,
                        text: [
                          'Se han encontrado incongruencias críticas en este archivo y necesita revisión humana.',
                          '',
                          '=== DATOS PRINCIPALES ===',
                          `Nombre archivo: ${item.fileName || 'N/A'}`,
                          `Número de factura: ${facturaRef}`,
                          `Albaranes fallados: ${failedAlbaranes.length ? failedAlbaranes.join(', ') : 'N/A'}`,
                          '',
                          '=== ALERTAS ===',
                          `Confianza IA: ${confidenceLabel}`,
                          `Albaranes con más de 6 incongruencias: ${severeAlbaranesLabel}`,
                          ...(emergencyEmptyUploadWarning ? [emergencyEmptyUploadWarning] : []),
                          '',
                          '=== ENLACES ===',
                          `Link de Drive (factura): ${facturaDriveLink || 'No disponible'}`,
                          'Links de albaranes fallados:',
                          ...incongruentAlbaranLinks,
                          '',
                          'Acción requerida: revisión humana.'
                        ].join('\n'),
                        html: `
                          <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
                            <h2 style="margin:0 0 12px; color:#8a1c1c;">🚨 <strong>ERROR IMPORTANTE</strong></h2>
                            <p>Se han detectado <strong>incongruencias críticas</strong> y este archivo requiere <strong>revisión humana</strong>.</p>

                            <div style="background:#fff6f6; border:1px solid #f0d7d7; border-radius:8px; padding:12px; margin:12px 0;">
                              <p style="margin:0 0 6px;"><strong>Nombre archivo:</strong> <strong>${escapeHtml(item.fileName || 'N/A')}</strong></p>
                              <p style="margin:0 0 6px;"><strong>Número de factura:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
                              <p style="margin:0;"><strong>Albaranes fallados:</strong> <strong>${escapeHtml(failedAlbaranes.length ? failedAlbaranes.join(', ') : 'N/A')}</strong></p>
                            </div>

                            <h3 style="margin:14px 0 8px; font-size:15px;">⚠️ Alertas</h3>
                            <ul style="margin-top:0;">
                              <li><strong>Confianza IA:</strong> ${escapeHtml(confidenceLabel)}</li>
                              <li><strong>Albaranes con más de 6 incongruencias:</strong> ${escapeHtml(severeAlbaranesLabel)}</li>
                              ${emergencyEmptyUploadWarning ? `<li><strong>${escapeHtml(emergencyEmptyUploadWarning)}</strong></li>` : ''}
                            </ul>

                            <h3 style="margin:14px 0 8px; font-size:15px;">🔗 Enlaces</h3>
                            <p style="margin:0 0 8px;"><strong>Factura:</strong> ${facturaDriveLink ? `<a href="${escapeHtml(facturaDriveLink)}">Abrir en Drive</a>` : 'No disponible'}</p>
                            <ul style="margin-top:0;">${toHtmlList(incongruentAlbaranLinks, formatIncongruentAlbaranLineHtml, 'No disponible')}</ul>

                            <p style="margin-top:12px;"><em>Acción requerida: revisión humana.</em></p>
                          </div>
                        `
                      });
                    }
                  } catch (emailError) {
                    console.error('Error enviando email de incongruencias:', emailError);
                    showStatus(`No se pudo enviar email de incongruencias: ${emailError.message || emailError}`, 'error');
                    throw emailError;
                  }
                } else if (compareResult?.ok) {
                  try {
                    const congruentAlbaranSummary = buildCongruentAlbaranesSummary(compareResult);
                    const htmlCongruentSummary = toHtmlList(
                      congruentAlbaranSummary,
                      formatCongruentAlbaranLineHtml,
                      'No disponible'
                    );
                    const subjectOk = `${item.fileName || 'Factura'} Sin incongruencias en factura ${facturaRef}`;
                    await ipcRenderer.invoke('send-email', {
                      to: recipientEmail,
                      subject: subjectOk,
                      text: [
                        'VALIDACIÓN COMPLETADA: FACTURA CORRECTA',
                        '',
                        `Factura comparada: ${facturaRef}`,
                        `Nombre archivo factura: ${item.fileName || 'N/A'}`,
                        `Albaranes comparados: ${albaranesLabel}`,
                        '',
                        '=== ALBARANES CORRECTOS (número y nombre) ===',
                        'Albaranes correctos (número y nombre guardado):',
                        ...congruentAlbaranSummary,
                        '',
                        '=== RESUMEN DEL MODELO ===',
                        ...confidenceLines,
                        '',
                        '=== WARNINGS DE EXTRACCIÓN ===',
                        ...extractionWarningsLines,
                        'Se han comparado correctamente y todo bien.'
                      ].join('\n'),
                      html: `
                        <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
                          <h2 style="margin: 0 0 12px; color: #17693a;">✅ <strong>Factura validada correctamente</strong></h2>

                          <div style="background:#f6fbf8; border:1px solid #dcefe3; border-radius:8px; padding:12px; margin-bottom:12px;">
                            <p style="margin:0 0 6px;"><strong>Factura comparada:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
                            <p style="margin:0 0 6px;"><strong>Nombre archivo factura:</strong> <strong>${escapeHtml(item.fileName || 'N/A')}</strong></p>
                            <p style="margin:0;"><strong>Albaranes comparados:</strong> <strong>${escapeHtml(albaranesLabel)}</strong></p>
                          </div>

                          <h3 style="margin:14px 0 8px; font-size:15px;">✅ Albaranes correctos</h3>
                          <ul style="margin-top:0;">${htmlCongruentSummary}</ul>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">🔎 Resumen del modelo</h3>
                            <p style="margin:0;"><strong>Seguridad del modelo:</strong><br>${escapeHtml(confidenceLines.join(' | '))}</p>
                          </div>

                          <div style="margin: 14px 0;">
                            <h3 style="margin:0 0 8px; font-size:15px;">🧾 Warnings de extracción</h3>
                            <p style="margin:0;">${escapeHtml(extractionWarningsLines.join(' | '))}</p>
                          </div>

                          <p style="margin-top:12px;"><em>Se han comparado correctamente y todo bien.</em></p>
                        </div>
                      `
                    });
                    showStatus(`Email de validación enviado para ${item.fileName}`, 'success');

                    if (criticalAlert.lowConfidence) {
                      const facturaDriveLink = buildDriveFileLink(item.uploadedFileId);
                      const confidenceValue = criticalAlert.confidence;
                      const confidenceLabel = confidenceValue === null
                        ? 'No disponible'
                        : `${(Math.round(confidenceValue * 10000) / 100).toFixed(2)}%`;
                      await ipcRenderer.invoke('send-email', {
                        to: recipientEmail,
                        subject: `ERROR IMPORTANTE (${item.fileName || 'archivo'})`,
                        text: [
                          'Se ha detectado una confianza baja de IA y se requiere revisión humana.',
                          '',
                          '=== DATOS PRINCIPALES ===',
                          `Nombre archivo: ${item.fileName || 'N/A'}`,
                          `Número de factura: ${facturaRef}`,
                          'Albaranes fallados: N/A',
                          '',
                          '=== ALERTAS ===',
                          `Confianza IA: ${confidenceLabel}`,
                          '',
                          '=== ENLACES ===',
                          `Link de Drive (factura): ${facturaDriveLink || 'No disponible'}`,
                          '',
                          'Acción requerida: revisión humana.'
                        ].join('\n'),
                        html: `
                          <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
                            <h2 style="margin:0 0 12px; color:#8a1c1c;">🚨 <strong>ERROR IMPORTANTE</strong></h2>
                            <p>Se ha detectado <strong>baja confianza de IA</strong>. Este archivo requiere <strong>revisión humana</strong>.</p>

                            <div style="background:#fff6f6; border:1px solid #f0d7d7; border-radius:8px; padding:12px; margin:12px 0;">
                              <p style="margin:0 0 6px;"><strong>Nombre archivo:</strong> <strong>${escapeHtml(item.fileName || 'N/A')}</strong></p>
                              <p style="margin:0 0 6px;"><strong>Número de factura:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
                              <p style="margin:0;"><strong>Confianza IA:</strong> <strong>${escapeHtml(confidenceLabel)}</strong></p>
                            </div>

                            <h3 style="margin:14px 0 8px; font-size:15px;">🔗 Enlace</h3>
                            <p style="margin:0;"><strong>Factura:</strong> ${facturaDriveLink ? `<a href="${escapeHtml(facturaDriveLink)}">Abrir en Drive</a>` : 'No disponible'}</p>

                            <p style="margin-top:12px;"><em>Acción requerida: revisión humana.</em></p>
                          </div>
                        `
                      });
                    }
                  } catch (emailOkError) {
                    console.error('Error enviando email de validación:', emailOkError);
                    showStatus(`No se pudo enviar email de validación: ${emailOkError.message || emailOkError}`, 'error');
                    throw emailOkError;
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
                uiLog('error', 'uploadFilesToFolder:compare-error', {
                  fileName: item.fileName,
                  error: serializeUiError(compareError)
                });
                console.warn('Error comparando factura con albaranes:', compareError);
                throw compareError;
              }
            }

            if (docType !== 'factura') {
              updateQueueStep(item.queueId, 'Enviado');
            }
            const finalLabel = noComparadoFolder?.name
              ? `${parentFolderName}/No comparado`
              : targetLabel;
            showStatus(`¡${item.fileName} procesado y enviado a ${finalLabel}!`, 'success');
          } catch (error) {
            uiLog('error', 'uploadFilesToFolder:item-error', {
              fileName: item.fileName,
              error: serializeUiError(error)
            });
            markQueueError(item.queueId, error.message || 'Error desconocido');
            showStatus(`Error al procesar ${item.fileName}: ${error.message}`, 'error');
          }
        }
      }

      await loadFolderContents(noComparadoFolder?.id || target.id, true, noComparadoFolder?.name || target.name || 'No procesado');
    }
  } catch (error) {
    uiLog('error', 'uploadFilesToFolder:error', serializeUiError(error));
    showStatus('Error al subir archivo: ' + error.message, 'error');
  }
}

function queueUploadsAsWaiting(parentFolderName, filePaths = []) {
  const docType = (parentFolderName || '').toLowerCase().includes('factura') ? 'factura' : 'albaran';
  return filePaths.map((filePath) => {
    const fileName = pathBasename(filePath);
    const queueId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    initQueueItem(queueId, fileName, { docType });
    return { filePath, fileName, queueId };
  });
}

async function scheduleUploadFlow(parentFolderName, selectedFilePaths = null) {
  const filePaths = (Array.isArray(selectedFilePaths) && selectedFilePaths.length > 0)
    ? selectedFilePaths
    : await ipcRenderer.invoke('select-file');

  if (!filePaths || !filePaths.length) {
    return;
  }

  const queuedItems = queueUploadsAsWaiting(parentFolderName, filePaths);
  await enqueueUploadFlow(
    () => uploadFilesToFolder(parentFolderName, queuedItems),
    { label: parentFolderName }
  );
}

if (fileUpload) {
  fileUpload.addEventListener('click', async () => {
    await scheduleUploadFlow('Albaranes');
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
  uiLog('log', 'performSearch:start', { query: trimmed });
  if (!trimmed) {
    renderSearchResults([], '');
    return;
  }

  try {
    const response = await ipcRenderer.invoke('search-drive-files', trimmed);
    const items = Array.isArray(response?.files) ? response.files : [];
    uiLog('log', 'performSearch:ok', { query: trimmed, results: items.length });
    renderSearchResults(items, trimmed);
  } catch (error) {
    uiLog('error', 'performSearch:error', {
      query: trimmed,
      error: serializeUiError(error)
    });
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
  uiLog('log', 'loadFolderTree:start');
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
    uiLog('log', 'loadFolderTree:ok', {
      totalFolders: Object.keys(nodes).length,
      rootFolders: Object.keys(tree).length
    });
    return tree;
  } catch (err) {
    uiLog('error', 'loadFolderTree:error', serializeUiError(err));
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
  uiLog('log', 'loadFolderContents:start', {
    folderId,
    pushToBreadcrumb,
    folderName
  });
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
    uiLog('log', 'loadFolderContents:ok', {
      folderId: folderIdUsed,
      total: files.length,
      folders: folders.length,
      files: docs.length
    });

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
    uiLog('error', 'loadFolderContents:error', serializeUiError(err));
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
  uiLog('log', 'showUploadSection:start', { email: info?.email });
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
  uiLog('log', 'showUploadSection:done');
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
      openUploadDropModal('Albaranes');
      return;
    }
    if (action === 'upload-factura') {
      openUploadDropModal('Facturas');
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

function extractFilePathsFromDataTransfer(dataTransfer) {
  if (!dataTransfer || !dataTransfer.files) return [];
  return Array.from(dataTransfer.files)
    .map(file => file?.path)
    .filter(Boolean);
}

function bindDropHandlers(element, onDrop) {
  if (!element) return;
  const preventDefaults = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  element.addEventListener('dragenter', (event) => {
    preventDefaults(event);
    element.classList.add('drag-over');
  });

  element.addEventListener('dragover', (event) => {
    preventDefaults(event);
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    element.classList.add('drag-over');
  });

  element.addEventListener('dragleave', (event) => {
    preventDefaults(event);
    element.classList.remove('drag-over');
  });

  element.addEventListener('drop', async (event) => {
    preventDefaults(event);
    element.classList.remove('drag-over');

    const droppedFilePaths = extractFilePathsFromDataTransfer(event.dataTransfer);
    if (!droppedFilePaths.length) {
      showStatus('No se detectaron archivos válidos para subir.', 'error');
      return;
    }

    if (typeof onDrop === 'function') {
      await onDrop(droppedFilePaths);
    }
  });
}

function openUploadDropModal(parentFolderName) {
  if (!uploadDropModal || !uploadDropZone) {
    scheduleUploadFlow(parentFolderName);
    return;
  }

  currentUploadTargetFolder = parentFolderName;
  if (uploadDropTitle) {
    uploadDropTitle.textContent = `Subir ${parentFolderName === 'Facturas' ? 'Factura' : 'Albarán'}`;
  }
  uploadDropZone.classList.remove('drag-over');
  uploadDropModal.classList.add('active');
}

function closeUploadDropModal() {
  if (!uploadDropModal) return;
  uploadDropModal.classList.remove('active');
  currentUploadTargetFolder = null;
}

if (uploadDropClose) {
  uploadDropClose.addEventListener('click', closeUploadDropModal);
}

if (uploadDropModal) {
  uploadDropModal.addEventListener('click', (event) => {
    if (event.target === uploadDropModal) {
      closeUploadDropModal();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && uploadDropModal?.classList.contains('active')) {
    closeUploadDropModal();
  }
});

if (uploadDropZone) {
  uploadDropZone.addEventListener('click', async () => {
    const target = currentUploadTargetFolder;
    if (!target) return;
    closeUploadDropModal();
    await scheduleUploadFlow(target);
  });

  bindDropHandlers(uploadDropZone, async (droppedFilePaths) => {
    const target = currentUploadTargetFolder;
    if (!target) return;
    closeUploadDropModal();
    await scheduleUploadFlow(target, droppedFilePaths);
  });
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
  uiLog('log', 'logout button:click');
  if (confirm('¿Estás seguro de que quieres cerrar sesión?')) {
    uiLog('log', 'logout confirmed');
    await ipcRenderer.invoke('logout');
  }
});
// (showUploadSection está implementada arriba con navegación mejorada)


function showStatus(message, type) {
  uiLog(type === 'error' ? 'error' : 'log', 'showStatus', { message, type });
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
  uiLog('log', 'event:startup-status', { message });
  startupStatusEl.textContent = message;
  // Mantener el indicador pequeño dentro de la UI durante el escaneo
  toggleStartupOverlay(false);
});

ipcRenderer.on('queue-event', (event, payload) => {
  if (!payload || !payload.id) return;
  uiLog('log', 'event:queue-event', {
    id: payload.id,
    type: payload.type,
    step: payload.step,
    fileName: payload.fileName,
    message: payload.message
  });

  if (payload.type === 'init') {
    initQueueItem(payload.id, payload.fileName || 'Archivo', {
      source: payload.source,
      docType: payload.docType,
      steps: payload.steps
    });
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

function initQueueItem(id, fileName, options = {}) {
  const steps = resolveQueueSteps(options);
  uploadQueue.set(id, { fileName, status: 'Esperando', error: null, steps });
  renderQueue();
}

function updateQueueStep(id, step) {
  const item = uploadQueue.get(id);
  if (!item) return;
  if (item.status === 'Cancelado') return;
  const rawStep = String(step || '').trim().toLowerCase();
  let normalizedStep = step;

  if (['pendiente', 'esperando', 'en cola', 'cola', 'queued', 'queue'].includes(rawStep)) {
    normalizedStep = 'Esperando';
  } else if (rawStep === 'comparado') {
    normalizedStep = 'Comparado';
  } else if (rawStep === 'email') {
    normalizedStep = 'Email';
  }

  item.status = normalizedStep;
  item.error = null;
  uploadQueue.set(id, item);
  renderQueue();
}

function markQueueCancelled(id, message = 'Cancelado por el usuario') {
  const item = uploadQueue.get(id);
  if (!item) return;
  item.status = 'Cancelado';
  item.error = message;
  uploadQueue.set(id, item);
  canceledQueueIds.add(id);
  renderQueue();
}

function requestCancelQueueItem(id) {
  const item = uploadQueue.get(id);
  if (!item) return;

  if (item.status === 'Error' || item.status === 'Cancelado' || item.status === 'Enviado' || item.status === 'Movido' || item.status === 'Email') {
    return;
  }

  const confirmed = confirm(`¿Seguro que quieres cancelar ${item.fileName}?`);
  if (!confirmed) return;

  markQueueCancelled(id);
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
    const steps = Array.isArray(item.steps) && item.steps.length > 0
      ? item.steps
      : DEFAULT_QUEUE_STEPS;
    const currentIndex = steps.indexOf(item.status);

    const wrapper = document.createElement('div');
    wrapper.className = 'queue-item';

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.alignItems = 'center';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.gap = '8px';

    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = item.fileName;

    const statusRow = document.createElement('div');
    statusRow.className = 'status-row';

    steps.forEach(step => {
      const stepEl = document.createElement('div');
      stepEl.className = 'queue-step';
      stepEl.textContent = step;

      if (item.status === 'Error') {
        stepEl.classList.add('error');
      } else if (item.status === 'Cancelado') {
        stepEl.classList.add('error');
      } else if (item.status === step) {
        stepEl.classList.add('active');
      } else if (currentIndex >= 0 && steps.indexOf(step) < currentIndex) {
        stepEl.classList.add('done');
      }

      statusRow.appendChild(stepEl);
    });

    if (item.error) {
      const errorText = document.createElement('div');
      errorText.style.color = item.status === 'Cancelado' ? '#856404' : '#721c24';
      errorText.style.fontSize = '12px';
      errorText.textContent = `Error: ${item.error}`;
      wrapper.appendChild(errorText);
    }

    const canCancel = !['Error', 'Cancelado', 'Enviado', 'Movido', 'Email'].includes(item.status);
    if (canCancel) {
      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.justifyContent = 'flex-end';
      controls.style.alignItems = 'center';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.title = `Cancelar ${item.fileName}`;
      cancelBtn.setAttribute('aria-label', `Cancelar ${item.fileName}`);
      cancelBtn.textContent = '✕';
      cancelBtn.style.width = '28px';
      cancelBtn.style.height = '28px';
      cancelBtn.style.minWidth = '28px';
      cancelBtn.style.borderRadius = '50%';
      cancelBtn.style.border = '2px solid #dc3545';
      cancelBtn.style.background = '#dc3545';
      cancelBtn.style.color = '#fff';
      cancelBtn.style.cursor = 'pointer';
      cancelBtn.style.fontSize = '15px';
      cancelBtn.style.fontWeight = '700';
      cancelBtn.style.lineHeight = '1';
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.style.alignItems = 'center';
      cancelBtn.style.justifyContent = 'center';
      cancelBtn.style.padding = '0';
      cancelBtn.addEventListener('click', () => requestCancelQueueItem(id));
      cancelBtn.addEventListener('mouseenter', () => {
        cancelBtn.style.background = '#bb2d3b';
        cancelBtn.style.borderColor = '#bb2d3b';
      });
      cancelBtn.addEventListener('mouseleave', () => {
        cancelBtn.style.background = '#dc3545';
        cancelBtn.style.borderColor = '#dc3545';
      });

      controls.appendChild(cancelBtn);
      headerRow.appendChild(controls);
    }

    headerRow.prepend(name);
    wrapper.appendChild(headerRow);
    wrapper.appendChild(statusRow);

    queueList.appendChild(wrapper);
  });
}