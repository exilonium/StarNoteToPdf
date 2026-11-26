import { LineCapStyle, PDFDocument, rgb, type PDFEmbeddedPage, type PDFImage, type PDFPage } from 'pdf-lib';
import {
  applyMatrix,
  argbToRgba,
  buildVariableWidthOutline,
  getPageBounds,
  matrixScale,
  simplifyConsecutive,
  transformPoints,
} from './strokeGeometry';
import { resolveTemplateImage } from './templateLoader';
import type { ExportOptions, StarNoteDocument, StarNotePage, StarNoteShape } from './types';

const PT_PER_UNIT = 72 / 254; // 2100 units = 210mm = 595.28pt

function toPdfRgb(argb: number) {
  const c = argbToRgba(argb);
  return { color: rgb(c.r, c.g, c.b), alpha: c.a };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '0';
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function isJpg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function imageElementToPngBytes(img: HTMLImageElement, targetW: number, targetH: number): Promise<Uint8Array> {
  const maxDim = 2400;
  const scale = Math.min(1, maxDim / Math.max(targetW, targetH));
  const w = Math.max(1, Math.round(targetW * scale));
  const h = Math.max(1, Math.round(targetH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas toBlob failed'))), 'image/png')
  );
  return new Uint8Array(await blob.arrayBuffer());
}

async function rawImageBytesToPngBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([ab]));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    return await imageElementToPngBytes(img, img.naturalWidth || 1000, img.naturalHeight || 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function embedImageBytes(pdfDoc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  if (isPng(bytes)) return pdfDoc.embedPng(bytes);
  if (isJpg(bytes)) return pdfDoc.embedJpg(bytes);
  const pngBytes = await rawImageBytesToPngBytes(bytes);
  return pdfDoc.embedPng(pngBytes);
}

function isCoverPage(page: StarNotePage, idx: number): boolean {
  if (idx !== 0) return false;
  const layout = page.templateConfig?.layoutType;
  const res = page.templateConfig?.resName ?? '';
  return layout === 'LayoutImage' || res.startsWith('cover_');
}

export async function exportDocumentToPdf(
  doc: StarNoteDocument,
  options: ExportOptions,
  onProgress?: (pageIdx: number, total: number) => void
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(doc.title);
  pdfDoc.setCreator('StarNote Backup to PDF');

  let srcPdf: PDFDocument | null = null;
  if (doc.pdfBytes) {
    try {
      srcPdf = await PDFDocument.load(doc.pdfBytes, { ignoreEncryption: true });
    } catch (e) {
      console.warn('Could not load embedded PDF directly:', e);
    }
  }

  const embeddedPdfCache = new Map<number, PDFEmbeddedPage>();
  const embeddedImgCache = new Map<string, PDFImage>();

  const pagesToExport = doc.pages.filter(
    (p, idx) => options.includeCover || !isCoverPage(p, idx)
  );

  if (pagesToExport.length === 0) {
    // Emit a single blank page if document has no exportable pages
    pdfDoc.addPage([595.28, 841.89]);
    return pdfDoc.save();
  }

  for (let i = 0; i < pagesToExport.length; i++) {
    onProgress?.(i + 1, pagesToExport.length);
    const page = pagesToExport[i];
    const bounds = getPageBounds(page, options.includeMargins);
    const pageW = Math.max(1, bounds.right - bounds.left);
    const pageH = Math.max(1, bounds.bottom - bounds.top);

    const cr = page.contentRect;
    const cw = Math.max(1, cr.right - cr.left);
    const ch = Math.max(1, cr.bottom - cr.top);

    // Determine PDF page scale: match underlying imported PDF size if available
    let embeddedSrcPage: PDFEmbeddedPage | undefined;
    let ptScale = PT_PER_UNIT;

    if (page.pageType === 'import_pdf' && srcPdf && page.pdfPageIndex !== undefined) {
      if (page.pdfPageIndex >= 0 && page.pdfPageIndex < srcPdf.getPageCount()) {
        embeddedSrcPage = embeddedPdfCache.get(page.pdfPageIndex);
        if (!embeddedSrcPage) {
          const srcPage = srcPdf.getPage(page.pdfPageIndex);
          embeddedSrcPage = await pdfDoc.embedPage(srcPage);
          embeddedPdfCache.set(page.pdfPageIndex, embeddedSrcPage);
        }
        ptScale = embeddedSrcPage.width / cw;
      }
    }

    const pdfW = pageW * ptScale;
    const pdfH = pageH * ptScale;
    const pdfPage = pdfDoc.addPage([pdfW, pdfH]);

    // 1. Background fill
    const bgArgb = page.marginBgColorArgb ?? page.templateConfig?.fillColor ?? 0xffffffff;
    const bg = toPdfRgb(bgArgb);
    if (bg.alpha > 0) {
      pdfPage.drawRectangle({
        x: 0,
        y: 0,
        width: pdfW,
        height: pdfH,
        color: bg.color,
        opacity: bg.alpha,
      });
    }

    const contentX = (cr.left - bounds.left) * ptScale;
    const contentYBottom = pdfH - (cr.bottom - bounds.top) * ptScale;
    const contentW = cw * ptScale;
    const contentH = ch * ptScale;

    if (page.templateConfig?.fillEnableColor && page.templateConfig.fillColor) {
      const tc = toPdfRgb(page.templateConfig.fillColor);
      if (tc.alpha > 0) {
        pdfPage.drawRectangle({
          x: contentX,
          y: contentYBottom,
          width: contentW,
          height: contentH,
          color: tc.color,
          opacity: tc.alpha,
        });
      }
    }

    // 2. Embedded PDF page OR Template/Cover rasterized at crisp resolution
    if (embeddedSrcPage) {
      pdfPage.drawPage(embeddedSrcPage, {
        x: contentX,
        y: contentYBottom,
        width: contentW,
        height: contentH,
      });
    } else {
      const tplKey =
        page.templateConfig?.imageRelativePath ?? page.templateConfig?.resName ?? '';
      let tplPdfImg = tplKey ? embeddedImgCache.get(`tpl:${tplKey}`) : undefined;
      if (!tplPdfImg && tplKey) {
        const imgEl = await resolveTemplateImage(doc, page);
        if (imgEl) {
          const pngBytes = await imageElementToPngBytes(imgEl, cw, ch);
          tplPdfImg = await pdfDoc.embedPng(pngBytes);
          embeddedImgCache.set(`tpl:${tplKey}`, tplPdfImg);
        }
      }
      if (tplPdfImg) {
        pdfPage.drawImage(tplPdfImg, {
          x: contentX,
          y: contentYBottom,
          width: contentW,
          height: contentH,
        });
      }
    }

    // 3. Draw vector shapes & embedded images
    for (const shape of page.shapes) {
      if ((shape.shapeType === 41 || shape.shapeType === 44) && !options.includeExcerpts) {
        continue;
      }
      await drawShapeOnPdf(
        pdfDoc,
        pdfPage,
        doc,
        shape,
        bounds.left,
        bounds.top,
        pdfH,
        ptScale,
        embeddedImgCache
      );
    }
  }

  return pdfDoc.save();
}

async function drawShapeOnPdf(
  pdfDoc: PDFDocument,
  pdfPage: PDFPage,
  doc: StarNoteDocument,
  shape: StarNoteShape,
  originX: number,
  originY: number,
  pdfH: number,
  ptScale: number,
  imgCache: Map<string, PDFImage>
): Promise<void> {
  // Type 19: Image
  if (shape.shapeType === 19) {
    if (!shape.resourceUniqueId || shape.points.length < 2) return;
    let pdfImg = imgCache.get(`res:${shape.resourceUniqueId}`);
    if (!pdfImg) {
      const bytes = doc.resourceImages.get(shape.resourceUniqueId);
      if (!bytes) return;
      pdfImg = await embedImageBytes(pdfDoc, bytes);
      imgCache.set(`res:${shape.resourceUniqueId}`, pdfImg);
    }
    const p0 = applyMatrix(shape.matrix, shape.points[0].x, shape.points[0].y);
    const p1 = applyMatrix(shape.matrix, shape.points[1].x, shape.points[1].y);
    const left = Math.min(p0[0], p1[0]);
    const top = Math.min(p0[1], p1[1]);
    const w = Math.abs(p1[0] - p0[0]);
    const h = Math.abs(p1[1] - p0[1]);
    if (w > 0 && h > 0) {
      pdfPage.drawImage(pdfImg, {
        x: (left - originX) * ptScale,
        y: pdfH - (top + h - originY) * ptScale,
        width: w * ptScale,
        height: h * ptScale,
      });
    }
    return;
  }

  // Type 406657105: Table
  if (shape.shapeType === 406657105 && shape.tableInfo && shape.points.length >= 2) {
    drawTableOnPdf(pdfPage, shape, originX, originY, pdfH, ptScale);
    return;
  }

  // Type 41 / 44: Excerpt highlight
  if (shape.shapeType === 41 || shape.shapeType === 44) {
    drawExcerptOnPdf(pdfPage, shape, originX, originY, pdfH, ptScale);
    return;
  }

  // Type 2 / 47 / 15: Strokes and Highlighters
  if (shape.points.length === 0) return;
  const { color, alpha } = toPdfRgb(shape.colorArgb);
  const mScale = matrixScale(shape.matrix);
  const pts = transformPoints(shape.points, shape.matrix);
  const isDashed = shape.lineStyle && shape.lineStyle.type !== 0;
  const isHighlighter = shape.shapeType === 15 || shape.underContent;
  const hasPressure =
    !isHighlighter &&
    !isDashed &&
    shape.brush &&
    (shape.brush.brushShape ?? 1) > 0 &&
    (shape.brush.pressureSensitivity ?? 0) > 0;

  if (hasPressure) {
    const outline = buildVariableWidthOutline(pts, shape, mScale);
    if (outline.length < 3) return;
    let d = `M ${fmt(outline[0][0] - originX)} ${fmt(outline[0][1] - originY)}`;
    for (let i = 1; i < outline.length; i++) {
      d += ` L ${fmt(outline[i][0] - originX)} ${fmt(outline[i][1] - originY)}`;
    }
    d += ' Z';
    pdfPage.drawSvgPath(d, {
      x: 0,
      y: pdfH,
      scale: ptScale,
      color,
      opacity: alpha,
    });
  } else {
    const simple = simplifyConsecutive(pts, 0.4);
    const widthUnits = Math.max(0.75, shape.thickness * mScale);
    const widthPts = widthUnits * ptScale;
    let d = `M ${fmt(simple[0].x - originX)} ${fmt(simple[0].y - originY)}`;
    if (simple.length === 1) {
      d += ` L ${fmt(simple[0].x - originX + 0.05)} ${fmt(simple[0].y - originY + 0.05)}`;
    } else {
      for (let i = 1; i < simple.length - 1; i++) {
        const cx = simple[i].x - originX;
        const cy = simple[i].y - originY;
        const mx = (simple[i].x + simple[i + 1].x) / 2 - originX;
        const my = (simple[i].y + simple[i + 1].y) / 2 - originY;
        d += ` Q ${fmt(cx)} ${fmt(cy)} ${fmt(mx)} ${fmt(my)}`;
      }
      const last = simple[simple.length - 1];
      d += ` L ${fmt(last.x - originX)} ${fmt(last.y - originY)}`;
    }

    let dashArray: number[] | undefined;
    if (shape.lineStyle?.type === 1) {
      dashArray = [widthPts * 3, widthPts * 2.5];
    } else if (shape.lineStyle?.type === 2) {
      dashArray = [0.05, widthPts * 2.2];
    }

    pdfPage.drawSvgPath(d, {
      x: 0,
      y: pdfH,
      scale: ptScale,
      borderColor: color,
      borderWidth: widthPts,
      borderOpacity: alpha,
      borderLineCap: LineCapStyle.Round,
      borderDashArray: dashArray,
    });
  }
}

function drawTableOnPdf(
  pdfPage: PDFPage,
  shape: StarNoteShape,
  originX: number,
  originY: number,
  pdfH: number,
  ptScale: number
): void {
  const ti = shape.tableInfo!;
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  const localLeft = Math.min(...xs);
  const localTop = Math.min(...ys);
  const localW = Math.max(...xs) - localLeft;
  const localH = Math.max(...ys) - localTop;

  const sumCol = ti.colWidths.reduce((a, b) => a + b, 0) || 1;
  const sumRow = ti.rowHeights.reduce((a, b) => a + b, 0) || 1;
  const sx = localW / sumCol;
  const sy = localH / sumRow;

  const colOffsets: number[] = [localLeft];
  for (const w of ti.colWidths) colOffsets.push(colOffsets[colOffsets.length - 1] + w * sx);
  const rowOffsets: number[] = [localTop];
  for (const h of ti.rowHeights) rowOffsets.push(rowOffsets[rowOffsets.length - 1] + h * sy);

  const mScale = matrixScale(shape.matrix);
  const { color: strokeColor, alpha: strokeAlpha } = toPdfRgb(
    ti.tableAttr.strokeColor || shape.colorArgb
  );
  const strokeWidthPts = Math.max(0.75, (ti.tableAttr.strokeWidth || shape.thickness) * mScale) * ptScale;

  for (let r = 0; r < ti.cells.length; r++) {
    for (let c = 0; c < ti.cells[r].length; c++) {
      const cell = ti.cells[r][c];
      if (cell.isMerged) continue;
      const x0 = colOffsets[cell.startCol];
      const y0 = rowOffsets[cell.startRow];
      const x1 = colOffsets[Math.min(colOffsets.length - 1, cell.startCol + cell.colSpan)];
      const y1 = rowOffsets[Math.min(rowOffsets.length - 1, cell.startRow + cell.rowSpan)];

      const p00 = applyMatrix(shape.matrix, x0, y0);
      const p10 = applyMatrix(shape.matrix, x1, y0);
      const p11 = applyMatrix(shape.matrix, x1, y1);
      const p01 = applyMatrix(shape.matrix, x0, y1);

      const d =
        `M ${fmt(p00[0] - originX)} ${fmt(p00[1] - originY)} ` +
        `L ${fmt(p10[0] - originX)} ${fmt(p10[1] - originY)} ` +
        `L ${fmt(p11[0] - originX)} ${fmt(p11[1] - originY)} ` +
        `L ${fmt(p01[0] - originX)} ${fmt(p01[1] - originY)} Z`;

      const cellFill = cell.fillColorEnable && cell.fillColor !== 0 ? toPdfRgb(cell.fillColor) : null;
      pdfPage.drawSvgPath(d, {
        x: 0,
        y: pdfH,
        scale: ptScale,
        color: cellFill?.color,
        opacity: cellFill?.alpha,
        borderColor: strokeColor,
        borderWidth: strokeWidthPts,
        borderOpacity: strokeAlpha,
      });
    }
  }
}

function drawExcerptOnPdf(
  pdfPage: PDFPage,
  shape: StarNoteShape,
  originX: number,
  originY: number,
  pdfH: number,
  ptScale: number
): void {
  const { color } = toPdfRgb(shape.colorArgb);
  const rects =
    shape.excerptInfo?.rectList && shape.excerptInfo.rectList.length > 0
      ? shape.excerptInfo.rectList
      : shape.points.length >= 2
      ? [
          {
            left: Math.min(shape.points[0].x, shape.points[1].x),
            top: Math.min(shape.points[0].y, shape.points[1].y),
            right: Math.max(shape.points[0].x, shape.points[1].x),
            bottom: Math.max(shape.points[0].y, shape.points[1].y),
          },
        ]
      : [];

  for (const r of rects) {
    const p0 = applyMatrix(shape.matrix, r.left, r.top);
    const p1 = applyMatrix(shape.matrix, r.right, r.bottom);
    const left = Math.min(p0[0], p1[0]);
    const top = Math.min(p0[1], p1[1]);
    const w = Math.abs(p1[0] - p0[0]);
    const h = Math.abs(p1[1] - p0[1]);
    if (w <= 0 || h <= 0) continue;
    pdfPage.drawRectangle({
      x: (left - originX) * ptScale,
      y: pdfH - (top + h - originY) * ptScale,
      width: w * ptScale,
      height: h * ptScale,
      color,
      opacity: 0.16,
      borderColor: shape.shapeType === 41 ? color : undefined,
      borderWidth: shape.shapeType === 41 ? 1.5 * ptScale : 0,
      borderOpacity: shape.shapeType === 41 ? 0.7 : 0,
    });
  }
}
