const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const Store = require('electron-store');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { spawn } = require('child_process');

const WATCH_SUBFOLDERS = ['Albaranes', 'Facturas'];
const WATCHED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.txt'];
const BILLING_EMAIL_ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];
const BILLING_POLL_INTERVAL_MS = 30000;
const BILLING_PROCESS_DELAY_MS = 3000;
const REPORTS_FOLDER_NAME = 'Informes - No tocar';
const REPORTS_SUBFOLDERS = {
  Albaranes: 'Albaranes-Informes',
  Facturas: 'Facturas-Informes'
};
const LAST_EMAIL_FILE_NAME = 'Ult_email.txt';

function readBooleanEnv(name) {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

const useRefreshTokensFromEnv = readBooleanEnv('ENABLE_REFRESH_TOKENS');
const USE_REFRESH_TOKENS = useRefreshTokensFromEnv !== null
  ? useRefreshTokensFromEnv
  : (process.env.NODE_ENV === 'production' || app.isPackaged);
const RESET_SESSION_ON_START = readBooleanEnv('RESET_SESSION_ON_START') === true;

// Configurar logging para actualizaciones
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true;

// URL del backend: usa BACKEND_URL si se define; si no, mantiene producción por defecto.
const DEFAULT_BACKEND_URL = 'https://backend-factura-albaran.onrender.com';
const BACKEND_URL = process.env.BACKEND_URL || DEFAULT_BACKEND_URL;
const DEFAULT_TIMEOUT_MS = 20000;
const DRIVE_UPLOAD_TIMEOUT_MS = Number(process.env.DRIVE_UPLOAD_TIMEOUT_MS || 180000);
const DRIVE_UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.DRIVE_UPLOAD_CONCURRENCY || 3) || 3);
const OCR_RETRY_ATTEMPTS = 2;
const OCR_RETRY_DELAY_MS = 2000;
const DEFAULT_RETRY_BASE_DELAY_MS = 800;
const DEFAULT_RETRY_MAX_DELAY_MS = 15000;

// Polling de jobs asíncronos
const JOB_POLL_INTERVAL_MS = 2000;   // cada 2 s
const JOB_POLL_MAX_ATTEMPTS = 150;   // máx ~5 minutos

const ANALYZE_ENDPOINTS = {
  albaran: '/analyze/document/albaran/file',
  factura: '/analyze/document/factura/file'
};

const LEGACY_ANALYZE_TEXT_ENDPOINTS = {
  albaran: '/analyze/document/albaran',
  factura: '/analyze/document/factura'
};

const MAIN_LOG_PREFIX = '[Frontend-Main]';

function serializeError(error) {
  if (!error) return null;
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    code: error.code,
    status: error?.response?.status,
    data: error?.response?.data
  };
}

