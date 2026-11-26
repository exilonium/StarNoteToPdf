import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  applyMatrix,
  argbToRgba,
  buildVariableWidthOutline,
  getPageBounds,
  matrixScale,
  rgbaToCss,
  simplifyConsecutive,
  transformPoints,
} from './strokeGeometry';
import { resolveShapeImage, resolveTemplateImage } from './templateLoader';
import type {
  ExportOptions,
  StarNoteDocument,
  StarNotePage,
  StarNoteShape,
} from './types';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

const loadedPdfCache = new WeakMap<Uint8Array, Promise<pdfjsLib.PDFDocumentProxy>>();

function getPdfDocument(bytes: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  let promise = loadedPdfCache.get(bytes);
  if (!promise) {
    const copy = new Uint8Array(bytes);
    promise = pdfjsLib.getDocument({ data: copy }).promise;
    loadedPdfCache.set(bytes, promise);
  }
  return promise;
}

export async function renderPageToCanvas(
  canvas: HTMLCanvasElement,
  doc: StarNoteDocument,
  page: StarNotePage,
  options: ExportOptions,
  targetWidthPx = 900
): Promise<void> {
  const bounds = getPageBounds(page, options.includeMargins);
  const pageW = Math.max(1, bounds.right - bounds.left);
  const pageH = Math.max(1, bounds.bottom - bounds.top);
  const scale = targetWidthPx / pageW;

  canvas.width = Math.round(pageW * scale);
  canvas.height = Math.round(pageH * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-bounds.left, -bounds.top);

  // 1. Margin / page background fill
  const bgArgb = page.marginBgColorArgb ?? page.templateConfig?.fillColor ?? 0xffffffff;
  const bgRgba = argbToRgba(bgArgb);
  if (bgRgba.a > 0) {
    ctx.fillStyle = rgbaToCss(bgRgba);
  } else {
    ctx.fillStyle = '#ffffff';
  }
  ctx.fillRect(bounds.left, bounds.top, pageW, pageH);

  // Fill contentRect separately if template has explicit fillColor different from margin
  const cr = page.contentRect;
  const cw = cr.right - cr.left;
  const ch = cr.bottom - cr.top;
  if (page.templateConfig?.fillEnableColor && page.templateConfig.fillColor) {
    const tc = argbToRgba(page.templateConfig.fillColor);
    if (tc.a > 0) {
      ctx.fillStyle = rgbaToCss(tc);
      ctx.fillRect(cr.left, cr.top, cw, ch);
    }
  }

  // 2. Imported PDF background or Template/Cover image
  if (page.pageType === 'import_pdf' && doc.pdfBytes && page.pdfPageIndex !== undefined) {
    try {
      const pdfDoc = await getPdfDocument(doc.pdfBytes);
      const pdfPageNum = page.pdfPageIndex + 1;
      if (pdfPageNum >= 1 && pdfPageNum <= pdfDoc.numPages) {
        const pdfPage = await pdfDoc.getPage(pdfPageNum);
        const vp1 = pdfPage.getViewport({ scale: 1 });
        const pdfScale = (cw * scale) / vp1.width;
        const vp = pdfPage.getViewport({ scale: pdfScale });
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.round(vp.width);
        offscreen.height = Math.round(vp.height);
        const octx = offscreen.getContext('2d');
        if (octx) {
          await pdfPage.render({ canvasContext: octx, viewport: vp }).promise;
          ctx.drawImage(offscreen, cr.left, cr.top, cw, ch);
        }
      }
    } catch (err) {
      console.warn('PDF page render fallback:', err);
    }
  } else {
    const tplImg = await resolveTemplateImage(doc, page);
    if (tplImg) {
      ctx.drawImage(tplImg, cr.left, cr.top, cw, ch);
    }
  }

  // 3. Draw shapes in layered order (underContent first, then ink/tables/images)
  for (const shape of page.shapes) {
    if ((shape.shapeType === 41 || shape.shapeType === 44) && !options.includeExcerpts) {
      continue;
    }
    await drawShapeOnCanvas(ctx, doc, shape);
  }

  ctx.restore();
}

