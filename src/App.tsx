import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  Archive,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import {
  filesFromFileList,
  filesFromZip,
  parseStarNoteBackup,
  type VirtualFile,
} from './starnote/backupParser';
import { renderPageToCanvas } from './starnote/canvasRenderer';
import { exportDocumentToPdf, isCoverPage } from './starnote/pdfExporter';
import { getPageBounds } from './starnote/strokeGeometry';
import type { ExportOptions, StarNoteDocument, StarNotePage } from './starnote/types';

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}

async function readDataTransferItems(items: DataTransferItemList): Promise<VirtualFile[]> {
  const files: VirtualFile[] = [];

  async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      if (prefix === '' && file.name.toLowerCase().endsWith('.zip')) {
        const zipped = await filesFromZip(file);
        files.push(...zipped);
      } else {
        const path = `${prefix}${file.name}`;
        files.push({
          path,
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        });
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const allEntries: FileSystemEntry[] = [];
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject)
        );
        if (batch.length === 0) break;
        allEntries.push(...batch);
      }
      for (const child of allEntries) {
        await walkEntry(child, `${prefix}${entry.name}/`);
      }
    }
  }

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    await walkEntry(entry, '');
  }
  return files;
}

function downloadBlob(bytes: Uint8Array, filename: string, mime = 'application/pdf') {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'starnote_document';
}