function summarizeArgs(args = []) {
  return (Array.isArray(args) ? args : []).map((value) => {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}...` : value;
    if (typeof value === 'object') {
      return {
        type: 'object',
        keys: Object.keys(value).slice(0, 10)
      };
    }
    return value;
  });
}

function mainLog(level = 'info', message = '', data = undefined) {
  const normalizedLevel = String(level || '').toLowerCase();
  if (normalizedLevel !== 'error') {
    return;
  }

  const method = 'error';
  const timestamp = new Date().toISOString();
  const text = `${MAIN_LOG_PREFIX} ${timestamp} ${message}`;

  if (data === undefined) {
    log[method](text);
    return;
  }

  log[method](text, data);
}

const originalIpcMainHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  mainLog('info', 'IPC handler:registered', { channel });

  return originalIpcMainHandle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    mainLog('info', 'IPC call:start', {
      channel,
      args: summarizeArgs(args)
    });

    try {
      const result = await listener(event, ...args);
      mainLog('info', 'IPC call:ok', {
        channel,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      mainLog('error', 'IPC call:error', {
        channel,
        durationMs: Date.now() - startedAt,
        error: serializeError(error)
      });
      throw error;
    }
  });
};

axios.interceptors.request.use(
  (config) => {
    const method = (config.method || 'get').toUpperCase();
    // mainLog('info', 'HTTP request:start', {
    //   method,
    //   url: config.url,
    //   timeout: config.timeout,
    //   hasData: Boolean(config.data)
    // });
    config.metadata = { startedAt: Date.now() };
    return config;
  },
  (error) => {
    mainLog('error', 'HTTP request:interceptor-error', serializeError(error));
    return Promise.reject(error);
  }
);

axios.interceptors.response.use(
  (response) => {
    const startedAt = response?.config?.metadata?.startedAt || Date.now();
    const durationMs = Date.now() - startedAt;
    mainLog('info', 'HTTP request:ok', {
      method: (response?.config?.method || 'get').toUpperCase(),
      url: response?.config?.url,
      status: response?.status,
      durationMs
    });
    return response;
  },
  (error) => {
    const startedAt = error?.config?.metadata?.startedAt || Date.now();
    const durationMs = Date.now() - startedAt;
    mainLog('error', 'HTTP request:error', {
      method: (error?.config?.method || 'get').toUpperCase(),
      url: error?.config?.url,
      durationMs,
      error: serializeError(error)
    });
    return Promise.reject(error);
  }
);

process.on('uncaughtException', (error) => {
  mainLog('error', 'uncaughtException', serializeError(error));
});

process.on('unhandledRejection', (reason) => {
  mainLog('error', 'unhandledRejection', {
    reason: serializeError(reason) || reason
  });
});

function normalizeDocumentType(value) {
  const normalized = (value || '').toString().toLowerCase();
  if (normalized.includes('factura')) return 'factura';
  return 'albaran';
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

function normalizeArticleName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAlbaranNumberForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function buildAlbaranFileBaseCandidates(albaranNum) {
  const raw = String(albaranNum || '').trim();
  if (!raw) return [];

  const candidates = [
    raw,
    sanitizeFileName(raw),
    raw.replace(/[\\/]+/g, '_'),
    raw.replace(/[\\/]+/g, '-'),
    raw.replace(/[\\/\s]+/g, '_'),
    raw.replace(/[\\/\s]+/g, '')
  ];

  return [...new Set(candidates.map(item => String(item || '').trim()).filter(Boolean))];
}

function stripAlbTxtSuffix(fileName = '') {
  return String(fileName || '').replace(/alb\.txt$/i, '').trim();
}

function resolveAlbaranTxtFile(albaranNum, files = []) {
  const candidates = buildAlbaranFileBaseCandidates(albaranNum);
  const normalizedCandidates = new Set(candidates.map(normalizeAlbaranNumberForMatch).filter(Boolean));

  const txtFiles = (Array.isArray(files) ? files : [])
    .filter(file => /alb\.txt$/i.test(file?.name || ''))
    .filter(file => !/^total/i.test(String(file?.name || '').trim()));

  for (const file of txtFiles) {
    const base = stripAlbTxtSuffix(file.name || '');
    const normalizedBase = normalizeAlbaranNumberForMatch(base);
    if (normalizedBase && normalizedCandidates.has(normalizedBase)) {
      return file;
    }
  }

  return null;
}

function resolveTotalAlbaranTxtFile(albaranNum, files = []) {
  const candidates = buildAlbaranFileBaseCandidates(albaranNum);
  const normalizedCandidates = new Set(candidates.map(normalizeAlbaranNumberForMatch).filter(Boolean));

  const totalFiles = (Array.isArray(files) ? files : [])
    .filter(file => /^total/i.test(String(file?.name || '').trim()))
    .filter(file => /alb\.txt$/i.test(file?.name || ''));

  for (const file of totalFiles) {
    const name = String(file?.name || '').trim();
    const withoutPrefix = name.replace(/^total/i, '');
    const base = stripAlbTxtSuffix(withoutPrefix);
    const normalizedBase = normalizeAlbaranNumberForMatch(base);
    if (normalizedBase && normalizedCandidates.has(normalizedBase)) {
      return file;
    }
  }

  return null;
}

function parseJsonLines(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
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

function parseFacturaAnalysis(analysisText) {
  const sections = extractAnalysisSections(analysisText);
  if (!sections || !sections.isFactura) return null;

  const articulos = parseJsonLines(sections.articulosRaw);
  const resumenLine = sections.resumenRaw.split(/\r?\n/).find(line => line.trim());
  let resumenObj = null;
  if (resumenLine) {
    try {
      resumenObj = JSON.parse(resumenLine);
    } catch (e) {
      resumenObj = null;
    }
  }

  let albaranNumbers = Array.isArray(resumenObj?.num_albaran) ? resumenObj.num_albaran : [];
  if (!albaranNumbers.length) {
    albaranNumbers = [...new Set(articulos.map(item => item.num_albaran).filter(Boolean))];
  }

  return {
    articulos,
    resumen: resumenObj,
    albaranNumbers
  };
}

function getFacturaReferenceForEmail(analysisText, fallback = 'XX') {
  const parsed = parseFacturaAnalysis(analysisText);
  const facturaNum = parsed?.resumen?.num_factura;
  if (facturaNum && facturaNum !== 'NaN') {
    return sanitizeFileName(facturaNum);
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
  const parsed = parseFacturaAnalysis(analysisText);
  const confidencePercent = normalizeConfidenceToPercent(parsed?.resumen?.confidence);

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
  const parsed = parseFacturaAnalysis(analysisText);
  const value = Number(parsed?.resumen?.confidence);
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
    const headerMatch = line.match(/^Albar[aá]n\s+(.+?):$/i);
    if (headerMatch) {
      currentAlbaran = String(headerMatch[1] || '').trim() || null;
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
  let currentIsSevere = false;

  for (const rawLine of sourceIssues) {
    const line = String(rawLine || '').trim();
    const headerMatch = line.match(/^Albar[aá]n\s+(.+?):$/i);

    if (headerMatch) {
      const currentAlbaran = String(headerMatch[1] || '').trim();
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
    lowConfidence,
    confidence,
    severeAlbaranes,
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

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCongruentAlbaranesSummary(compareResult = {}) {
  const docs = Array.isArray(compareResult?.congruentAlbaranDocs)
    ? compareResult.congruentAlbaranDocs
    : [];

  if (docs.length) {
    return docs.map((doc) => {
      const num = doc?.albaranNum || 'N/A';
      const fileName = doc?.fileName || 'Nombre no disponible';
      const totalDetectedLabel = formatAmountEuro(doc?.totalDetected);
      return `- Albarán ${num}: ${fileName} (total detectado: ${totalDetectedLabel})`;
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

  return congruentNums.map((num) => `- Albarán ${num}: nombre no disponible (total detectado: No disponible)`);
}

function buildIncongruentAlbaranesLinks(compareResult = {}) {
  const docs = Array.isArray(compareResult?.incongruentAlbaranDocs)
    ? compareResult.incongruentAlbaranDocs
    : [];
  if (docs.length) {
    return docs.map((doc) => {
      const num = doc?.albaranNum || 'N/A';
      const fileName = doc?.fileName || 'Nombre no disponible';
      const totalDetectedLabel = formatAmountEuro(doc?.totalDetected);
      const url = doc?.url || buildDriveFileLink(doc?.fileId) || 'No disponible';
      return `- Albarán ${num} (${fileName}, total detectado: ${totalDetectedLabel}): ${url}`;
    });
  }

  const nums = Array.isArray(compareResult?.incongruentAlbaranes)
    ? compareResult.incongruentAlbaranes
    : [];
  if (!nums.length) {
    return ['- No disponible'];
  }

  return nums.map((num) => `- Albarán ${num} (nombre no disponible, total detectado: No disponible): link no disponible`);
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

function buildComparisonEmailPayload({
  compareResult = {},
  fileName = 'Factura',
  facturaRef = 'XX',
  albaranesLabel = 'N/A',
  facturaTotalLabel = 'No disponible',
  albaranesTotalLabel = 'No disponible',
  facturaDriveLink = null
} = {}) {
  const incongruentAlbaranLinks = buildIncongruentAlbaranesLinks(compareResult);
  const congruentAlbaranSummary = buildCongruentAlbaranesSummary(compareResult);
  const compareMessage = addEuroSymbolToAmounts(compareResult.message || 'Se encontraron incongruencias.');

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

  if (!compareResult?.ok) {
    return {
      subject: `⚠️ ${fileName || 'Factura'} Incongruencias encontradas en factura ${facturaRef}`,
      text: [
        'ALERTA DE COMPARACIÓN: FACTURA CON INCONGRUENCIAS',
        '',
        `Factura comparada: ${facturaRef}`,
        `Nombre archivo factura: ${fileName || 'N/A'}`,
        `Albaranes comparados: ${albaranesLabel}`,
        `Total factura: ${facturaTotalLabel}`,
        `Total albaranes: ${albaranesTotalLabel}`,
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
        compareMessage,
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
          <h2 style="margin: 0 0 12px; color: #8a1c1c;">⚠️ <strong>Incongruencias encontradas</strong></h2>

          <div style="background:#f8f9fb; border:1px solid #e6e9ef; border-radius:8px; padding:12px; margin-bottom:12px;">
            <p style="margin:0 0 6px;"><strong>Factura comparada:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
            <p style="margin:0 0 6px;"><strong>Nombre archivo factura:</strong> <strong>${escapeHtml(fileName || 'N/A')}</strong></p>
            <p style="margin:0 0 6px;"><strong>Albaranes comparados:</strong> <strong>${escapeHtml(albaranesLabel)}</strong></p>
            <p style="margin:0 0 6px;"><strong>Total factura:</strong> <strong>${escapeHtml(facturaTotalLabel)}</strong></p>
            <p style="margin:0;"><strong>Total albaranes:</strong> <strong>${escapeHtml(albaranesTotalLabel)}</strong></p>
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
            <p style="margin:0;">${escapeHtml(compareMessage)}</p>
          </div>
        </div>
      `
    };
  }

  return {
    subject: `✅ ${fileName || 'Factura'} Sin incongruencias en factura ${facturaRef}`,
    text: [
      'VALIDACIÓN COMPLETADA: FACTURA CORRECTA',
      '',
      `Factura comparada: ${facturaRef}`,
      `Nombre archivo factura: ${fileName || 'N/A'}`,
      `Albaranes comparados: ${albaranesLabel}`,
      `Total factura: ${facturaTotalLabel}`,
      `Total albaranes: ${albaranesTotalLabel}`,
      '',
      '=== ALBARANES CORRECTOS (número y nombre) ===',
      'Albaranes correctos (número y nombre guardado):',
      ...congruentAlbaranSummary,
      'Se han comparado correctamente y todo bien.'
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #222; line-height: 1.5; max-width: 760px;">
        <h2 style="margin: 0 0 12px; color: #17693a;">✅ <strong>Factura validada correctamente</strong></h2>

        <div style="background:#f6fbf8; border:1px solid #dcefe3; border-radius:8px; padding:12px; margin-bottom:12px;">
          <p style="margin:0 0 6px;"><strong>Factura comparada:</strong> <strong>${escapeHtml(facturaRef)}</strong></p>
          <p style="margin:0 0 6px;"><strong>Nombre archivo factura:</strong> <strong>${escapeHtml(fileName || 'N/A')}</strong></p>
          <p style="margin:0 0 6px;"><strong>Albaranes comparados:</strong> <strong>${escapeHtml(albaranesLabel)}</strong></p>
          <p style="margin:0 0 6px;"><strong>Total factura:</strong> <strong>${escapeHtml(facturaTotalLabel)}</strong></p>
          <p style="margin:0;"><strong>Total albaranes:</strong> <strong>${escapeHtml(albaranesTotalLabel)}</strong></p>
        </div>

        <h3 style="margin:14px 0 8px; font-size:15px;">✅ Albaranes correctos</h3>
        <ul style="margin-top:0;">${htmlCongruentSummary}</ul>

        <p style="margin-top:12px;"><em>Se han comparado correctamente y todo bien.</em></p>
      </div>
    `
  };
}

function aggregateArticles(lines, mode = 'factura') {
  const map = new Map();
  lines.forEach(item => {
    const key = normalizeArticleName(item.articulo);
    if (!key) return;
    const quantity = Number(
      mode === 'factura'
        ? (item.kg ?? item.unidades ?? item.bulto ?? 0)
        : (item.kg ?? item.bulto ?? 0)
    );
    const importe = Number(item.importe ?? 0);
    const current = map.get(key) || { quantity: 0, importe: 0 };
    current.quantity += Number.isFinite(quantity) ? quantity : 0;
    current.importe += Number.isFinite(importe) ? importe : 0;
    map.set(key, current);
  });
  return map;
}

function numbersClose(a, b, tolerance) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

function parseComparableNumber(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();
  if (!text || text.toLowerCase() === 'nan') return null;

  // quitar espacios y €
  text = text.replace(/[€\s]/g, '');

  const hasComma = text.includes(',');
  const hasDot = text.includes('.');

  if (hasComma && hasDot) {
    // Caso: 1.234,56 (ES)
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      // Caso: 1,234.56 (EN)
      text = text.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Caso: 225,58
    text = text.replace(',', '.');
  }
  // Caso: 225.58 → se deja igual

  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function amountToCents(value) {
  const numeric = parseComparableNumber(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function formatAmountEuro(value) {
  if (value === null || value === undefined || value === '') return 'No disponible';
  const numeric = typeof value === 'number' ? value : parseComparableNumber(value);
  if (!Number.isFinite(numeric)) {
    const raw = String(value || '').trim();
    if (!raw) return 'No disponible';
    return raw.includes('€') ? raw : `${raw}€`;
  }
  return `${numeric.toFixed(2)}€`;
}

function extractTotalDetectedFromTotalTxtText(totalText = '') {
  const text = String(totalText || '').trim();
  if (!text) return null;

  // 1) Intentar JSON directo (objeto completo)
  try {
    const parsed = JSON.parse(text);
    const direct = parseComparableNumber(parsed?.total);
    if (direct !== null) return direct;
  } catch (e) {
    // continuar con otras estrategias
  }

  // 2) Intentar primera línea JSON válida
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (firstLine) {
    try {
      const parsedLine = JSON.parse(firstLine);
      const lineTotal = parseComparableNumber(parsedLine?.total);
      if (lineTotal !== null) return lineTotal;
    } catch (e) {
      // continuar con regex
    }
  }

  // 3) Fallback robusto: buscar patrón textual total: <valor>
  const match = text.match(/"?total"?\s*[:=]\s*"?([-+]?\d[\d.,\s€]*)"?/i);
  if (match && match[1]) {
    return parseComparableNumber(match[1]);
  }

  return null;
}

function addEuroSymbolToAmounts(text = '') {
  const input = String(text || '');
  return input
    .replace(/(factura=)([-+]?\d*\.?\d+)(?!€)/gi, '$1$2€')
    .replace(/(albar[aá]n=)([-+]?\d*\.?\d+)(?!€)/gi, '$1$2€')
    .replace(/(suma_albaranes=)([-+]?\d*\.?\d+)(?!€)/gi, '$1$2€');
}

function compareArticleMaps(facturaMap, albaranMap) {
  const issues = [];
  const qtyTolerance = 0.01;
  const importeTolerance = 0.5;

  facturaMap.forEach((fact, key) => {
    const alb = albaranMap.get(key);
    if (!alb) {
      issues.push(`Artículo en factura no encontrado en albarán: ${key}`);
      return;
    }
    if (!numbersClose(fact.quantity, alb.quantity, qtyTolerance)) {
      issues.push(`Cantidad distinta para ${key}: factura=${fact.quantity}, albarán=${alb.quantity}`);
    }
    if (!numbersClose(fact.importe, alb.importe, importeTolerance)) {
      issues.push(`Importe distinto para ${key}: factura=${fact.importe}, albarán=${alb.importe}`);
    }
  });

  albaranMap.forEach((alb, key) => {
    if (!facturaMap.has(key)) {
      issues.push(`Artículo en albarán no encontrado en factura: ${key}`);
    }
  });

  return issues;
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

  // SOLICITUD CLIENTE: NO crear TXT no-total (artículos por línea).
  // Se mantiene el bloque antiguo comentado para histórico.
  // if (enrichedArticulos) {
  //   files.push({
  //     name: `${safeNum}${suffix}.txt`,
  //     content: enrichedArticulos
  //   });
  // }

  if (enrichedResumen) {
    files.push({
      name: `Total${safeNum}${suffix}.txt`,
      content: enrichedResumen
    });
  }

  return { files, isFactura };
}

function getAnalyzeEndpoint(docType) {
  const key = normalizeDocumentType(docType);
  const endpoint = ANALYZE_ENDPOINTS[key] || ANALYZE_ENDPOINTS.albaran;
  return `${BACKEND_URL}${endpoint}`;
}

function getLegacyAnalyzeTextEndpoint(docType) {
  const key = normalizeDocumentType(docType);
  const endpoint = LEGACY_ANALYZE_TEXT_ENDPOINTS[key] || LEGACY_ANALYZE_TEXT_ENDPOINTS.albaran;
  return `${BACKEND_URL}${endpoint}`;
}

async function analyzeFileWithBackendIA(filePath, mimeType = '', originalName = '', docType = 'albaran', postProcess = null) {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para analizar documento');
  }

  mainLog('info', 'analyzeFileWithBackendIA:start', {
    filePath,
    mimeType,
    originalName,
    docType
  });

  // 1) Flujo principal: enviar el ARCHIVO real al backend para que lo procese con OpenAI.
  try {
    const formData = new FormData();
    formData.append('sessionId', sessionId);
    const pipeline = postProcess && typeof postProcess === 'object' ? postProcess : null;
    if (pipeline?.txtFolderId) {
      formData.append('postProcessTxtFolderId', String(pipeline.txtFolderId));
    }
    if (pipeline?.sourceDriveFileId) {
      formData.append('postProcessSourceDriveFileId', String(pipeline.sourceDriveFileId));
    }
    if (pipeline?.sourceDriveFromFolderId) {
      formData.append('postProcessSourceDriveFromFolderId', String(pipeline.sourceDriveFromFolderId));
    }
    if (pipeline?.sourceDriveToFolderId) {
      formData.append('postProcessSourceDriveToFolderId', String(pipeline.sourceDriveToFolderId));
    }
    if (pipeline?.sourceFileName) {
      formData.append('postProcessSourceFileName', String(pipeline.sourceFileName));
    }
    formData.append('file', fs.createReadStream(filePath), {
      filename: originalName || path.basename(filePath),
      contentType: mimeType || undefined
    });

    const fileEndpoint = getAnalyzeEndpoint(docType);
    const directResponse = await postWithRetry(fileEndpoint, formData, {
      timeout: 30000, // Timeout corto: solo espera el job_id, no el procesamiento completo
      retries: 1,
      axiosOptions: {
        headers: {
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    });

    // Flujo asíncrono (nuevo): el backend devuelve { job_id } inmediatamente
    if (directResponse?.data?.job_id) {
      mainLog('info', 'analyzeFileWithBackendIA:job-submitted', {
        endpoint: fileEndpoint,
        jobId: directResponse.data.job_id
      });
      const jobResult = await pollJobResult(directResponse.data.job_id);
      mainLog('info', 'analyzeFileWithBackendIA:job-done', {
        jobId: directResponse.data.job_id,
        hasAnalysis: Boolean(jobResult?.analysis)
      });
      return jobResult;
    }

    // Flujo síncrono (legado): el backend devuelve { success, analysis } directamente
    mainLog('info', 'analyzeFileWithBackendIA:file-endpoint-ok', {
      endpoint: fileEndpoint,
      hasAnalysis: Boolean(directResponse?.data?.analysis)
    });

    return directResponse.data;
  } catch (error) {
    mainLog('warn', 'analyzeFileWithBackendIA:file-endpoint-error', {
      docType,
      error: serializeError(error)
    });
    // SOLICITUD CLIENTE: no permitir fallback OCR. Solo pipeline IA.
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAuthStoreKeys(purpose = 'primary') {
  if (purpose === 'billing') {
    return {
      sessionIdKey: 'billingSessionId',
      refreshTokenKey: 'billingRefreshToken'
    };
  }

  return {
    sessionIdKey: 'sessionId',
    refreshTokenKey: 'refreshToken'
  };
}

function getStoredAuth(purpose = 'primary') {
  const keys = getAuthStoreKeys(purpose);
  return {
    sessionId: store.get(keys.sessionIdKey) || null,
    refreshToken: store.get(keys.refreshTokenKey) || null
  };
}

function setStoredAuth({ sessionId, refreshToken } = {}, purpose = 'primary') {
  const keys = getAuthStoreKeys(purpose);

  if (sessionId === null) {
    store.delete(keys.sessionIdKey);
  } else if (sessionId !== undefined) {
    store.set(keys.sessionIdKey, sessionId);
  }

  if (refreshToken === null) {
    store.delete(keys.refreshTokenKey);
  } else if (refreshToken !== undefined) {
    store.set(keys.refreshTokenKey, refreshToken);
  }

  log.info('[AuthStore] setStoredAuth', {
    purpose,
    hasSessionId: Boolean(store.get(keys.sessionIdKey)),
    hasRefreshToken: Boolean(store.get(keys.refreshTokenKey))
  });
}

async function refreshSessionTokens(purpose = 'primary') {
  const { sessionId, refreshToken } = getStoredAuth(purpose);
  if (!sessionId) {
    return null;
  }

  log.info('[AuthStore] refreshSessionTokens:request', {
    purpose,
    hasSessionId: Boolean(sessionId),
    hasRefreshToken: Boolean(refreshToken)
  });

  const response = await axios.post(`${BACKEND_URL}/auth/verify`, {
    sessionId,
    refreshToken: refreshToken || null
  }, {
    timeout: DEFAULT_TIMEOUT_MS
  });

  const nextSessionId = response?.data?.sessionId;
  const nextRefreshToken = response?.data?.refreshToken;
  if (nextSessionId || nextRefreshToken) {
    setStoredAuth({
      sessionId: nextSessionId,
      refreshToken: nextRefreshToken
    }, purpose);

    log.info('[AuthStore] refreshSessionTokens:response', {
      purpose,
      hasNextSessionId: Boolean(nextSessionId),
      hasNextRefreshToken: Boolean(nextRefreshToken)
    });
  }

  return response?.data || null;
}

function isRetryableError(error) {
  const code = error?.code || '';
  const status = error?.response?.status;
  const responseData = error?.response?.data;
  const responseText = typeof responseData === 'string'
    ? responseData
    : JSON.stringify(responseData || {});
  const isRateLimit403 = status === 403 && /rate.?limit|quota|userRateLimitExceeded|rateLimitExceeded/i.test(responseText);

  return (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    status === 408 ||
    status === 429 ||
    isRateLimit403 ||
    (status && status >= 500)
  );
}

async function postWithRetry(url, data, options = {}) {
  const retries = options.retries ?? 3;
  const delayMs = options.delayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? 2;
  const jitter = options.jitter ?? true;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const axiosOptions = options.axiosOptions || {};

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      mainLog('info', 'postWithRetry:attempt', {
        url,
        attempt: attempt + 1,
        totalAttempts: retries + 1,
        timeout
      });
      return await axios.post(url, data, { timeout, ...axiosOptions });
    } catch (error) {
      const status = Number(error?.response?.status || 0);
      const allowAuthRefresh = options.allowAuthRefresh !== false;
      const isAuthEndpoint = /\/auth\/(verify|logout)\b/.test(String(url || ''));
      const refreshedKey = '__authRefreshTried';

      if (
        status === 401
        && allowAuthRefresh
        && !isAuthEndpoint
        && !options[refreshedKey]
      ) {
        try {
          await refreshSessionTokens('primary');
          options[refreshedKey] = true;
          continue;
        } catch (refreshError) {
          mainLog('warn', 'postWithRetry:auth-refresh-failed', {
            url,
            error: serializeError(refreshError)
          });
        }
      }

      if (attempt >= retries || !isRetryableError(error)) {
        mainLog('error', 'postWithRetry:final-error', {
          url,
          attempt: attempt + 1,
          error: serializeError(error)
        });
        throw error;
      }

      const expDelay = Math.min(delayMs * Math.pow(backoffFactor, attempt), maxDelayMs);
      const finalDelay = jitter
        ? Math.floor(expDelay * (0.75 + Math.random() * 0.5))
        : expDelay;
      mainLog('warn', 'postWithRetry:retrying', {
        url,
        nextAttempt: attempt + 2,
        delayMs: finalDelay,
        error: serializeError(error)
      });
      await sleep(finalDelay);
    }
  }
}

/**
 * Hace polling a GET /job/:id hasta que el job tenga status 'done' o 'error'.
 * Retorna el result del job si se completa con éxito, lanza error si falla o hay timeout.
 */
async function pollJobResult(jobId, options = {}) {
  const intervalMs = options.intervalMs || JOB_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts || JOB_POLL_MAX_ATTEMPTS;

  mainLog('info', 'pollJobResult:start', { jobId, intervalMs, maxAttempts });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(intervalMs);

    try {
      const response = await axios.get(`${BACKEND_URL}/job/${jobId}`, {
        timeout: DEFAULT_TIMEOUT_MS
      });

      const job = response.data;

      if (job.status === 'done') {
        mainLog('info', 'pollJobResult:done', { jobId, attempt });
        return job.result;
      }

      if (job.status === 'error') {
        mainLog('error', 'pollJobResult:job-error', { jobId, error: job.error });
        throw new Error(job.error || `El job ${jobId} terminó con error`);
      }

      // status === 'pending' | 'processing' → seguir esperando
      mainLog('info', 'pollJobResult:waiting', { jobId, status: job.status, attempt });
    } catch (error) {
      // Si el error es del propio job (lo lanzamos arriba), propagar
      if (error.message && !error.response) {
        // Error de red transitorio — reintentar
        mainLog('warn', 'pollJobResult:network-error', {
          jobId,
          attempt,
          message: error.message
        });
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Timeout esperando resultado del job ${jobId} (${maxAttempts * intervalMs / 1000}s)`);
}