async function drawShapeOnCanvas(
  ctx: CanvasRenderingContext2D,
  doc: StarNoteDocument,
  shape: StarNoteShape
): Promise<void> {
  // Type 19: Embedded image
  if (shape.shapeType === 19) {
    const img = await resolveShapeImage(doc, shape.resourceUniqueId);
    if (!img || shape.points.length < 2) return;
    const p0 = applyMatrix(shape.matrix, shape.points[0].x, shape.points[0].y);
    const p1 = applyMatrix(shape.matrix, shape.points[1].x, shape.points[1].y);
    const x = Math.min(p0[0], p1[0]);
    const y = Math.min(p0[1], p1[1]);
    const w = Math.abs(p1[0] - p0[0]);
    const h = Math.abs(p1[1] - p0[1]);
    if (w > 0 && h > 0) {
      ctx.drawImage(img, x, y, w, h);
    }
    return;
  }

  // Type 406657105: Table
  if (shape.shapeType === 406657105 && shape.tableInfo && shape.points.length >= 2) {
    drawTableOnCanvas(ctx, shape);
    return;
  }

  // Type 41 / 44: Excerpt highlight
  if (shape.shapeType === 41 || shape.shapeType === 44) {
    drawExcerptOnCanvas(ctx, shape);
    return;
  }

  // Type 2 / 47 / 15: Strokes and Highlighters
  if (shape.points.length === 0) return;
  const rgba = argbToRgba(shape.colorArgb);
  const scaleFactor = matrixScale(shape.matrix);
  const pts = transformPoints(shape.points, shape.matrix);
  const isDashed = shape.lineStyle && shape.lineStyle.type !== 0;
  const isHighlighter = shape.shapeType === 15 || shape.underContent;
  const hasPressure =
    !isHighlighter &&
    !isDashed &&
    shape.brush &&
    (shape.brush.brushShape ?? 1) > 0 &&
    (shape.brush.pressureSensitivity ?? 0) > 0;

  ctx.save();
  ctx.fillStyle = rgbaToCss(rgba);
  ctx.strokeStyle = rgbaToCss(rgba);

  if (hasPressure) {
    const outline = buildVariableWidthOutline(pts, shape, scaleFactor);
    if (outline.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) {
        ctx.lineTo(outline[i][0], outline[i][1]);
      }
      ctx.closePath();
      ctx.fill();
    }
  } else {
    const simple = simplifyConsecutive(pts, 0.4);
    const width = Math.max(0.75, shape.thickness * scaleFactor);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (shape.lineStyle?.type === 1) {
      ctx.setLineDash([width * 3, width * 2.5]);
    } else if (shape.lineStyle?.type === 2) {
      ctx.setLineDash([0.01, width * 2.2]);
    }
    ctx.beginPath();
    ctx.moveTo(simple[0].x, simple[0].y);
    if (simple.length === 1) {
      ctx.lineTo(simple[0].x + 0.01, simple[0].y + 0.01);
    } else {
      for (let i = 1; i < simple.length - 1; i++) {
        const mx = (simple[i].x + simple[i + 1].x) / 2;
        const my = (simple[i].y + simple[i + 1].y) / 2;
        ctx.quadraticCurveTo(simple[i].x, simple[i].y, mx, my);
      }
      const last = simple[simple.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawTableOnCanvas(ctx: CanvasRenderingContext2D, shape: StarNoteShape): void {
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
  for (const w of ti.colWidths) {
    colOffsets.push(colOffsets[colOffsets.length - 1] + w * sx);
  }
  const rowOffsets: number[] = [localTop];
  for (const h of ti.rowHeights) {
    rowOffsets.push(rowOffsets[rowOffsets.length - 1] + h * sy);
  }

  const mScale = matrixScale(shape.matrix);
  const strokeRgba = argbToRgba(ti.tableAttr.strokeColor || shape.colorArgb);
  const lineWidth = Math.max(0.75, (ti.tableAttr.strokeWidth || shape.thickness) * mScale);

  ctx.save();
  ctx.strokeStyle = rgbaToCss(strokeRgba);
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'miter';

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

      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]);
      ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]);
      ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();

      if (cell.fillColorEnable && cell.fillColor !== 0) {
        ctx.fillStyle = rgbaToCss(argbToRgba(cell.fillColor));
        ctx.fill();
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawExcerptOnCanvas(ctx: CanvasRenderingContext2D, shape: StarNoteShape): void {
  const rgba = argbToRgba(shape.colorArgb);
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

  ctx.save();
  ctx.fillStyle = rgbaToCss(rgba, 0.16);
  ctx.strokeStyle = rgbaToCss(rgba, 0.7);
  ctx.lineWidth = 2;
  for (const r of rects) {
    const p0 = applyMatrix(shape.matrix, r.left, r.top);
    const p1 = applyMatrix(shape.matrix, r.right, r.bottom);
    const x = Math.min(p0[0], p1[0]);
    const y = Math.min(p0[1], p1[1]);
    const w = Math.abs(p1[0] - p0[0]);
    const h = Math.abs(p1[1] - p0[1]);
    ctx.fillRect(x, y, w, h);
    if (shape.shapeType === 41) {
      ctx.strokeRect(x, y, w, h);
    }
  }
  ctx.restore();
}