function formatDate(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

export default function App() {
  const [docs, setDocs] = useState<StarNoteDocument[]>([]);
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showEmpty, setShowEmpty] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<string | null>(null);
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [previewPageIdx, setPreviewPageIdx] = useState(0);

  const [options, setOptions] = useState<ExportOptions>({
    includeCover: true,
    includeMargins: true,
    includeExcerpts: true,
    continuousScroll: true,
  });

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const loadVirtualFiles = useCallback(async (vfiles: VirtualFile[]) => {
    setErrorMsg(null);
    setLoadingMsg('Scanning backup files...');
    try {
      const parsed = await parseStarNoteBackup(vfiles, (m) => setLoadingMsg(m));
      if (parsed.length === 0) {
        setErrorMsg(
          'No StarNote notebooks found. Please select your StarNote backup folder (containing sync/v1/.../document) or a ZIP of it.'
        );
      }
      setDocs(parsed);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to parse backup');
    } finally {
      setLoadingMsg(null);
    }
  }, []);

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const vfiles = await filesFromFileList(e.target.files);
    await loadVirtualFiles(vfiles);
    e.target.value = '';
  };

  const handleZipSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoadingMsg(`Reading ${file.name}...`);
    const vfiles = await filesFromZip(file);
    await loadVirtualFiles(vfiles);
    e.target.value = '';
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setLoadingMsg('Reading dropped files...');
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const vfiles = await readDataTransferItems(e.dataTransfer.items);
      await loadVirtualFiles(vfiles);
    } else if (e.dataTransfer.files.length > 0) {
      const vfiles = await filesFromFileList(e.dataTransfer.files);
      await loadVirtualFiles(vfiles);
    }
  };

  const visibleDocs = useMemo(
    () => (showEmpty ? docs : docs.filter((d) => d.pages.length > 0)),
    [docs, showEmpty]
  );

  const emptyCount = useMemo(
    () => docs.filter((d) => d.pages.length === 0).length,
    [docs]
  );

  const previewDoc = useMemo(
    () => docs.find((d) => d.id === previewDocId) ?? null,
    [docs, previewDocId]
  );

  const previewPages = useMemo(() => {
    if (!previewDoc) return [];
    return previewDoc.pages.filter((p, idx) => options.includeCover || !isCoverPage(p, idx));
  }, [previewDoc, options.includeCover]);

  const previewMaxPageWidth = useMemo(() => {
    if (previewPages.length === 0) return 1;
    return Math.max(
      1,
      ...previewPages.map((p) => {
        const b = getPageBounds(p, options.includeMargins);
        return Math.max(1, b.right - b.left);
      })
    );
  }, [previewPages, options.includeMargins]);

  useEffect(() => {
    if (previewPageIdx >= previewPages.length && previewPages.length > 0) {
      setPreviewPageIdx(previewPages.length - 1);
    }
  }, [previewPages.length, previewPageIdx]);

  useEffect(() => {
    if (options.continuousScroll || !previewDoc || !previewCanvasRef.current) return;
    const page = previewPages[previewPageIdx];
    if (!page) return;
    renderPageToCanvas(previewCanvasRef.current, previewDoc, page, options, 920).catch((err) =>
      console.error('Preview render failed:', err)
    );
  }, [options, previewDoc, previewPages, previewPageIdx]);

  const handleExportOne = async (doc: StarNoteDocument) => {
    setExportingId(doc.id);
    setErrorMsg(null);
    try {
      const pdfBytes = await exportDocumentToPdf(doc, options);
      downloadBlob(pdfBytes, `${sanitizeFilename(doc.title)}.pdf`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'PDF export failed');
    } finally {
      setExportingId(null);
    }
  };

  const handleExportAllZip = async () => {
    const exportable = docs.filter((d) => d.pages.length > 0);
    if (exportable.length === 0) return;
    setErrorMsg(null);
    const zip = new JSZip();
    const usedNames = new Map<string, number>();

    try {
      for (let i = 0; i < exportable.length; i++) {
        const doc = exportable[i];
        setBatchProgress(`Exporting ${i + 1}/${exportable.length}: ${doc.title}`);
        const pdfBytes = await exportDocumentToPdf(doc, options);
        let base = sanitizeFilename(doc.title);
        const count = usedNames.get(base) ?? 0;
        usedNames.set(base, count + 1);
        if (count > 0) base = `${base} (${count + 1})`;
        zip.file(`${base}.pdf`, pdfBytes);
      }
      setBatchProgress('Compressing ZIP...');
      const zipBytes = await zip.generateAsync({ type: 'uint8array' });
      downloadBlob(zipBytes, 'StarNote-PDFs.zip', 'application/zip');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Batch export failed');
    } finally {
      setBatchProgress(null);
    }
  };

  const renameDoc = (id: string, title: string) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, title } : d)));
  };

  return (
    <div
      className="app-shell"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <BookOpen size={20} />
          </div>
          <div>
            <h1>StarNote Backup → PDF</h1>
            <p>100% local in-browser converter · vector ink, tables, images &amp; annotated PDFs</p>
          </div>
        </div>

        <div className="actions-row">
          <input
            ref={folderInputRef}
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            hidden
            onChange={handleFolderSelect}
          />
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={handleZipSelect}
          />
          <button className="btn" onClick={() => folderInputRef.current?.click()}>
            <FolderOpen size={16} />
            Open Backup Folder
          </button>
          <button className="btn" onClick={() => zipInputRef.current?.click()}>
            <Archive size={16} />
            Open Backup ZIP
          </button>
          {visibleDocs.length > 0 && (
            <button
              className="btn btn-primary"
              disabled={!!batchProgress}
              onClick={handleExportAllZip}
            >
              {batchProgress ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
              Export All ({docs.filter((d) => d.pages.length > 0).length})
            </button>
          )}
        </div>
      </header>

      <main className="main-content">
        {loadingMsg && (
          <div className="status-banner">
            <Loader2 size={18} className="spin" />
            <span>{loadingMsg}</span>
          </div>
        )}

        {batchProgress && (
          <div className="status-banner">
            <Loader2 size={18} className="spin" />
            <span>{batchProgress}</span>
          </div>
        )}

        {errorMsg && (
          <div className="status-banner" style={{ borderColor: '#f04438', color: '#b42318' }}>
            <span>{errorMsg}</span>
          </div>
        )}

        {docs.length === 0 && !loadingMsg ? (
          <div className={`dropzone ${isDragging ? 'dragging' : ''}`}>
            <div className="dropzone-icon">
              <Upload size={28} />
            </div>
            <h2>Drop your StarNote Google Drive backup here</h2>
            <p>
              Select the extracted <code>StarNote</code> folder (containing{' '}
              <code>sync/v1/.../document</code>) or a <code>.zip</code> archive of it. Everything
              is processed locally in your browser.
            </p>
            <div className="dropzone-buttons">
              <button className="btn btn-primary" onClick={() => folderInputRef.current?.click()}>
                <FolderOpen size={16} />
                Select StarNote Folder
              </button>
              <button className="btn" onClick={() => zipInputRef.current?.click()}>
                <Archive size={16} />
                Select Backup ZIP
              </button>
            </div>
          </div>
        ) : null}

        {docs.length > 0 && (
          <>
            <div className="toolbar">
              <div className="options-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={options.includeCover}
                    onChange={(e) => setOptions((o) => ({ ...o, includeCover: e.target.checked }))}
                  />
                  Include Cover Page
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={options.includeMargins}
                    onChange={(e) => setOptions((o) => ({ ...o, includeMargins: e.target.checked }))}
                  />
                  Include Expanded Margins
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={options.includeExcerpts}
                    onChange={(e) =>
                      setOptions((o) => ({ ...o, includeExcerpts: e.target.checked }))
                    }
                  />
                  Include PDF Excerpt Highlights
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={options.continuousScroll}
                    onChange={(e) =>
                      setOptions((o) => ({ ...o, continuousScroll: e.target.checked }))
                    }
                  />
                  Continuous Scroll PDF
                </label>
                {emptyCount > 0 && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={showEmpty}
                      onChange={(e) => setShowEmpty(e.target.checked)}
                    />
                    Show empty/deleted ({emptyCount})
                  </label>
                )}
              </div>

              <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)' }}>
                Showing {visibleDocs.length} of {docs.length} notebooks
              </div>
            </div>

            <div className="docs-grid">
              {visibleDocs.map((doc) => (
                <DocCard
                  key={doc.id}
                  doc={doc}
                  options={options}
                  exporting={exportingId === doc.id}
                  onRename={(t) => renameDoc(doc.id, t)}
                  onPreview={() => {
                    setPreviewDocId(doc.id);
                    setPreviewPageIdx(0);
                  }}
                  onExport={() => handleExportOne(doc)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {previewDoc && (
        <div className="modal-backdrop" onClick={() => setPreviewDocId(null)}>
          <div className="modal-header" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title-group">
              <strong>{previewDoc.title}</strong>
              <span className="modal-meta">
                {previewPages.length} pages · {previewDoc.totalActiveShapes} elements
              </span>
            </div>

            {!options.continuousScroll && (
              <div className="pager">
                <button
                  className="btn"
                  style={{ padding: '4px 8px' }}
                  disabled={previewPageIdx <= 0}
                  onClick={() => setPreviewPageIdx((i) => Math.max(0, i - 1))}
                >
                  <ChevronLeft size={16} />
                </button>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  Page {previewPages.length ? previewPageIdx + 1 : 0} / {previewPages.length}
                </span>
                <button
                  className="btn"
                  style={{ padding: '4px 8px' }}
                  disabled={previewPageIdx >= previewPages.length - 1}
                  onClick={() =>
                    setPreviewPageIdx((i) => Math.min(previewPages.length - 1, i + 1))
                  }
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}

            <div className="actions-row modal-actions">
              <button
                className="btn btn-primary"
                disabled={exportingId === previewDoc.id}
                onClick={() => handleExportOne(previewDoc)}
              >
                {exportingId === previewDoc.id ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Download size={16} />
                )}
                Download PDF
              </button>
              <button className="btn" onClick={() => setPreviewDocId(null)}>
                <X size={16} />
                Close
              </button>
            </div>
          </div>

          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            {previewPages.length > 0 ? (
              options.continuousScroll ? (
                <div className="preview-scroll-stack">
                  {previewPages.map((page, idx) => (
                    <PreviewPageCanvas
                      key={`${previewDoc.id}-${page.id || idx}`}
                      doc={previewDoc}
                      page={page}
                      pageNumber={idx + 1}
                      maxPageWidth={previewMaxPageWidth}
                      options={options}
                    />
                  ))}
                </div>
              ) : (
                <div className="preview-canvas-wrap">
                  <canvas ref={previewCanvasRef} />
                </div>
              )
            ) : (
              <div style={{ color: '#fff', marginTop: 40, textAlign: 'center' }}>
                {previewDoc.pages.length > 0
                  ? 'All pages are excluded by the current export options (e.g. cover page hidden).'
                  : 'This notebook folder has no synced pages (it may have been deleted or only contains a cached thumbnail).'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewPageCanvas({
  doc,
  page,
  pageNumber,
  maxPageWidth,
  options,
}: {
  doc: StarNoteDocument;
  page: StarNotePage;
  pageNumber: number;
  maxPageWidth: number;
  options: ExportOptions;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(pageNumber <= 3);

  const bounds = getPageBounds(page, options.includeMargins);
  const pageW = Math.max(1, bounds.right - bounds.left);
  const pageH = Math.max(1, bounds.bottom - bounds.top);
  const widthPct = Math.min(100, Math.max(20, (pageW / maxPageWidth) * 100));

  useEffect(() => {
    if (visible) return;
    const el = wrapRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '800px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    const targetWidth = Math.max(480, Math.round(920 * (pageW / maxPageWidth)));
    renderPageToCanvas(canvasRef.current, doc, page, options, targetWidth).catch((err) =>
      console.error('Continuous preview render failed:', err)
    );
  }, [visible, doc, page, options, pageW, maxPageWidth]);

  return (
    <div
      ref={wrapRef}
      className="preview-canvas-wrap preview-page-slot"
      style={{
        width: `${widthPct}%`,
        aspectRatio: `${pageW} / ${pageH}`,
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}

function DocCard({
  doc,
  options,
  exporting,
  onRename,
  onPreview,
  onExport,
}: {
  doc: StarNoteDocument;
  options: ExportOptions;
  exporting: boolean;
  onRename: (title: string) => void;
  onPreview: () => void;
  onExport: () => void;
}) {
  const thumbCanvasRef = useRef<HTMLCanvasElement>(null);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (doc.thumbnailBytes) {
      const ab = doc.thumbnailBytes.buffer.slice(
        doc.thumbnailBytes.byteOffset,
        doc.thumbnailBytes.byteOffset + doc.thumbnailBytes.byteLength
      ) as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([ab], { type: 'image/png' }));
      setThumbUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setThumbUrl(null);
    return undefined;
  }, [doc.thumbnailBytes]);

  useEffect(() => {
    if (thumbUrl || !thumbCanvasRef.current || doc.pages.length === 0) return;
    renderPageToCanvas(thumbCanvasRef.current, doc, doc.pages[0], options, 360).catch(() => {});
  }, [thumbUrl, doc, options]);

  return (
    <div className="doc-card">
      <div className="doc-thumb" onClick={onPreview} title="Click to preview pages">
        {thumbUrl ? (
          <img src={thumbUrl} alt={doc.title} />
        ) : doc.pages.length > 0 ? (
          <canvas ref={thumbCanvasRef} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <FileText size={40} color="#9aa1b8" />
        )}
        <span className="doc-badge">
          {doc.pdfFilename ? 'PDF + Notes' : `${doc.pages.length} pages`}
        </span>
      </div>

      <div className="doc-body">
        <input
          className="doc-title-input"
          value={doc.title}
          onChange={(e) => onRename(e.target.value)}
          title="Click to rename exported PDF filename"
        />

        <div className="doc-meta">
          <span>{doc.pages.length} pages</span>
          <span>·</span>
          <span>{doc.totalActiveShapes} elements</span>
          {doc.updatedAt > 0 && (
            <>
              <span>·</span>
              <span>{formatDate(doc.updatedAt)}</span>
            </>
          )}
        </div>

        <div className="doc-actions">
          <button className="btn" onClick={onPreview} disabled={doc.pages.length === 0}>
            <Eye size={14} />
            Preview
          </button>
          <button
            className="btn btn-primary"
            onClick={onExport}
            disabled={exporting || doc.pages.length === 0}
          >
            {exporting ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            PDF
          </button>
        </div>
      </div>
    </div>
  );
}