async function moveDriveFileWithBackoff(fileId, addParents = [], removeParents = []) {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para mover archivo');
  }
  if (!fileId) {
    throw new Error('fileId requerido para mover archivo');
  }

  const addList = Array.isArray(addParents) ? addParents.filter(Boolean) : (addParents ? [addParents] : []);
  const removeList = Array.isArray(removeParents) ? removeParents.filter(Boolean) : (removeParents ? [removeParents] : []);

  const response = await postWithRetry(`${BACKEND_URL}/drive/move`, {
    sessionId,
    fileId,
    addParents: addList,
    removeParents: removeList
  }, {
    retries: 5,
    delayMs: 700,
    maxDelayMs: 10000,
    backoffFactor: 2,
    jitter: true,
    timeout: 60000
  });

  mainLog('info', 'moveDriveFileWithBackoff:ok', {
    fileId,
    addParents: addList,
    removeParents: removeList
  });

  return response.data;
}

async function moveDriveFilesWithBackoff(moves = [], options = {}) {
  const list = Array.isArray(moves) ? moves.filter(Boolean) : [];
  const concurrency = Math.max(1, Number(options.concurrency) || 2);
  if (!list.length) return [];

  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= list.length) break;
      const move = list[current] || {};
      results[current] = await moveDriveFileWithBackoff(move.fileId, move.addParents || [], move.removeParents || []);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function analyzeFilesWithBackendIABatch(items = [], docType = 'albaran') {
  const validItems = (Array.isArray(items) ? items : []).filter(item => item?.filePath);
  if (!validItems.length) return [];

  mainLog('info', 'analyzeFilesWithBackendIABatch:start', {
    docType,
    totalItems: validItems.length
  });

  const results = [];
  for (const item of validItems) {
    try {
      const single = await analyzeFileWithBackendIA(
        item.filePath,
        item.mimeType || '',
        item.originalName || '',
        docType,
        item.postProcess || null
      );
      results.push({ success: true, analysis: single?.analysis || '', raw: single });
    } catch (error) {
      results.push({ success: false, analysis: '', error: error.message || String(error) });
    }
  }
  return results;
}

async function sendEmailNotification(subject, text, html = '') {
  const auth = getStoredAuth('primary');
  if (!auth?.sessionId) {
    throw new Error('Sesión requerida para enviar email');
  }

  const verifyResp = await refreshSessionTokens('primary');
  const recipientEmail = verifyResp?.email || null;
  const sessionId = store.get('sessionId');
  if (!recipientEmail) {
    throw new Error('No se pudo obtener el email del usuario en sesión para enviar notificación');
  }

  await postWithRetry(`${BACKEND_URL}/email/send`, {
    sessionId,
    to: recipientEmail,
    subject,
    text,
    html
  });
}

async function uploadLocalFileToDrive(sessionId, filePath, targetFolderId) {
  const formData = new FormData();
  formData.append('sessionId', sessionId);
  if (targetFolderId) {
    formData.append('targetFolderId', targetFolderId);
  }
  formData.append('file', fs.createReadStream(filePath));

  const response = await postWithRetry(`${BACKEND_URL}/drive/upload`, formData, {
    timeout: DRIVE_UPLOAD_TIMEOUT_MS,
    retries: 2,
    axiosOptions: {
      headers: {
        ...formData.getHeaders()
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    }
  });

  return response.data;
}

async function uploadGeneratedTxtFiles(targetFolderId, analysisText, sourceFileName = null) {
  const sessionId = store.get('sessionId');
  if (!sessionId || !targetFolderId) return;

  const payload = buildTxtFilesFromAnalysis(analysisText, sourceFileName);
  if (!payload || !payload.files.length) return;

  const tempDir = path.join(app.getPath('temp'), 'ia-json');
  fs.mkdirSync(tempDir, { recursive: true });

  for (const file of payload.files) {
    const safeName = sanitizeFileName(file.name);
    const tempPath = path.join(tempDir, safeName);
    fs.writeFileSync(tempPath, file.content || '', 'utf8');

    try {
      await uploadLocalFileToDrive(sessionId, tempPath, targetFolderId);
    } finally {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

async function waitForFileReady(filePath, attempts = 8, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        return true;
      }
    } catch (e) {
      // ignore until file exists
    }
    await sleep(delayMs);
  }
  return false;
}

async function performLocalOCRWithRetry(filePath, mimeType, originalName) {
  let attempt = 0;
  while (attempt <= OCR_RETRY_ATTEMPTS) {
    try {
      return await performLocalOCR(filePath, mimeType, originalName);
    } catch (error) {
      if (attempt >= OCR_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(OCR_RETRY_DELAY_MS);
      attempt += 1;
    }
  }
}

// Helper function to get binary paths
function getBinaryPaths() {
  // In production, binaries are in process.resourcesPath/bin
  // In development, they are in the assets folder
  const isPackaged = app.isPackaged;
  const basePath = isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, 'assets', 'bin', 'win');

  const buildPath = isPackaged
    ? path.join(process.resourcesPath, 'ocr')
    : path.join(__dirname, 'ocr');

  return {
    tesseract: path.join(basePath, 'tesseract', 'tesseract.exe'),
    tessdata: path.join(basePath, 'tesseract', 'tessdata'),
    pdftoppm: path.join(basePath, 'poppler', 'pdftoppm.exe'),
    ocr: path.join(buildPath,  'ocr.exe')
    // ocr: path.join(buildPath, 'ocr', 'ocr.exe')
  };
}

// Local OCR function using ocr.exe from build folder
async function performLocalOCR(filePath, mimeType, originalName) {
  return new Promise((resolve, reject) => {
    const binPaths = getBinaryPaths();
    const ocrExePath = binPaths.ocr;

    // Verify ocr.exe exists
    if (!fs.existsSync(ocrExePath)) {
      mainLog('error', 'performLocalOCR:missing-executable', {
        ocrExePath,
        filePath,
        mimeType,
        originalName
      });
      reject(new Error(`OCR executable not found at: ${ocrExePath}`));
      return;
    }

    mainLog('info', 'performLocalOCR:start', {
      filePath,
      mimeType,
      originalName,
      ocrExePath
    });

    const ocrProcess = spawn(ocrExePath, [filePath]);

    let stdout = '';
    let stderr = '';

    ocrProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ocrProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ocrProcess.on('close', (code) => {
      if (code !== 0) {
        const message = stderr || 'OCR failed with no stderr output';
        mainLog('error', 'performLocalOCR:error', {
          filePath,
          code,
          stderr: message
        });
        reject(new Error(`OCR failed: ${message}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            mainLog('error', 'performLocalOCR:result-error', {
              filePath,
              resultError: result.error
            });
            reject(new Error(result.error));
          } else {
            mainLog('info', 'performLocalOCR:ok', {
              filePath,
              quality: result.quality,
              textLength: result?.text?.length || 0
            });
            resolve(result);
          }
        } catch (e) {
          mainLog('error', 'performLocalOCR:invalid-json-output', {
            filePath,
            stdoutPreview: (stdout || '').slice(0, 500),
            stderrPreview: (stderr || '').slice(0, 500)
          });
          reject(new Error('Invalid JSON output from OCR'));
        }
      }
    });
  });
}

const store = new Store({
  // Mantener siempre un almacenamiento estable para que la sesión sobreviva
  // entre reinicios de la app.
  name: 'config'
});
let mainWindow;
let bdWindow;
let billingMonitorInterval = null;
let billingMonitorRunning = false;
let windowReadyResolve;
const windowReadyPromise = new Promise((resolve) => {
  windowReadyResolve = resolve;
});
const startupScanState = {
  inProgress: false,
  completed: false,
  waitingForSession: false
};

function resetSessionOnAppStart() {
  if (RESET_SESSION_ON_START) {
    store.delete('sessionId');
    store.delete('billingSessionId');
    store.delete('refreshToken');
    store.delete('billingRefreshToken');
  }
}

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

  mainWindow.webContents.once('did-finish-load', () => {
    if (windowReadyResolve) {
      windowReadyResolve();
    }
  });
}

function openBdWindow() {
  if (bdWindow && !bdWindow.isDestroyed()) {
    bdWindow.focus();
    return;
  }

  bdWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    parent: mainWindow,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets/icon.png')
  });

  bdWindow.loadFile('bd.html');
  bdWindow.on('closed', () => {
    bdWindow = null;
  });
}

app.whenReady().then(() => {
  mainLog('info', 'app.whenReady:start');
  // La sesión persiste entre reinicios salvo que RESET_SESSION_ON_START=true.
  resetSessionOnAppStart();
  createWindow();

  // Verificar actualizaciones disponibles
  autoUpdater.checkForUpdatesAndNotify();

  // Event listeners para actualizaciones
  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('Update available', info);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available', info);
  });

  autoUpdater.on('error', (err) => {
    log.error('Updater error', err);
  });

  autoUpdater.on('download-progress', (p) => {
    log.info('Download progress', p);
  });

  autoUpdater.on('update-downloaded', () => {
    log.info('Update downloaded; will install now');
    dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['Reiniciar ahora', 'Luego'],
        title: 'Actualización lista',
        message: 'Se descargó una actualización. ¿Quieres reiniciar para instalarla?'
      })
      .then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
      });
  });

  // El escaneo de "No procesado" se lanzará desde el renderer tras iniciar sesión.
  mainLog('info', 'app.whenReady:done');
});

app.on('window-all-closed', () => {
  mainLog('info', 'app event:window-all-closed', { platform: process.platform });
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  mainLog('info', 'app event:activate', { openWindows: BrowserWindow.getAllWindows().length });
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Iniciar proceso de login
ipcMain.handle('google-login', async (event, isUser = false, purpose = 'primary') => {
  try {
    // Obtener URL de autenticación del backend
    const response = await axios.get(`${BACKEND_URL}/auth/url`, {
      params: { isUser }
    });
    
    const { authUrl, sessionId } = response.data;
    
    // Guardar sessionId temporal según propósito
    setStoredAuth({ sessionId, refreshToken: null }, purpose);
    
    // Abrir navegador externo para login
    await shell.openExternal(authUrl);
    
    // Esperar a que el usuario complete el login (polling)
    const userData = await waitForAuth(sessionId, 60, purpose);
    const verifiedSessionId = userData?.sessionId || sessionId;
    const verifiedRefreshToken = userData?.refreshToken || null;
    setStoredAuth({
      sessionId: verifiedSessionId,
      refreshToken: verifiedRefreshToken
    }, purpose);

    if (purpose === 'billing') {
      store.set('billingMode', 'separate');
      store.set('billingSessionId', verifiedSessionId);
      store.set('billingEmail', userData?.email || null);
      startBillingMonitor();
    } else {
      store.set('sessionId', verifiedSessionId);

      const mode = store.get('billingMode');
      if (mode === 'same') {
        store.set('billingSessionId', verifiedSessionId);
        if (verifiedRefreshToken) {
          store.set('billingRefreshToken', verifiedRefreshToken);
        } else {
          store.delete('billingRefreshToken');
        }
        store.set('billingEmail', userData?.email || null);
      }
      startBillingMonitor();
    }
    return userData;
    
  } catch (error) {
    console.error('Error en login:', error);
    const isConnectionRefused = error?.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(String(error?.message || ''));
    if (isConnectionRefused) {
      throw new Error(`No se pudo conectar al backend (${BACKEND_URL}). Si quieres backend local, arráncalo y define BACKEND_URL=http://127.0.0.1:3000`);
    }
    throw new Error('Error al iniciar sesión con Google');
  }
});

// Función para esperar autenticación
async function waitForAuth(sessionId, maxAttempts = 60, purpose = 'primary') {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos

    try {
      const { refreshToken } = getStoredAuth(purpose);
      const response = await axios.post(`${BACKEND_URL}/auth/verify`, {
        sessionId,
        refreshToken
      });

      if (response.data.email) {
        if (response?.data?.sessionId || response?.data?.refreshToken) {
          setStoredAuth({
            sessionId: response?.data?.sessionId,
            refreshToken: response?.data?.refreshToken
          }, purpose);
        }
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
    const response = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
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
    const response = await postWithRetry(`${BACKEND_URL}/drive/share-folder`, {
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

// Compartir Albaranes/No procesado
ipcMain.handle('share-no-procesado-albaranes', async (event, emails = []) => {
  const sessionId = store.get('sessionId');

  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/share-no-procesado-albaranes`, {
      sessionId,
      emails
    });

    return response.data;
  } catch (error) {
    console.error('Error compartiendo No procesado:', error);
    throw new Error(error.response?.data?.error || 'Error al compartir carpeta');
  }
});

ipcMain.handle('get-no-procesado-shared-emails', async () => {
  const sessionId = store.get('sessionId');

  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/no-procesado-shared-emails`, {
      sessionId
    });

    return response.data;
  } catch (error) {
    console.error('Error obteniendo emails de No procesado:', error);
    throw new Error(error.response?.data?.error || 'Error al obtener permisos de carpeta');
  }
});

ipcMain.handle('search-drive-files', async (event, query) => {
  const sessionId = store.get('sessionId');

  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/search-files`, {
      sessionId,
      query
    });

    return response.data;
  } catch (error) {
    console.error('Error buscando archivos en Drive:', error);
    throw new Error(error.response?.data?.error || 'Error al buscar archivos');
  }
});

// Subir archivo
ipcMain.handle('upload-file', async (event, filePath, targetFolderId = null) => {
  const sessionId = store.get('sessionId');

  try {
    // Encontrar o crear la carpeta "Albaranes/No procesado" si no hay destino
    const uploadFolderId = targetFolderId || await getOrCreateAlbaranesNoProcesadoFolder(sessionId);

    // Support single filePath string or array of paths
    const paths = Array.isArray(filePath) ? filePath : [filePath];
    const results = new Array(paths.length);
    let nextIndex = 0;

    async function uploadWorker() {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= paths.length) break;

        const p = paths[current];
        const formData = new FormData();
        formData.append('sessionId', sessionId);
        formData.append('targetFolderId', uploadFolderId);
        formData.append('file', fs.createReadStream(p));

        const response = await postWithRetry(`${BACKEND_URL}/drive/upload`, formData, {
          timeout: DRIVE_UPLOAD_TIMEOUT_MS,
          retries: 2,
          axiosOptions: {
            headers: {
              ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
          }
        });

        results[current] = response.data;
      }
    }

    const workers = Array.from(
      { length: Math.min(DRIVE_UPLOAD_CONCURRENCY, paths.length) },
      () => uploadWorker()
    );
    await Promise.all(workers);

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
      { name: 'Archivos admitidos', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'bmp', 'tif', 'tiff', 'txt'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths; // return array of paths
  }
  return null;
});

// Seleccionar carpeta (modo explícito)
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths;
  }
  return null;
});

// Listar carpetas disponibles en Drive para la sesión
ipcMain.handle('list-folders', async () => {
  const sessionId = store.get('sessionId');
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/list-folders`, { sessionId });
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
    const response = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId });
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

ipcMain.handle('open-bd-window', async () => {
  openBdWindow();
  return { success: true };
});

ipcMain.handle('notify-tasks-completed', async () => {
  const title = 'Tareas completadas';
  const body = 'Se han procesado todos los archivos de la cola.';

  try {
    if (Notification.isSupported()) {
      const notification = new Notification({ title, body });
      notification.show();
      return { success: true, mode: 'notification' };
    }

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['OK'],
      title,
      message: title,
      detail: body
    });

    return { success: true, mode: 'dialog' };
  } catch (error) {
    mainLog('error', 'notify-tasks-completed:error', serializeError(error));
    return { success: false, error: error?.message || 'No se pudo mostrar la notificación' };
  }
});

// Crear carpeta en Drive
ipcMain.handle('create-folder', async (event, name, parentId = null) => {
  const sessionId = store.get('sessionId');
  try {
    const response = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name, parentId });
    return response.data;
  } catch (error) {
    console.error('Error creando carpeta:', error);
    throw new Error(error.response?.data?.error || 'Error al crear carpeta');
  }
});

// Obtener contenido de database.sql desde Drive (Mi unidad/Bases de datos)
ipcMain.handle('get-drive-database-sql', async () => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para cargar la base de datos');
  }

  const rootContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: 'root'
  });
  const rootFolders = (rootContents.data?.files || [])
    .filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  const basesFolder = rootFolders.find(folder => (folder.name || '').toLowerCase() === 'bases de datos');
  if (!basesFolder) {
    throw new Error('No se encontró la carpeta "Bases de datos" en Mi unidad');
  }

  const basesContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: basesFolder.id
  });
  const files = (basesContents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder');
  const dbFile = files.find(item => (item.name || '').toLowerCase() === 'database.sql');
  if (!dbFile) {
    throw new Error('No se encontró el archivo database.sql en Bases de datos');
  }

  const sqlText = await downloadDriveFileToString(dbFile);
  if (!sqlText) {
    throw new Error('El archivo database.sql está vacío o no se pudo leer');
  }

  return { sqlText, fileName: dbFile.name, fileId: dbFile.id };
});

// Obtener Excel de proveedores desde Mi unidad/Base de datos (o Bases de datos)
ipcMain.handle('get-drive-proveedores-excel', async () => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para cargar el Excel');
  }

  const normalize = (value = '') => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const rootContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: 'root'
  });

  const rootFolders = (rootContents.data?.files || [])
    .filter(item => item.mimeType === 'application/vnd.google-apps.folder');

  const targetFolders = ['base de datos', 'bases de datos'];
  const basesFolder = rootFolders.find(folder => targetFolders.includes(normalize(folder.name || '')));
  if (!basesFolder) {
    throw new Error('No se encontró la carpeta "Base de datos" en Mi unidad');
  }

  const basesContents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId,
    folderId: basesFolder.id
  });

  const files = (basesContents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder');

  const excelFile = files.find(item => normalize(item.name || '') === normalize('CORREGIDO_Maestro Proveedores.xlsx'));
  if (!excelFile) {
    throw new Error('No se encontró el archivo CORREGIDO_Maestro Proveedores.xlsx');
  }

  const downloadResponse = await postWithRetry(
    `${BACKEND_URL}/drive/download`,
    { sessionId, fileId: excelFile.id },
    { timeout: 60000, axiosOptions: { responseType: 'arraybuffer' } }
  );

  const dataBase64 = Buffer.from(downloadResponse.data).toString('base64');
  return {
    fileName: excelFile.name,
    fileId: excelFile.id,
    mimeType: excelFile.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    dataBase64
  };
});

// Elegir carpeta para un archivo usando diálogos nativos (evita prompt())
ipcMain.handle('choose-folder', async (event, fileName) => {
  const sessionId = store.get('sessionId');
  try {
    const resp = await postWithRetry(`${BACKEND_URL}/drive/list-folders`, { sessionId });
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
      const created = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: newName });
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
  const auth = getStoredAuth('primary');
  if (!auth?.sessionId) return null;

  const requestSessionInfo = async (sessionId) => {
    const response = await postWithRetry(`${BACKEND_URL}/session/info`, { sessionId }, {
      retries: 1,
      allowAuthRefresh: false
    });
    return response?.data || null;
  };

  try {
    return await requestSessionInfo(auth.sessionId);
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    if (status === 401 && auth.refreshToken) {
      try {
        await refreshSessionTokens('primary');
        const refreshedSessionId = store.get('sessionId');
        if (refreshedSessionId) {
          return await requestSessionInfo(refreshedSessionId);
        }
      } catch (refreshError) {
        mainLog('warn', 'get-user-info:refresh-failed', {
          error: serializeError(refreshError)
        });
      }
    }

    store.delete('sessionId');
    store.delete('refreshToken');
    return null;
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-billing-config', async () => {
  const mode = store.get('billingMode') || null;
  const email = store.get('billingEmail') || null;
  const primarySessionId = store.get('sessionId');

  if (!primarySessionId) {
    return { configured: false, mode: null, email: null };
  }

  if (!mode || !email) {
    return { configured: false, mode: null, email: null };
  }

  return { configured: true, mode, email };
});

ipcMain.handle('set-billing-email-same', async () => {
  const primarySessionId = store.get('sessionId');
  const primaryRefreshToken = store.get('refreshToken') || null;
  if (!primarySessionId) {
    throw new Error('No hay sesión principal activa');
  }

  const verifyResp = await postWithRetry(`${BACKEND_URL}/auth/verify`, {
    sessionId: primarySessionId,
    refreshToken: primaryRefreshToken
  }, { retries: 1, allowAuthRefresh: false });
  const email = verifyResp?.data?.email || null;
  setStoredAuth({
    sessionId: verifyResp?.data?.sessionId,
    refreshToken: verifyResp?.data?.refreshToken
  }, 'primary');

  store.set('billingMode', 'same');
  store.set('billingSessionId', verifyResp?.data?.sessionId || primarySessionId);
  if (verifyResp?.data?.refreshToken || primaryRefreshToken) {
    store.set('billingRefreshToken', verifyResp?.data?.refreshToken || primaryRefreshToken);
  } else {
    store.delete('billingRefreshToken');
  }
  store.set('billingEmail', email);
  startBillingMonitor();

  return { configured: true, mode: 'same', email };
});

ipcMain.handle('start-billing-monitor', async () => {
  startBillingMonitor();
  return { started: true };
});

ipcMain.handle('scan-no-procesado', async () => {
  await scanNoProcesado('login');
  return { success: true };
});

ipcMain.handle('force-pending-comparison', async () => {
  const result = await forcePendingFacturasComparison('manual');
  return { success: true, ...result };
});

ipcMain.handle('ensure-standard-folders', async () => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para crear carpetas');
  }
  return ensureStandardFolders();
});

// Generar link para usuarios
ipcMain.handle('get-user-link', () => {
  // En producción, esta sería la URL de descarga del instalador con parámetro
  // Por ahora retornamos instrucción
  return 'https://tu-sitio.com/DriveShare-Setup.exe?mode=user';
});

// Función para encontrar o crear la carpeta "Albaranes/No procesado"
async function getOrCreateAlbaranesNoProcesadoFolder(sessionId) {
  try {
    // Listar carpetas en la raíz
    const rootFoldersResp = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: 'root' });
    const rootFolders = rootFoldersResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let albaranesFolder = rootFolders.find(f => f.name === 'Albaranes');

    if (!albaranesFolder) {
      // Crear "Albaranes"
    const createResp = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'Albaranes' });
      albaranesFolder = { id: createResp.data.folderId };
    }

    // Listar contenido de "Albaranes"
    const albaranesContentsResp = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, { sessionId, folderId: albaranesFolder.id });
    const albaranesContents = albaranesContentsResp.data.files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');

    let noProcesadoFolder = albaranesContents.find(f => f.name === 'No procesado');

    if (!noProcesadoFolder) {
      // Crear "No procesado" dentro de "Albaranes"
      const createResp = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, { sessionId, name: 'No procesado', parentId: albaranesFolder.id });
      noProcesadoFolder = { id: createResp.data.folderId };
    }

    return noProcesadoFolder.id;
  } catch (error) {
    console.error('Error finding or creating Albaranes/No procesado folder:', error);
    throw new Error('Error al encontrar o crear carpeta Albaranes/No procesado');
  }
}

// Analyze document with local OCR and AI analysis
ipcMain.handle('analyze-document', async (event, filePath, mimeType, originalName, docType = 'albaran') => {
  try {
    return await analyzeFileWithBackendIA(filePath, mimeType, originalName, docType, null);
  } catch (error) {
    console.error('Error analyzing document:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar el documento');
  }
});

// Alias de compatibilidad: algunos flujos llaman a 'analyze-file'
// Mantiene compatibilidad incluso si el backend aún no expone /analyze/document/*/file.
ipcMain.handle('analyze-file', async (event, filePath, mimeType = '', originalName = '', docType = 'albaran', postProcess = null) => {
  try {
    return await analyzeFileWithBackendIA(filePath, mimeType, originalName, docType, postProcess);
  } catch (error) {
    console.error('Error analizando archivo con IA:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar documento con IA');
  }
});

ipcMain.handle('analyze-files-batch', async (event, items = [], docType = 'albaran') => {
  try {
    return await analyzeFilesWithBackendIABatch(items, docType);
  } catch (error) {
    console.error('Error analizando archivos en batch con IA:', error);
    throw new Error(error.response?.data?.error || error.message || 'Error al analizar documentos en batch con IA');
  }
});

ipcMain.handle('ocr-document', async (event, filePath, mimeType, originalName) => {
  try {
    return await performLocalOCR(filePath, mimeType, originalName);
  } catch (error) {
    console.error('Error en OCR:', error);
    throw new Error(error.message || 'Error en OCR');
  }
});

ipcMain.handle('analyze-text', async (event, text, quality = 0.5, docType = 'albaran') => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para analizar texto');
  }

  try {
    const response = await postWithRetry(getLegacyAnalyzeTextEndpoint(docType), {
      text,
      quality,
      sessionId
    });
    return response.data;
  } catch (error) {
    console.error('Error analizando texto:', error);
    throw new Error(error.response?.data?.error || 'Error al analizar texto');
  }
});

// Enviar email (solo usado en comparaciones factura vs albarán)
ipcMain.handle('send-email', async (event, payload) => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para enviar email');
  }

  const { to, subject, text, html } = payload || {};
  if (!to) {
    throw new Error('Destinatario requerido');
  }

  try {
    const response = await postWithRetry(`${BACKEND_URL}/email/send`, {
      sessionId,
      to,
      subject,
      text,
      html
    });
    return response.data;
  } catch (error) {
    console.error('Error enviando email:', error);
    const details = error.response?.data?.details;
    const baseMessage = error.response?.data?.error || 'Error al enviar email';
    const message = details ? `${baseMessage}: ${JSON.stringify(details)}` : baseMessage;
    throw new Error(message);
  }
});


// Mover archivo en Drive (agregar/quitar padres)
ipcMain.handle('move-file', async (event, fileId, addParents = [], removeParents = []) => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para mover archivo');
  }
  if (!fileId) {
    throw new Error('fileId requerido para mover archivo');
  }

  const addList = Array.isArray(addParents) ? addParents : (addParents ? [addParents] : []);
  const removeList = Array.isArray(removeParents) ? removeParents : (removeParents ? [removeParents] : []);

  try {
    return await moveDriveFileWithBackoff(fileId, addList, removeList);
  } catch (error) {
    console.error('Error moviendo archivo:', error);
    throw new Error(error.response?.data?.error || 'Error al mover archivo');
  }
});

function isAllowedExtension(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return WATCHED_EXTENSIONS.includes(ext);
}


function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(channel, payload);
  } catch (e) {
    log.warn(`No se pudo enviar evento ${channel}:`, e);
  }
}

async function waitForWindowReady() {
  try {
    await windowReadyPromise;
  } catch (e) {
    // ignore
  }
}

async function processNoProcesadoFileWithEvents(fileMeta, queueId, options = {}) {
  const fileName = fileMeta.name || 'Archivo';
  const docType = normalizeDocumentType(fileMeta?.sourceRoot);
  const shouldEmitInit = options.emitQueueInit !== false;

  if (shouldEmitInit) {
    emitToRenderer('queue-event', {
      type: 'init',
      id: queueId,
      fileName,
      source: 'startup',
      docType
    });
  }

  let localPath = options.localPath || null;
  let mimeType = options.mimeType || '';

  if (!localPath) {
    const downloaded = await downloadDriveFileToTemp(fileMeta, fileName);
    localPath = downloaded.localPath;
    mimeType = downloaded.mimeType;
  }

  try {
    const ready = await waitForFileReady(localPath);
    if (!ready) {
      throw new Error('Archivo descargado no disponible para análisis');
    }

    let analysisResult = options.analysisResult || null;
    if (!analysisResult) {
      emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'IA' });
      analysisResult = await analyzeFileWithBackendIA(localPath, mimeType, fileName, docType, {
        txtFolderId: options?.pipeline?.txtFolderId || null,
        sourceDriveFileId: fileMeta?.id || null,
        sourceDriveFromFolderId: fileMeta?.noProcesadoId || null,
        sourceDriveToFolderId: options?.pipeline?.sourceToFolderId || null,
        sourceFileName: fileName
      });
    }

    if (docType === 'factura') {
      // Las facturas en startup quedan en espera hasta que estén sus albaranes,
      // exactamente como en flujo de subida cuando se procesa factura primero.
      emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Esperando albaranes' });
      return;
    }

    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Enviando' });

    // Sin envío de email: se eliminó notificación por JSON

    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Enviado' });
  } finally {
    try {
      if (localPath && fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    } catch (cleanupError) {
      log.warn('No se pudo limpiar archivo temporal descargado:', cleanupError);
    }
  }
}

async function downloadDriveFileToTemp(fileMeta, fallbackName) {
  const sessionId = store.get('sessionId');
  const attempts = 2;
  let lastError;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const downloadResponse = await postWithRetry(
        `${BACKEND_URL}/drive/download`,
        { sessionId, fileId: fileMeta.id },
        { timeout: 60000, axiosOptions: { responseType: 'stream' } }
      );

      const mimeType = decodeURIComponent(downloadResponse.headers['content-type'] || '');
      const localPath = await saveDownloadedFileToTemp(downloadResponse, fallbackName);
      const stats = fs.existsSync(localPath) ? fs.statSync(localPath) : null;
      if (!stats || stats.size === 0) {
        throw new Error('Descarga completada pero el archivo está vacío');
      }

      return { localPath, mimeType };
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await sleep(2000);
    }
  }

  throw lastError || new Error('No se pudo descargar archivo de Drive');
}

async function saveDownloadedFileToTemp(downloadResponse, fallbackName) {
  const tempDir = path.join(app.getPath('temp'), 'drive-downloads');
  fs.mkdirSync(tempDir, { recursive: true });
  const headerName = downloadResponse.headers['x-file-name'];
  const safeName = decodeURIComponent(headerName || fallbackName || 'documento').replace(/[\\/]/g, '_');
  const localPath = path.join(tempDir, `${Date.now()}-${safeName}`);

  if (downloadResponse.data && typeof downloadResponse.data.pipe === 'function') {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(localPath);
      downloadResponse.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    return localPath;
  }

  if (Buffer.isBuffer(downloadResponse.data)) {
    fs.writeFileSync(localPath, downloadResponse.data);
    return localPath;
  }

  throw new Error('Descarga inválida desde Drive');
}

async function getDriveFolderByName(parentId, name) {
  const res = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: parentId || null
  });

  const folders = (res.data?.files || []).filter(item => item.mimeType === 'application/vnd.google-apps.folder');
  return folders.find(folder => (folder.name || '').toLowerCase() === name.toLowerCase()) || null;
}

async function getOrCreateChildFolder(parentId, childName) {
  const existing = await getDriveFolderByName(parentId, childName);
  if (existing) {
    return existing;
  }

  const created = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
    sessionId: store.get('sessionId'),
    name: childName,
    parentId
  });

  return { id: created.data.folderId, name: created.data.folderName || childName };
}

async function getDriveFileByExactName(parentId, fileName) {
  const res = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: parentId || null
  });

  const files = (res.data?.files || []).filter(item => item.mimeType !== 'application/vnd.google-apps.folder');
  return files.find(file => (file.name || '').toLowerCase() === (fileName || '').toLowerCase()) || null;
}

async function ensureInformesTrackingFile() {
  const informesStructure = await ensureInformesFolders();
  const informesFolder = informesStructure?.rootFolder;

  let lastEmailFile = await getDriveFileByExactName(informesFolder.id, LAST_EMAIL_FILE_NAME);
  if (!lastEmailFile) {
    const upsertResp = await postWithRetry(`${BACKEND_URL}/drive/upsert-text-file`, {
      sessionId: store.get('sessionId'),
      folderId: informesFolder.id,
      fileName: LAST_EMAIL_FILE_NAME,
      content: ''
    }, { retries: 1, timeout: 60000 });
    lastEmailFile = upsertResp?.data?.file || await getDriveFileByExactName(informesFolder.id, LAST_EMAIL_FILE_NAME);
  }

  return {
    folder: informesFolder,
    file: lastEmailFile,
    structure: informesStructure
  };
}

async function ensureInformesFolders() {
  let informesFolder = await getDriveFolderByName(null, REPORTS_FOLDER_NAME);
  const created = [];
  if (!informesFolder) {
    const createdRoot = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
      sessionId: store.get('sessionId'),
      name: REPORTS_FOLDER_NAME,
      parentId: null
    });
    informesFolder = { id: createdRoot.data.folderId, name: createdRoot.data.folderName || REPORTS_FOLDER_NAME };
    created.push(REPORTS_FOLDER_NAME);
  }

  const structures = {};
  for (const [sourceRoot, informesSubfolderName] of Object.entries(REPORTS_SUBFOLDERS)) {
    let sourceInformesFolder = await getDriveFolderByName(informesFolder.id, informesSubfolderName);
    if (!sourceInformesFolder) {
      sourceInformesFolder = await getOrCreateChildFolder(informesFolder.id, informesSubfolderName);
      created.push(`${REPORTS_FOLDER_NAME}/${informesSubfolderName}`);
    }

    let noProcesado = await getDriveFolderByName(sourceInformesFolder.id, 'No Procesado');
    if (!noProcesado) {
      noProcesado = await getOrCreateChildFolder(sourceInformesFolder.id, 'No Procesado');
      created.push(`${REPORTS_FOLDER_NAME}/${informesSubfolderName}/No Procesado`);
    }

    let noComparado = await getDriveFolderByName(sourceInformesFolder.id, 'No Comparado');
    if (!noComparado) {
      noComparado = await getOrCreateChildFolder(sourceInformesFolder.id, 'No Comparado');
      created.push(`${REPORTS_FOLDER_NAME}/${informesSubfolderName}/No Comparado`);
    }

    let documentosInformes = await getDriveFolderByName(sourceInformesFolder.id, 'Documentos-Informes');
    if (!documentosInformes) {
      documentosInformes = await getOrCreateChildFolder(sourceInformesFolder.id, 'Documentos-Informes');
      created.push(`${REPORTS_FOLDER_NAME}/${informesSubfolderName}/Documentos-Informes`);
    }

    structures[sourceRoot] = {
      informesFolder: sourceInformesFolder,
      noProcesado,
      noComparado,
      documentosInformes
    };
  }

  return {
    rootFolder: informesFolder,
    bySourceRoot: structures,
    created
  };
}

async function getInformesNoComparadoFolder(sourceRootName = 'Albaranes') {
  const normalized = normalizeDocumentType(sourceRootName) === 'factura' ? 'Facturas' : 'Albaranes';
  const structure = await ensureInformesFolders();
  const target = structure?.bySourceRoot?.[normalized]?.noComparado;
  if (!target?.id) {
    throw new Error(`No se pudo resolver Informes/${normalized} para No Comparado`);
  }
  return target;
}

async function getInformesNoProcesadoFolder(sourceRootName = 'Albaranes') {
  const normalized = normalizeDocumentType(sourceRootName) === 'factura' ? 'Facturas' : 'Albaranes';
  const structure = await ensureInformesFolders();
  const target = structure?.bySourceRoot?.[normalized]?.noProcesado;
  if (!target?.id) {
    throw new Error(`No se pudo resolver Informes/${normalized} para No Procesado`);
  }
  return target;
}

async function getInformesDocumentosFolder(sourceRootName = 'Albaranes') {
  const normalized = normalizeDocumentType(sourceRootName) === 'factura' ? 'Facturas' : 'Albaranes';
  const structure = await ensureInformesFolders();
  const target = structure?.bySourceRoot?.[normalized]?.documentosInformes;
  if (!target?.id) {
    throw new Error(`No se pudo resolver Informes/${normalized} para Documentos-Informes`);
  }
  return target;
}

async function readLastProcessedEmailState() {
  // Proceso de lectura de Ult_email.txt deshabilitado por solicitud.
  // No se elimina, se deja comentado.
  /*
  const tracking = await ensureInformesTrackingFile();
  const file = tracking?.file;

  if (!file?.id) {
    return { tracking, state: null };
  }

  try {
    const raw = await downloadDriveFileToString({ id: file.id, name: file.name || LAST_EMAIL_FILE_NAME });
    const trimmed = (raw || '').trim();
    if (!trimmed) {
      return { tracking, state: null };
    }

    try {
      const parsed = JSON.parse(trimmed);
      const historyId = parsed?.historyId ? String(parsed.historyId) : null;
      const messageId = parsed?.messageId ? String(parsed.messageId) : null;
      const internalDate = parsed?.internalDate ? Number(parsed.internalDate) : null;
      if (!historyId && !messageId && !internalDate) {
        return { tracking, state: null };
      }
      return {
        tracking,
        state: {
          historyId,
          messageId,
          internalDate: Number.isFinite(internalDate) ? internalDate : null,
          subject: parsed?.subject || null,
          from: parsed?.from || null,
          date: parsed?.date || null
        }
      };
    } catch {
      // Compatibilidad: si el fichero tenía solo el historyId/messageId en texto plano
      const asNumber = Number(trimmed);
      return {
        tracking,
        state: {
          historyId: Number.isFinite(asNumber) ? String(trimmed) : null,
          messageId: Number.isFinite(asNumber) ? null : trimmed,
          internalDate: null
        }
      };
    }
  } catch (error) {
    log.warn('No se pudo leer Ult_email.txt:', error?.message || error);
    return { tracking, state: null };
  }
  */

  return { tracking: null, state: null };
}

async function writeLastProcessedEmailState(tracking, messageInfo = {}) {
  const folderId = tracking?.folder?.id;
  if (!folderId) return;

  const payload = {
    historyId: messageInfo?.historyId || null,
    messageId: messageInfo?.messageId || null,
    internalDate: messageInfo?.internalDate || null,
    subject: messageInfo?.subject || null,
    from: messageInfo?.from || null,
    date: messageInfo?.date || null,
    updatedAt: new Date().toISOString()
  };

  await postWithRetry(`${BACKEND_URL}/drive/upsert-text-file`, {
    sessionId: store.get('sessionId'),
    folderId,
    fileName: LAST_EMAIL_FILE_NAME,
    content: JSON.stringify(payload, null, 2)
  }, { retries: 1, timeout: 60000 });
}

function getPendingMessagesAfterLastState(messages = [], lastState = null) {
  if (!lastState || (!lastState.messageId && !lastState.internalDate)) {
    return messages;
  }

  const lastId = lastState?.messageId ? String(lastState.messageId) : null;
  const lastTs = Number(lastState?.internalDate || 0);
  const hasLastTs = Number.isFinite(lastTs) && lastTs > 0;

  if (hasLastTs) {
    return messages.filter((messageInfo) => {
      const currentId = messageInfo?.messageId ? String(messageInfo.messageId) : null;
      const currentTs = Number(messageInfo?.internalDate || 0);
      const hasCurrentTs = Number.isFinite(currentTs) && currentTs > 0;
      if (!hasCurrentTs) {
        return currentId ? currentId !== lastId : true;
      }
      if (currentTs > lastTs) return true;
      if (currentTs < lastTs) return false;
      return currentId ? currentId !== lastId : false;
    });
  }

  if (lastId) {
    const idx = messages.findIndex((messageInfo) => String(messageInfo?.messageId || '') === lastId);
    if (idx >= 0) {
      return messages.slice(idx + 1);
    }
    return messages;
  }

  return messages;
}

async function fetchLatestBillingHistoryId(sessionId) {
  const response = await postWithRetry(`${BACKEND_URL}/gmail/latest-history-id`, {
    sessionId
  }, { timeout: 60000, retries: 1 });

  return {
    historyId: response?.data?.historyId ? String(response.data.historyId) : null,
    messageId: response?.data?.messageId || null,
    internalDate: Number.isFinite(Number(response?.data?.internalDate))
      ? Number(response.data.internalDate)
      : null
  };
}

async function listBillingHistoryAttachments(sessionId, startHistoryId) {
  const response = await postWithRetry(`${BACKEND_URL}/gmail/history-attachments`, {
    sessionId,
    startHistoryId,
    maxResults: 500
  }, { timeout: 60000, retries: 1 });

  return {
    startHistoryId: response?.data?.startHistoryId ? String(response.data.startHistoryId) : null,
    newestHistoryId: response?.data?.newestHistoryId ? String(response.data.newestHistoryId) : null,
    attachments: Array.isArray(response?.data?.attachments) ? response.data.attachments : [],
    messages: Array.isArray(response?.data?.messages) ? response.data.messages : []
  };
}

async function getOrCreateNoComparadoFolder(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) {
    throw new Error(`No se encontró la carpeta "${rootFolderName}" en Drive`);
  }

  return getOrCreateChildFolder(rootFolder.id, 'No comparado');
}

async function ensureRootFolderWithChildren(rootName, childNames) {
  const created = [];
  let rootFolder = await getDriveFolderByName(null, rootName);
  if (!rootFolder) {
    const createdRoot = await postWithRetry(`${BACKEND_URL}/drive/create-folder`, {
      sessionId: store.get('sessionId'),
      name: rootName,
      parentId: null
    });
    rootFolder = { id: createdRoot.data.folderId, name: createdRoot.data.folderName || rootName };
    created.push(rootName);
  }

  const ensuredChildren = {};
  for (const childName of childNames) {
    const existing = await getDriveFolderByName(rootFolder.id, childName);
    if (!existing) {
      created.push(`${rootName}/${childName}`);
    }
    ensuredChildren[childName] = existing || await getOrCreateChildFolder(rootFolder.id, childName);
  }

  return { rootFolder, children: ensuredChildren, created };
}

async function ensureStandardFolders() {
  const childNames = ['No procesado', 'No comparado', 'Documentos'];
  const albaranes = await ensureRootFolderWithChildren('Albaranes', childNames);
  const facturas = await ensureRootFolderWithChildren('Facturas', childNames);
  const informesFolders = await ensureInformesFolders();
  const informes = await ensureInformesTrackingFile();
  const created = [
    ...albaranes.created,
    ...facturas.created,
    ...(informesFolders?.created || [])
  ];
  if (informes?.folder?.name && !informes?.file?.id) {
    created.push(`${informes.folder.name}/${LAST_EMAIL_FILE_NAME}`);
  }
  return {
    albaranes,
    facturas,
    informes,
    informesFolders,
    created
  };
}

async function getOrCreateDocumentosFolder(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) {
    throw new Error(`No se encontró la carpeta "${rootFolderName}" en Drive`);
  }

  return getOrCreateChildFolder(rootFolder.id, 'Documentos');
}

async function moveDriveFileToFolder(fileMeta, targetFolderId, currentFolderId) {
  if (!fileMeta?.id || !targetFolderId) return;
  await moveDriveFileWithBackoff(fileMeta.id, [targetFolderId], currentFolderId ? [currentFolderId] : []);
}

async function moveGeneratedTxtToInformesDocumentos(analysisText, informesSourceFolderIds = [], informesDocumentosFolderId) {
  if (!analysisText || !informesDocumentosFolderId) return;

  const sourceFolderIds = (Array.isArray(informesSourceFolderIds) ? informesSourceFolderIds : [informesSourceFolderIds]).filter(Boolean);
  if (!sourceFolderIds.length) return;

  const payload = buildTxtFilesFromAnalysis(analysisText);
  if (!payload?.files?.length) return;

  const txtFilesByName = new Map();
  for (const folderId of sourceFolderIds) {
    const txtFiles = await findDriveFileInFolder(folderId, '');
    for (const file of txtFiles) {
      if (!file?.id || !file?.name) continue;
      txtFilesByName.set((file.name || '').toLowerCase(), { ...file, sourceFolderId: folderId });
    }
  }

  for (const generated of payload.files) {
    const match = txtFilesByName.get((generated?.name || '').toLowerCase());
    if (match?.id) {
      await moveDriveFileToFolder(match, informesDocumentosFolderId, match.sourceFolderId || null);
    }
  }
}

// COPIA (SOLICITUD CLIENTE): mover SOLO TXT de TOTALES a Documentos-Informes.
// Se mantiene la función original para histórico.
async function moveGeneratedTotalTxtToInformesDocumentos(analysisText, informesSourceFolderIds = [], informesDocumentosFolderId) {
  if (!analysisText || !informesDocumentosFolderId) return;

  const sourceFolderIds = (Array.isArray(informesSourceFolderIds) ? informesSourceFolderIds : [informesSourceFolderIds]).filter(Boolean);
  if (!sourceFolderIds.length) return;

  const payload = buildTxtFilesFromAnalysis(analysisText);
  if (!payload?.files?.length) return;

  const totalFiles = payload.files.filter((generated) => /^total/i.test(String(generated?.name || '').trim()));
  if (!totalFiles.length) return;

  const txtFilesByName = new Map();
  for (const folderId of sourceFolderIds) {
    const txtFiles = await findDriveFileInFolder(folderId, '');
    for (const file of txtFiles) {
      if (!file?.id || !file?.name) continue;
      txtFilesByName.set((file.name || '').toLowerCase(), { ...file, sourceFolderId: folderId });
    }
  }

  for (const generated of totalFiles) {
    const match = txtFilesByName.get((generated?.name || '').toLowerCase());
    if (match?.id) {
      await moveDriveFileToFolder(match, informesDocumentosFolderId, match.sourceFolderId || null);
    }
  }
}

async function moveAlbaranAssetsToDocumentos({
  albaranNum,
  albaranLines,
  albaranesNoComparadoFolderId,
  documentosFolderId
}) {
  if (!documentosFolderId || !albaranesNoComparadoFolderId) return;

  const sourceFileName = albaranLines.find(item => item?.source_file)?.source_file;
  if (sourceFileName) {
    const sourceFiles = await findDriveFileInFolder(albaranesNoComparadoFolderId, sourceFileName);
    const sourceFile = sourceFiles.find(file => (file.name || '').toLowerCase() === sourceFileName.toLowerCase());
    if (sourceFile) {
      await moveDriveFileToFolder(sourceFile, documentosFolderId, albaranesNoComparadoFolderId);
    }
  }
}

async function findDriveFileInFolder(folderId, nameIncludes) {
  const contents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId
  });

  const files = (contents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
    .filter(item => (item.name || '').toLowerCase().includes((nameIncludes || '').toLowerCase()));

  return files;
}

async function downloadDriveFileToString(fileMeta) {
  const { localPath } = await downloadDriveFileToTemp(fileMeta, fileMeta.name);
  const text = fs.readFileSync(localPath, 'utf8');
  try {
    fs.unlinkSync(localPath);
  } catch (e) {}
  return text;
}

async function compareFacturaWithAlbaranes({ facturaAnalysisText, rootFolderName, compareMode = 'totales' }) {
  const parsed = parseFacturaAnalysis(facturaAnalysisText);
  const parsedFacturaTotal = parseComparableNumber(parsed?.resumen?.total);
  if (!parsed || !parsed.albaranNumbers.length) {
    return {
      ok: true,
      message: 'No se detectaron albaranes en la factura.',
      issues: [],
      matchedAlbaranes: [],
      expectedAlbaranes: [],
      incongruentAlbaranes: [],
      incongruentAlbaranDocs: [],
      congruentAlbaranDocs: [],
      facturaTotal: parsedFacturaTotal,
      sumatoriaTotalesAlbaranes: null
    };
  }

  const albaranesRoot = await getDriveFolderByName(null, 'Albaranes');
  if (!albaranesRoot) {
    return { ok: false, message: 'No se encontró la carpeta "Albaranes" en Drive.', issues: [] };
  }

  const albaranesNoComparadoFolder = await getDriveFolderByName(albaranesRoot.id, 'No comparado');
  if (!albaranesNoComparadoFolder) {
    return { ok: false, message: 'No se encontró carpeta No comparado en Drive.', issues: [], matchedAlbaranes: [], expectedAlbaranes: parsed.albaranNumbers };
  }

  const informesNoProcesadoFolder = await getInformesNoProcesadoFolder('Albaranes');
  const informesNoComparadoFolder = await getInformesNoComparadoFolder('Albaranes');
  const facturasInformesNoProcesadoFolder = await getInformesNoProcesadoFolder('Facturas');
  const facturasInformesNoComparadoFolder = await getInformesNoComparadoFolder('Facturas');
  const albaranesInformesDocumentosFolder = await getInformesDocumentosFolder('Albaranes');
  const facturasInformesDocumentosFolder = await getInformesDocumentosFolder('Facturas');

  const documentosFolder = await getOrCreateDocumentosFolder('Albaranes');

  const facturaArticulos = parsed.articulos || [];
  const facturaByAlbaran = new Map();
  facturaArticulos.forEach(item => {
    const num = normalizeAlbaranNumberForMatch(item.num_albaran);
    if (!num) return;
    const list = facturaByAlbaran.get(num) || [];
    list.push(item);
    facturaByAlbaran.set(num, list);
  });

  const overallIssues = [];
  const matchedAlbaranes = [];
  const incongruentAlbaranes = [];
  const incongruentAlbaranDocs = [];
  const congruentAlbaranDocs = [];
  // MODO FORZADO A TOTALES (solicitud cliente):
  // Se mantiene la línea original comentada para referencia.
  // const mode = String(compareMode || '').toLowerCase() === 'totales' ? 'totales' : 'complejo';
  const mode = 'totales';
  const facturaTotal = parseComparableNumber(parsed?.resumen?.total);
  let sumatoriaTotalesAlbaranes = 0;
  let hasMissingAlbaranTotals = false;
  const albaranDocsByNum = new Map();
  const informesNoProcesadoFiles = await findDriveFileInFolder(informesNoProcesadoFolder.id, '');
  const informesNoComparadoFilesOnly = await findDriveFileInFolder(informesNoComparadoFolder.id, '');
  const informesNoComparadoFiles = [
    ...informesNoProcesadoFiles.map(file => ({ ...file, sourceFolderId: informesNoProcesadoFolder.id })),
    ...informesNoComparadoFilesOnly.map(file => ({ ...file, sourceFolderId: informesNoComparadoFolder.id }))
  ];

  for (const albaranNum of parsed.albaranNumbers) {
    let sourceFile = null;
    const albaranTxt = resolveAlbaranTxtFile(albaranNum, informesNoComparadoFiles);

    // LÓGICA ANTIGUA (NO TOTALES) DESHABILITADA:
    // No se exige .txt de líneas para poder comparar.
    // if (!albaranTxt) {
    //   overallIssues.push(`No se encontró .txt del albarán ${albaranNum} en No comparado.`);
    //   incongruentAlbaranes.push(albaranNum);
    //   continue;
    // }

    const albaranLines = albaranTxt
      ? parseJsonLines(await downloadDriveFileToString(albaranTxt))
      : [];
    const facturaLinesForAlbaran = facturaByAlbaran.get(normalizeAlbaranNumberForMatch(albaranNum)) || [];

    // LÓGICA ANTIGUA (NO TOTALES) DESHABILITADA:
    // if (mode === 'complejo' && !facturaLinesForAlbaran.length) {
    //   overallIssues.push(`No hay artículos de la factura para el albarán ${albaranNum}.`);
    //   incongruentAlbaranes.push(albaranNum);
    //   continue;
    // }

    const sourceFileName = albaranLines.find(item => item?.source_file)?.source_file;
    if (sourceFileName) {
      const sourceFiles = await findDriveFileInFolder(albaranesNoComparadoFolder.id, sourceFileName);
      sourceFile = sourceFiles.find(file => (file.name || '').toLowerCase() === sourceFileName.toLowerCase()) || null;
    }

    const totalTxt = resolveTotalAlbaranTxtFile(albaranNum, informesNoComparadoFiles);
    let totalDetected = null;
    if (totalTxt) {
      const totalText = await downloadDriveFileToString(totalTxt);
      totalDetected = extractTotalDetectedFromTotalTxtText(totalText);
    }

    albaranDocsByNum.set(albaranNum, {
      albaranNum,
      fileId: sourceFile?.id || null,
      fileName: sourceFile?.name || sourceFileName || null,
      url: sourceFile?.id ? buildDriveFileLink(sourceFile.id) : null,
      totalDetected
    });

    if (mode === 'totales') {
      if (!totalTxt) {
        hasMissingAlbaranTotals = true;
        overallIssues.push(`No se encontró Total${albaranNum}Alb.txt (ni variantes) para comparar por totales.`);
      } else {
        const totalAlbaran = totalDetected;
        if (totalAlbaran === null) {
          hasMissingAlbaranTotals = true;
          overallIssues.push(`Total inválido en ${totalTxt.name || `Total${albaranNum}Alb.txt`}.`);
        } else {
          sumatoriaTotalesAlbaranes += totalAlbaran;
        }
      }
    }

    // LÓGICA ANTIGUA (COMPARACIÓN COMPLEJA POR LÍNEAS) DESHABILITADA:
    // if (mode === 'complejo') {
    //   const facturaMap = aggregateArticles(facturaLinesForAlbaran, 'factura');
    //   const albaranMap = aggregateArticles(albaranLines, 'albaran');
    //   const issues = compareArticleMaps(facturaMap, albaranMap);
    //   if (issues.length) {
    //     overallIssues.push(`Albarán ${albaranNum}:`, ...issues.map(issue => ` - ${issue}`));
    //     incongruentAlbaranes.push(albaranNum);
    //     incongruentAlbaranDocs.push({
    //       albaranNum,
    //       fileId: sourceFile?.id || null,
    //       fileName: sourceFile?.name || sourceFileName || null,
    //       url: sourceFile?.id ? buildDriveFileLink(sourceFile.id) : null,
    //       totalDetected
    //     });
    //   } else {
    //     congruentAlbaranDocs.push({
    //       albaranNum,
    //       fileId: sourceFile?.id || null,
    //       fileName: sourceFile?.name || sourceFileName || null,
    //       url: sourceFile?.id ? buildDriveFileLink(sourceFile.id) : null,
    //       totalDetected
    //     });
    //   }
    // }

    try {
      await moveAlbaranAssetsToDocumentos({
        albaranNum,
        albaranLines,
        albaranesNoComparadoFolderId: albaranesNoComparadoFolder.id,
        documentosFolderId: documentosFolder.id
      });
    } catch (moveError) {
      log.warn(`No se pudo mover albarán ${albaranNum} a Documentos:`, moveError);
    }

    try {
      // SOLICITUD CLIENTE: NO MOVER .TXT QUE NO SON TOTALES.
      // Se deja comentado para conservar comportamiento anterior.
      // if (albaranTxt?.id) {
      //   await moveDriveFileToFolder(albaranTxt, albaranesInformesDocumentosFolder.id, albaranTxt.sourceFolderId || null);
      // }
      if (totalTxt?.id) {
        await moveDriveFileToFolder(totalTxt, albaranesInformesDocumentosFolder.id, totalTxt.sourceFolderId || null);
      }
    } catch (txtMoveError) {
      log.warn(`No se pudieron mover TXT del albarán ${albaranNum} a Documentos-Informes:`, txtMoveError);
    }

    matchedAlbaranes.push(albaranNum);
  }

  if (mode === 'totales') {
    if (facturaTotal === null) {
      overallIssues.push('Total de factura inválido para comparar por totales.');
    }

    if (!hasMissingAlbaranTotals && facturaTotal !== null) {
      // SOLICITUD CLIENTE: comparación EXACTA (sin tolerancia).
      // Se mantiene el enfoque anterior comentado para histórico.
      // const totalTolerance = 0.5;
      // if (!numbersClose(facturaTotal, sumatoriaTotalesAlbaranes, totalTolerance)) {
      const facturaTotalCents = amountToCents(facturaTotal);
      const sumatoriaTotalesAlbaranesCents = amountToCents(sumatoriaTotalesAlbaranes);
      if (
        facturaTotalCents === null
        || sumatoriaTotalesAlbaranesCents === null
        || facturaTotalCents !== sumatoriaTotalesAlbaranesCents
      ) {
        overallIssues.push(
          `Diferencia de totales: factura=${facturaTotal}, suma_albaranes=${sumatoriaTotalesAlbaranes}`
        );
      }
    }

    if (overallIssues.length) {
      const incongruentes = matchedAlbaranes.length ? matchedAlbaranes : parsed.albaranNumbers;
      incongruentAlbaranes.push(...incongruentes);
      for (const num of incongruentes) {
        const doc = albaranDocsByNum.get(num);
        if (doc) incongruentAlbaranDocs.push(doc);
      }
    } else {
      for (const num of matchedAlbaranes) {
        const doc = albaranDocsByNum.get(num);
        if (doc) congruentAlbaranDocs.push(doc);
      }
    }
  }

  try {
    // SOLICITUD CLIENTE: no mover .txt no-total.
    // Se mantiene la llamada anterior comentada para histórico.
    // await moveGeneratedTxtToInformesDocumentos(
    //   facturaAnalysisText,
    //   [facturasInformesNoProcesadoFolder?.id, facturasInformesNoComparadoFolder?.id],
    //   facturasInformesDocumentosFolder?.id
    // );
    await moveGeneratedTotalTxtToInformesDocumentos(
      facturaAnalysisText,
      [facturasInformesNoProcesadoFolder?.id, facturasInformesNoComparadoFolder?.id],
      facturasInformesDocumentosFolder?.id
    );
  } catch (txtMoveError) {
    log.warn('No se pudieron mover los TXT de factura a Documentos-Informes:', txtMoveError);
  }

  if (!overallIssues.length) {
    return {
      ok: true,
      message: 'No se encontraron incongruencias.',
      issues: [],
      matchedAlbaranes,
      expectedAlbaranes: parsed.albaranNumbers,
      incongruentAlbaranes: [],
      incongruentAlbaranDocs: [],
      congruentAlbaranDocs,
      facturaTotal,
      sumatoriaTotalesAlbaranes: mode === 'totales' ? sumatoriaTotalesAlbaranes : null
    };
  }

  return {
    ok: false,
    message: `Incongruencias encontradas en ${overallIssues.length} línea(s).`,
    issues: overallIssues,
    matchedAlbaranes,
    expectedAlbaranes: parsed.albaranNumbers,
    incongruentAlbaranes: [...new Set(incongruentAlbaranes)],
    incongruentAlbaranDocs,
    congruentAlbaranDocs,
    facturaTotal,
    sumatoriaTotalesAlbaranes: mode === 'totales' ? sumatoriaTotalesAlbaranes : null
  };
}

ipcMain.handle('compare-factura-albaranes', async (event, payload) => {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('Sesión requerida para comparar albaranes');
  }

  const { facturaAnalysisText, rootFolderName, compareMode = 'totales' } = payload || {};
  if (!facturaAnalysisText || !rootFolderName) {
    throw new Error('Datos insuficientes para comparar albaranes');
  }

  return compareFacturaWithAlbaranes({ facturaAnalysisText, rootFolderName, compareMode });
});

async function listDriveFilesInNoProcesado(rootFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) return [];

  const noProcesado = await getDriveFolderByName(rootFolder.id, 'No procesado');
  if (!noProcesado) return [];

  const contents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: noProcesado.id
  });

  const files = (contents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
    .filter(item => isAllowedExtension(item.name || ''))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(item => ({
      ...item,
      sourceRoot: rootFolderName,
      noProcesadoId: noProcesado.id
    }));

  return files;
}

async function listDriveFilesInFolder(rootFolderName, childFolderName) {
  const rootFolder = await getDriveFolderByName(null, rootFolderName);
  if (!rootFolder) return [];

  const targetFolder = await getDriveFolderByName(rootFolder.id, childFolderName);
  if (!targetFolder) return [];

  const contents = await postWithRetry(`${BACKEND_URL}/drive/list-contents`, {
    sessionId: store.get('sessionId'),
    folderId: targetFolder.id
  });

  return (contents.data?.files || [])
    .filter(item => item.mimeType !== 'application/vnd.google-apps.folder')
    .filter(item => isAllowedExtension(item.name || ''))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(item => ({
      ...item,
      sourceRoot: rootFolderName,
      noProcesadoId: targetFolder.id
    }));
}

function buildFacturaAnalysisTextFromResumen(resumenObj = {}) {
  const resumenLine = JSON.stringify(resumenObj || {});
  return [
    '=== ARTÍCULOS POR ALBARÁN (JSON Lines) ===',
    '',
    '=== RESUMEN FACTURA (JSON) ===',
    resumenLine
  ].join('\n');
}

async function loadFacturaAnalysisTextFromInformesNoComparado(fileMeta, informesNoComparadoFolderId) {
  const files = await findDriveFileInFolder(informesNoComparadoFolderId, '');
  const totalFactFiles = files.filter((file) => /^total/i.test(String(file?.name || '').trim()) && /fact\.txt$/i.test(String(file?.name || '').trim()));
  const targetFileName = String(fileMeta?.name || '').trim().toLowerCase();
  const targetBaseName = String(path.basename(fileMeta?.name || '', path.extname(fileMeta?.name || '')) || '').toLowerCase();

  let fallbackByFacturaNum = null;

  for (const txtFile of totalFactFiles) {
    try {
      const text = await downloadDriveFileToString(txtFile);
      const firstLine = String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean);
      if (!firstLine) continue;

      const resumenObj = JSON.parse(firstLine);
      const sourceFile = String(resumenObj?.source_file || '').trim().toLowerCase();
      const facturaNum = String(resumenObj?.num_factura || '').trim().toLowerCase();

      if (sourceFile && sourceFile === targetFileName) {
        return buildFacturaAnalysisTextFromResumen(resumenObj);
      }

      if (!fallbackByFacturaNum && facturaNum && targetBaseName.includes(facturaNum)) {
        fallbackByFacturaNum = buildFacturaAnalysisTextFromResumen(resumenObj);
      }
    } catch (e) {
      // continuar con siguiente TXT
    }
  }

  if (fallbackByFacturaNum) {
    return fallbackByFacturaNum;
  }

  throw new Error(`No se encontró TXT de informe para factura ${fileMeta?.name || ''}`);
}

function getMissingExpectedAlbaranes(expectedAlbaranes = [], informesAlbaranesFiles = []) {
  const expected = (Array.isArray(expectedAlbaranes) ? expectedAlbaranes : [])
    .map(num => String(num || '').trim())
    .filter(Boolean);

  return expected.filter((num) => !resolveTotalAlbaranTxtFile(num, informesAlbaranesFiles));
}

async function forcePendingFacturasComparison(trigger = 'manual') {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    return {
      totalFacturas: 0,
      compared: 0,
      failed: 0,
      message: 'No hay sesión activa para comparar pendientes.'
    };
  }

  await ensureStandardFolders();

  const facturasNoComparado = await listDriveFilesInFolder('Facturas', 'No comparado');
  const albaranesNoComparado = await listDriveFilesInFolder('Albaranes', 'No comparado');
  const totalFacturas = facturasNoComparado.length;

  if (!totalFacturas) {
    const message = 'No hay facturas pendientes en Facturas/No comparado.';
    emitToRenderer('startup-status', { message });
    return { totalFacturas: 0, compared: 0, failed: 0, message };
  }

  const standard = await ensureStandardFolders();
  const facturasNoComparadoId = standard?.facturas?.children?.['No comparado']?.id || null;
  const facturasDocumentosId = standard?.facturas?.children?.Documentos?.id || null;
  const facturasInformesNoComparadoId = standard?.informesFolders?.bySourceRoot?.Facturas?.noComparado?.id || null;

  let compared = 0;
  let waiting = 0;
  let failed = 0;
  const comparedFileNames = [];
  const waitingFileNames = [];
  const failedFileNames = [];

  emitToRenderer('startup-status', {
    message: `Forzando comparación de ${totalFacturas} factura(s) pendiente(s)...`
  });

  for (let idx = 0; idx < facturasNoComparado.length; idx += 1) {
    const fileMeta = facturasNoComparado[idx];
    const queueId = `force-compare-${Date.now()}-${idx}-${Math.random().toString(16).slice(2)}`;
    const fileName = fileMeta?.name || 'Factura';

    emitToRenderer('queue-event', {
      type: 'init',
      id: queueId,
      fileName,
      source: trigger,
      docType: 'factura'
    });

    try {
      emitToRenderer('startup-status', {
        message: `Comparando factura pendiente ${fileName} (${idx + 1}/${totalFacturas})`
      });

      // SOLICITUD CLIENTE:
      // - Si la factura ya está en No comparado, usar su TXT ya generado en Informes/No comparado.
      // - No volver a pasar por IA.
      const analysisText = await loadFacturaAnalysisTextFromInformesNoComparado(fileMeta, facturasInformesNoComparadoId);
      const parsedFactura = parseFacturaAnalysis(analysisText);

      // Primero factura -> después comprobar existencia de albaranes esperados.
      const informesAlbaranesNoComparado = await getInformesNoComparadoFolder('Albaranes');
      const informesAlbaranesFiles = await findDriveFileInFolder(informesAlbaranesNoComparado.id, '');
      const expectedAlbaranes = Array.isArray(parsedFactura?.albaranNumbers) ? parsedFactura.albaranNumbers : [];
      const missingAlbaranes = getMissingExpectedAlbaranes(expectedAlbaranes, informesAlbaranesFiles);

      if (missingAlbaranes.length) {
        emitToRenderer('queue-event', {
          type: 'step',
          id: queueId,
          step: 'Esperando albaranes',
          fileName
        });
        waiting += 1;
        waitingFileNames.push(fileName);
        continue;
      }

      emitToRenderer('queue-event', {
        type: 'step',
        id: queueId,
        step: 'Comparando',
        fileName
      });
      const compareResult = await compareFacturaWithAlbaranes({
        facturaAnalysisText: analysisText,
        rootFolderName: 'Facturas',
        compareMode: 'totales'
      });
      emitToRenderer('queue-event', {
        type: 'step',
        id: queueId,
        step: 'Comparado',
        fileName
      });

      emitToRenderer('queue-event', {
        type: 'step',
        id: queueId,
        step: 'Email',
        fileName
      });
      const facturaRef = getFacturaReferenceForEmail(analysisText, fileName || 'XX');
      const albaranesLabel = getComparedAlbaranesLabel(compareResult);
      const facturaTotalLabel = formatAmountEuro(parseComparableNumber(compareResult?.facturaTotal));
      const albaranesTotalLabel = formatAmountEuro(parseComparableNumber(compareResult?.sumatoriaTotalesAlbaranes));

      const emailPayload = buildComparisonEmailPayload({
        compareResult,
        fileName,
        facturaRef,
        albaranesLabel,
        facturaTotalLabel,
        albaranesTotalLabel,
        facturaDriveLink: buildDriveFileLink(fileMeta?.id || null)
      });
      await sendEmailNotification(emailPayload.subject, emailPayload.text, emailPayload.html);

      const shouldMoveFactura = compareResult?.ok
        || (Array.isArray(compareResult?.matchedAlbaranes) && compareResult.matchedAlbaranes.length > 0);
      if (shouldMoveFactura && fileMeta?.id && facturasDocumentosId && facturasNoComparadoId) {
        await moveDriveFileWithBackoff(fileMeta.id, [facturasDocumentosId], [facturasNoComparadoId]);
      }

      compared += 1;
      comparedFileNames.push(fileName);
    } catch (error) {
      failed += 1;
      failedFileNames.push(fileName);
      emitToRenderer('queue-event', {
        type: 'error',
        id: queueId,
        message: error?.message || 'Error comparando factura pendiente'
      });
    }
  }

  const message = `Comparación forzada completada: ${compared}/${totalFacturas} factura(s) comparada(s), ${waiting} en espera de albaranes y ${failed} con error. Albaranes disponibles en No comparado: ${albaranesNoComparado.length}.`;
  emitToRenderer('startup-status', { message });

  return {
    totalFacturas,
    compared,
    waiting,
    failed,
    comparedFileNames,
    waitingFileNames,
    failedFileNames,
    availableAlbaranes: albaranesNoComparado.length,
    message
  };
}

async function scanNoProcesado(trigger = 'startup') {
  mainLog('info', 'scanNoProcesado:start', {
    trigger,
    inProgress: startupScanState.inProgress,
    completed: startupScanState.completed
  });
  if (startupScanState.inProgress) return;
  if (startupScanState.completed && trigger !== 'manual' && trigger !== 'login') return;

  startupScanState.inProgress = true;
  await waitForWindowReady();

  const sessionId = store.get('sessionId');
  if (!sessionId) {
    emitToRenderer('startup-status', {
      message: 'No hay sesión activa; no se puede procesar No procesado.'
    });
    startupScanState.inProgress = false;
    startupScanState.waitingForSession = true;
    mainLog('warn', 'scanNoProcesado:no-session');
    return;
  }

  try {
    await refreshSessionTokens('primary');
    await ensureStandardFolders();
  } catch (error) {
    if (error?.response?.status === 401) {
      store.delete('sessionId');
      emitToRenderer('startup-status', {
        message: 'Sesión caducada. Inicia sesión de nuevo para procesar No procesado.'
      });
      startupScanState.inProgress = false;
      startupScanState.waitingForSession = true;
      mainLog('warn', 'scanNoProcesado:session-expired');
      return;
    }
  }

  emitToRenderer('startup-status', { message: 'Revisando carpeta Albaranes (1/2)' });
  const albaranesFiles = await listDriveFilesInNoProcesado('Albaranes');

  emitToRenderer('startup-status', { message: 'Revisando carpeta Facturas (2/2)' });
  const facturasFiles = await listDriveFilesInNoProcesado('Facturas');

  // Flujo unificado solicitado: primero facturas, luego albaranes.
  const allFiles = [...facturasFiles, ...albaranesFiles];
  mainLog('info', 'scanNoProcesado:files-found', {
    trigger,
    albaranes: albaranesFiles.length,
    facturas: facturasFiles.length,
    total: allFiles.length
  });
  if (allFiles.length === 0) {
    emitToRenderer('startup-status', { message: 'No se encontraron archivos en No procesado. Revisando pendientes de comparación...' });
    try {
      await forcePendingFacturasComparison('startup-auto');
    } catch (error) {
      log.warn('No se pudo ejecutar comparación forzada sin archivos nuevos:', error);
    }
    startupScanState.inProgress = false;
    startupScanState.completed = true;
    startupScanState.waitingForSession = false;
    mainLog('info', 'scanNoProcesado:no-files');
    return;
  }

  emitToRenderer('startup-status', {
    message: `Encontrados ${allFiles.length} nuevos archivos en No procesado.`
  });

  let idx = 0;
  for (const fileMeta of allFiles) {
    idx += 1;
    const queueId = `startup-${idx}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileName = fileMeta?.name || 'Archivo';
    emitToRenderer('startup-status', {
      message: `Analizando ${fileName} (${idx}/${allFiles.length})`
    });

    try {
      const noComparado = await getOrCreateNoComparadoFolder(fileMeta?.sourceRoot || 'Albaranes');
      const informesNoComparado = await getInformesNoComparadoFolder(fileMeta?.sourceRoot || 'Albaranes');
      await processNoProcesadoFileWithEvents(fileMeta, queueId, {
        pipeline: {
          txtFolderId: informesNoComparado?.id || null,
          sourceToFolderId: noComparado?.id || null
        }
      });
    } catch (error) {
      emitToRenderer('queue-event', {
        type: 'error',
        id: queueId,
        message: error.message || 'Error desconocido'
      });
      log.error('Error procesando archivo en scan inicial:', error);
    }
  }

  try {
    await forcePendingFacturasComparison('startup-auto');
  } catch (error) {
    log.warn('No se pudo ejecutar comparación forzada tras scan inicial:', error);
  }

  emitToRenderer('startup-status', { message: 'Análisis inicial completado.' });
  startupScanState.inProgress = false;
  startupScanState.completed = true;
  startupScanState.waitingForSession = false;
  mainLog('info', 'scanNoProcesado:done', { processed: allFiles.length });
}

// Cerrar sesión
ipcMain.handle('logout', async () => {
  const sessionId = store.get('sessionId');
  const refreshToken = store.get('refreshToken') || null;

  try {
    await postWithRetry(`${BACKEND_URL}/auth/logout`, {
      sessionId,
      refreshToken
    }, { allowAuthRefresh: false });
  } catch (error) {
    console.error('Error en logout:', error);
  }

  store.clear();
  stopBillingMonitor();
  app.relaunch();
  app.quit();
});

async function ensureBillingSessionReady() {
  const mode = store.get('billingMode');

  if (!mode) return null;

  if (mode === 'same') {
    const primarySessionId = store.get('sessionId');
    if (!primarySessionId) return null;
    store.set('billingSessionId', primarySessionId);
    return primarySessionId;
  }

  let billingSessionId = store.get('billingSessionId');

  if (billingSessionId) {
    try {
      await refreshSessionTokens('billing');
      return store.get('billingSessionId') || billingSessionId;
    } catch (e) {
      billingSessionId = null;
      store.delete('billingSessionId');
    }
  }

  return null;
}

async function listBillingInvoiceAttachments(sessionId) {
  const response = await postWithRetry(`${BACKEND_URL}/gmail/invoice-attachments`, {
    sessionId,
    maxResults: 500
  }, { timeout: 60000, retries: 1 });
  return Array.isArray(response?.data?.attachments) ? response.data.attachments : [];
}

async function markBillingMessagesRead(sessionId, messageIds = []) {
  if (!messageIds.length) return;
  await postWithRetry(`${BACKEND_URL}/gmail/mark-read`, {
    sessionId,
    messageIds
  }, { retries: 1 });
}

function attachmentToTempFile(attachment = {}) {
  const ext = path.extname(attachment.filename || '').toLowerCase();
  if (!BILLING_EMAIL_ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error('Extensión no permitida para monitor de facturas');
  }

  const tempDir = path.join(app.getPath('temp'), 'billing-attachments');
  fs.mkdirSync(tempDir, { recursive: true });
  const safeName = sanitizeFileName(attachment.filename || `adjunto${ext || '.pdf'}`) || `adjunto${ext || '.pdf'}`;
  const fullPath = path.join(tempDir, `${Date.now()}-${safeName}`);
  const buffer = Buffer.from(attachment.dataBase64 || '', 'base64');
  fs.writeFileSync(fullPath, buffer);
  return fullPath;
}

async function processBillingAttachmentAsFactura(attachment) {
  const sessionId = store.get('sessionId');
  if (!sessionId) {
    throw new Error('No hay sesión principal para procesar factura');
  }

  const queueId = `billing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const queueFileName = attachment?.filename || 'Factura (email)';
  emitToRenderer('queue-event', {
    type: 'init',
    id: queueId,
    fileName: queueFileName,
    source: 'billing-email',
    docType: 'factura',
    steps: ['Subiendo', 'IA', 'Comparando', 'comparado', 'email']
  });

  const standard = await ensureStandardFolders();
  const facturasNoProcesadoId = standard?.facturas?.children?.['No procesado']?.id;
  const facturasNoComparadoId = standard?.facturas?.children?.['No comparado']?.id;
  const facturasDocumentosId = standard?.facturas?.children?.['Documentos']?.id;
  const facturasInformesNoComparadoId = standard?.informesFolders?.bySourceRoot?.Facturas?.noComparado?.id;
  if (!facturasNoProcesadoId || !facturasNoComparadoId) {
    throw new Error('No se pudieron preparar carpetas Facturas');
  }

  const localPath = attachmentToTempFile(attachment);

  try {
    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Subiendo' });
    const uploaded = await uploadLocalFileToDrive(sessionId, localPath, facturasNoProcesadoId);
    const uploadedId = uploaded?.file?.id || uploaded?.fileId || uploaded?.id;

    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'IA' });
    const analysisResult = await analyzeFileWithBackendIA(
      localPath,
      attachment?.mimeType || '',
      attachment?.filename || path.basename(localPath),
      'factura',
      {
        txtFolderId: facturasInformesNoComparadoId || null,
        sourceDriveFileId: uploadedId || null,
        sourceDriveFromFolderId: facturasNoProcesadoId,
        sourceDriveToFolderId: facturasNoComparadoId,
        sourceFileName: attachment?.filename || path.basename(localPath)
      }
    );

    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'Comparando' });
    const compareResult = await compareFacturaWithAlbaranes({
      facturaAnalysisText: analysisResult?.analysis || '',
      rootFolderName: 'Facturas',
      // SOLICITUD CLIENTE: forzar solo comparación por totales.
      compareMode: 'totales'
    });
    emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'comparado' });

    if (facturasDocumentosId && uploadedId) {
      const shouldMoveFactura = compareResult?.ok
        || (compareResult?.matchedAlbaranes && compareResult.matchedAlbaranes.length > 0);

      if (shouldMoveFactura) {
        await moveDriveFileWithBackoff(uploadedId, [facturasDocumentosId], [facturasNoComparadoId]);
      }
    }

    if (compareResult && !compareResult.ok) {
      emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'email' });
      const facturaRef = getFacturaReferenceForEmail(
        analysisResult?.analysis || '',
        attachment?.filename || 'XX'
      );
      const albaranesLabel = getComparedAlbaranesLabel(compareResult);
      // SOLICITUD CLIENTE: eliminar bloques no-totales del email.
      // const confidenceLines = buildModelConfidenceEmailLines(analysisResult?.analysis || '');
      // const extractionWarningsLines = buildExtractionWarningsEmailLines(analysisResult?.analysis || '');
      // const criticalAlert = buildCriticalAlertContext(compareResult, analysisResult?.analysis || '');
      const facturaTotalValue = parseComparableNumber(compareResult?.facturaTotal);
      const albaranesTotalValue = parseComparableNumber(compareResult?.sumatoriaTotalesAlbaranes);
      const facturaTotalLabel = formatAmountEuro(facturaTotalValue);
      const albaranesTotalLabel = formatAmountEuro(albaranesTotalValue);
      const facturaDriveLink = buildDriveFileLink(uploadedId);
      const emailPayload = buildComparisonEmailPayload({
        compareResult,
        fileName: attachment?.filename || 'Factura',
        facturaRef,
        albaranesLabel,
        facturaTotalLabel,
        albaranesTotalLabel,
        facturaDriveLink
      });
      await sendEmailNotification(emailPayload.subject, emailPayload.text, emailPayload.html);
      // SOLICITUD CLIENTE: no enviar email adicional por alertas IA/no-totales.
    } else if (compareResult?.ok) {
      emitToRenderer('queue-event', { type: 'step', id: queueId, step: 'email' });
      const facturaRef = getFacturaReferenceForEmail(
        analysisResult?.analysis || '',
        attachment?.filename || 'XX'
      );
      const albaranesLabel = getComparedAlbaranesLabel(compareResult);
      // const confidenceLines = buildModelConfidenceEmailLines(analysisResult?.analysis || '');
      // const extractionWarningsLines = buildExtractionWarningsEmailLines(analysisResult?.analysis || '');
      // const criticalAlert = buildCriticalAlertContext(compareResult, analysisResult?.analysis || '');
      const emailPayload = buildComparisonEmailPayload({
        compareResult,
        fileName: attachment?.filename || 'Factura',
        facturaRef,
        albaranesLabel,
        facturaTotalLabel,
        albaranesTotalLabel,
        facturaDriveLink
      });
      await sendEmailNotification(emailPayload.subject, emailPayload.text, emailPayload.html);
      // SOLICITUD CLIENTE: no enviar email adicional por baja confianza IA.
    }
  } catch (error) {
    emitToRenderer('queue-event', {
      type: 'error',
      id: queueId,
      message: error?.message || 'Error procesando factura de email'
    });
    throw error;
  } finally {
    try {
      if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch (e) {}
  }
}

async function runBillingMonitorCycle() {
  if (billingMonitorRunning) return;
  billingMonitorRunning = true;

  mainLog('info', 'runBillingMonitorCycle:start');

  try {
    const primarySessionId = store.get('sessionId');
    if (!primarySessionId) return;

    const billingSessionId = await ensureBillingSessionReady();
    if (!billingSessionId) return;

    const lastEmailStateInfo = await readLastProcessedEmailState();
    const tracking = lastEmailStateInfo?.tracking || null;
    const lastEmailState = lastEmailStateInfo?.state || null;
    let startHistoryId = lastEmailState?.historyId || null;

    // Primera ejecución (baseline): guardar el latest historyId y no procesar histórico previo.
    if (!startHistoryId) {
      const latest = await fetchLatestBillingHistoryId(billingSessionId);
      if (!latest?.historyId) {
        return;
      }

      await writeLastProcessedEmailState(tracking, {
        historyId: latest.historyId,
        messageId: latest.messageId,
        internalDate: latest.internalDate,
        subject: null,
        from: null,
        date: null
      });
      return;
    }

    let historyPayload;
    try {
      historyPayload = await listBillingHistoryAttachments(billingSessionId, startHistoryId);
    } catch (error) {
      const status = Number(error?.response?.status);
      const code = error?.response?.data?.code;
      // startHistoryId caducado: re-baseline silencioso.
      if (status === 410 || code === 'HISTORY_ID_EXPIRED') {
        const latest = await fetchLatestBillingHistoryId(billingSessionId);
        if (latest?.historyId) {
          await writeLastProcessedEmailState(tracking, {
            historyId: latest.historyId,
            messageId: latest.messageId,
            internalDate: latest.internalDate,
            subject: null,
            from: null,
            date: null
          });
        }
        return;
      }
      throw error;
    }

    const attachments = Array.isArray(historyPayload?.attachments) ? historyPayload.attachments : [];
    const newestHistoryId = historyPayload?.newestHistoryId || startHistoryId;

    // Aunque no haya adjuntos nuevos, avanzar el historyId para no repetir eventos.
    if (!attachments.length) {
      if (newestHistoryId && newestHistoryId !== startHistoryId) {
        await writeLastProcessedEmailState(tracking, {
          historyId: newestHistoryId,
          messageId: lastEmailState?.messageId || null,
          internalDate: lastEmailState?.internalDate || null,
          subject: lastEmailState?.subject || null,
          from: lastEmailState?.from || null,
          date: lastEmailState?.date || null
        });
      }
      mainLog('info', 'runBillingMonitorCycle:no-new-attachments', {
        newestHistoryId,
        startHistoryId
      });
      return;
    }

    mainLog('info', 'runBillingMonitorCycle:attachments-found', {
      totalAttachments: attachments.length,
      startHistoryId,
      newestHistoryId
    });

    const grouped = new Map();
    attachments.forEach(item => {
      const key = item.messageId || `${Date.now()}-${Math.random()}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          messageId: item.messageId || null,
          historyId: item.historyId ? String(item.historyId) : null,
          internalDate: item.internalDate ? Number(item.internalDate) : null,
          subject: item.subject || null,
          from: item.from || null,
          date: item.date || null,
          attachments: []
        });
      }
      const current = grouped.get(key);
      current.attachments.push(item);
      if (!current.historyId && item.historyId) {
        current.historyId = String(item.historyId);
      }
      if (!current.internalDate && item.internalDate) {
        current.internalDate = Number(item.internalDate);
      }
    });

    const messages = Array.from(grouped.values())
      .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
    for (const messageInfo of messages) {
      let ok = true;
      for (const attachment of messageInfo.attachments || []) {
        try {
          await processBillingAttachmentAsFactura(attachment);
        } catch (error) {
          ok = false;
          log.error('Error procesando adjunto de facturas por email:', error);
        }
      }

      if (ok && messageInfo.messageId) {
        await markBillingMessagesRead(billingSessionId, [messageInfo.messageId]);
        await writeLastProcessedEmailState(tracking, {
          ...messageInfo,
          historyId: messageInfo.historyId || newestHistoryId
        });
      }

      await sleep(BILLING_PROCESS_DELAY_MS);
    }

    // Garantía final: persistir siempre el último historyId conocido del ciclo.
    await writeLastProcessedEmailState(tracking, {
      historyId: newestHistoryId,
      messageId: lastEmailState?.messageId || null,
      internalDate: lastEmailState?.internalDate || null,
      subject: lastEmailState?.subject || null,
      from: lastEmailState?.from || null,
      date: lastEmailState?.date || null
    });
  } catch (error) {
    log.error('Error en ciclo del monitor de facturas por email:', error);
    mainLog('error', 'runBillingMonitorCycle:error', serializeError(error));
  } finally {
    billingMonitorRunning = false;
    mainLog('info', 'runBillingMonitorCycle:finish');
  }
}

function startBillingMonitor() {
  // Proceso de lectura de emails de facturas deshabilitado por solicitud.
  // No se elimina, se deja comentado.
  /*
  if (billingMonitorInterval) return;
  billingMonitorInterval = setInterval(() => {
    runBillingMonitorCycle();
  }, BILLING_POLL_INTERVAL_MS);
  runBillingMonitorCycle();
  */
}

function stopBillingMonitor() {
  if (billingMonitorInterval) {
    clearInterval(billingMonitorInterval);
    billingMonitorInterval = null;
  }
  billingMonitorRunning = false;
}
