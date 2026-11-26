import JSZip from 'jszip';
import {
  getArgbFromVarint,
  getBytes,
  getFloat32,
  getRepeatedMessages,
  getString,
  getVarintNumber,
  parseProtobuf,
  type PbFieldMap,
} from './protobuf';
import { multiplyMatrix } from './strokeGeometry';
import type {
  PageMarginConfig,
  Rect,
  StarNoteDocument,
  StarNotePage,
  StarNoteShape,
  StrokePoint,
  TemplateConfig,
} from './types';

export interface VirtualFile {
  path: string; // normalized forward-slash path
  readBytes: () => Promise<Uint8Array>;
}

const DEFAULT_A4: Rect = { left: 0, top: 0, right: 2100, bottom: 2970 };
const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const textDecoder = new TextDecoder('utf-8');

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parsePointsBlob(buf: Uint8Array | undefined): StrokePoint[] {
  if (!buf || buf.length < 16) return [];
  const count = Math.floor(buf.length / 16);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pts: StrokePoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 16;
    pts[i] = {
      x: dv.getFloat32(off, false),
      y: dv.getFloat32(off + 4, false),
      pressure: dv.getUint16(off + 8, false),
      extra: dv.getUint16(off + 10, false),
      timeMs: dv.getUint32(off + 12, false),
    };
  }
  return pts;
}

function safeJsonParse<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function mergeShapeFields(
  existing: Partial<StarNoteShape> | undefined,
  fields: PbFieldMap,
  pageId: string
): Partial<StarNoteShape> {
  const s: Partial<StarNoteShape> = existing ? { ...existing } : { pageId, matrix: [...IDENTITY_MATRIX], points: [] };

  const id = getString(fields, 1);
  if (id !== undefined) s.id = id;
  const createdAt = getVarintNumber(fields, 2);
  if (createdAt !== undefined) s.createdAt = createdAt;
  const updatedAt = getVarintNumber(fields, 3);
  if (updatedAt !== undefined) s.updatedAt = updatedAt;
  const colorArgb = getArgbFromVarint(fields, 4);
  if (colorArgb !== undefined) s.colorArgb = colorArgb;
  const thickness = getFloat32(fields, 5);
  if (thickness !== undefined) s.thickness = thickness;

  const bbox = safeJsonParse<Rect>(getString(fields, 7));
  if (bbox) s.bbox = bbox;

  const matObj = safeJsonParse<{ isEmpty?: boolean; values?: number[] }>(getString(fields, 8));
  if (matObj?.values && matObj.values.length === 9) {
    s.matrix = matObj.values;
  }

  const brush = safeJsonParse<StarNoteShape['brush']>(getString(fields, 11));
  if (brush) s.brush = brush;

  const shapeType = getVarintNumber(fields, 12);
  if (shapeType !== undefined) s.shapeType = shapeType;

  const f14 = safeJsonParse<{ uniqueId?: string }>(getString(fields, 14));
  if (f14?.uniqueId) s.resourceUniqueId = f14.uniqueId;

  const f15 = getVarintNumber(fields, 15);
  if (f15 !== undefined) s.isDeleted = f15 === 1;
  else if (s.isDeleted === undefined) s.isDeleted = false;

  const f17 = safeJsonParse<{ lineStyle?: { phase: number; type: number } }>(getString(fields, 17));
  if (f17?.lineStyle) s.lineStyle = f17.lineStyle;

  const f24 = safeJsonParse<{ a?: Record<string, unknown>; repo?: Record<string, unknown> }>(
    getString(fields, 24)
  );
  const attrs = f24?.a ?? f24?.repo;
  if (attrs) {
    if (typeof attrs.KEY_UNDER_CONTENT === 'boolean') s.underContent = attrs.KEY_UNDER_CONTENT;
    if (typeof attrs.KEY_ROUND_CORNER === 'boolean') s.roundCorner = attrs.KEY_ROUND_CORNER;
    if (typeof attrs.KEY_TABLE_INFO === 'string') {
      const ti = safeJsonParse<StarNoteShape['tableInfo']>(attrs.KEY_TABLE_INFO);
      if (ti) s.tableInfo = ti;
    }
    if (typeof attrs.KEY_EXCERPT_INFO === 'string') {
      const ei = safeJsonParse<StarNoteShape['excerptInfo']>(attrs.KEY_EXCERPT_INFO);
      if (ei) s.excerptInfo = ei;
    }
  }

  const ptsBuf = getBytes(fields, 25);
  if (ptsBuf !== undefined) {
    s.points = parsePointsBlob(ptsBuf);
  }

  const f26 = safeJsonParse<{ shapeReferenceBean?: StarNoteShape['shapeReference'] }>(
    getString(fields, 26)
  );
  if (f26?.shapeReferenceBean) {
    s.shapeReference = f26.shapeReferenceBean;
  }

  return s;
}

function finalizeShape(partial: Partial<StarNoteShape>): StarNoteShape {
  return {
    id: partial.id ?? '',
    pageId: partial.pageId ?? '',
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    colorArgb: partial.colorArgb ?? 0xff000000,
    thickness: partial.thickness ?? 3,
    bbox: partial.bbox,
    matrix: partial.matrix ?? [...IDENTITY_MATRIX],
    brush: partial.brush,
    shapeType: partial.shapeType ?? 2,
    resourceUniqueId: partial.resourceUniqueId,
    isDeleted: partial.isDeleted ?? false,
    lineStyle: partial.lineStyle,
    underContent: partial.underContent ?? partial.shapeType === 15,
    roundCorner: partial.roundCorner ?? false,
    tableInfo: partial.tableInfo,
    excerptInfo: partial.excerptInfo,
    shapeReference: partial.shapeReference,
    points: partial.points ?? [],
  };
}

function parseTemplateJson(bytes: Uint8Array): TemplateConfig | undefined {
  const obj = safeJsonParse<{
    properties?: {
      layoutType?: string;
      fillAttr?: { color?: number; enableColor?: boolean };
      imageAttr?: { relativePath?: string };
      resourceAttr?: { resName?: string };
      strokeAttr?: { color?: number; width?: number };
    };
  }>(textDecoder.decode(bytes));
  if (!obj?.properties) return undefined;
  const p = obj.properties;
  return {
    layoutType: p.layoutType,
    fillColor: p.fillAttr?.color,
    fillEnableColor: p.fillAttr?.enableColor,
    imageRelativePath: p.imageAttr?.relativePath,
    resName: p.resourceAttr?.resName,
    strokeColor: p.strokeAttr?.color,
    strokeWidth: p.strokeAttr?.width,
  };
}

export async function filesFromFileList(fileList: FileList | File[]): Promise<VirtualFile[]> {
  const arr = Array.from(fileList);
  // Check if single zip file was provided
  if (arr.length === 1 && arr[0].name.toLowerCase().endsWith('.zip')) {
    return filesFromZip(arr[0]);
  }
  return arr.map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return {
      path: normalizePath(rel),
      readBytes: async () => new Uint8Array(await file.arrayBuffer()),
    };
  });
}

export async function filesFromZip(zipFile: File | Blob | ArrayBuffer): Promise<VirtualFile[]> {
  const buf = zipFile instanceof ArrayBuffer ? zipFile : await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const out: VirtualFile[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) {
      out.push({
        path: normalizePath(relativePath),
        readBytes: () => entry.async('uint8array'),
      });
    }
  });
  return out;
}

export async function parseStarNoteBackup(
  files: VirtualFile[],
  onProgress?: (msg: string) => void
): Promise<StarNoteDocument[]> {
  // Group files by document/<docId>/...
  const docGroups = new Map<string, VirtualFile[]>();
  for (const vf of files) {
    const match = vf.path.match(/(?:^|\/)document\/([^/]+)\/(.+)$/);
    if (match) {
      const docId = match[1];
      const subPath = match[2];
      const list = docGroups.get(docId) ?? [];
      list.push({ path: subPath, readBytes: vf.readBytes });
      docGroups.set(docId, list);
    }
  }

  // Fallback: if user picked a single doc directory directly (has inc/ or template/)
  if (docGroups.size === 0) {
    const rootFiles: VirtualFile[] = [];
    for (const vf of files) {
      if (vf.path.includes('inc/') || vf.path.includes('template/') || vf.path.includes('resource/')) {
        rootFiles.push(vf);
      }
    }
    if (rootFiles.length > 0) {
      docGroups.set('notebook', rootFiles);
    }
  }

  const docs: StarNoteDocument[] = [];
  let idx = 0;
  for (const [docId, docFiles] of docGroups.entries()) {
    idx++;
    onProgress?.(`Parsing notebook ${idx}/${docGroups.size} (${docId.slice(0, 8)})...`);
    const doc = await parseSingleDocument(docId, docFiles);
    docs.push(doc);
  }

  // Sort most recently updated first, putting non-empty notebooks ahead of empty ones
  docs.sort((a, b) => {
    const aHas = a.pages.length > 0 ? 1 : 0;
    const bHas = b.pages.length > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.updatedAt - a.updatedAt;
  });

  return docs;
}

async function parseSingleDocument(docId: string, files: VirtualFile[]): Promise<StarNoteDocument> {
  const incZips: { name: string; vf: VirtualFile }[] = [];
  const templateJsons = new Map<string, TemplateConfig>();
  const templateAssets = new Map<string, Uint8Array>();
  const resourceDataByName = new Map<string, VirtualFile>();
  let thumbnailBytes: Uint8Array | undefined;
  let pdfBytes: Uint8Array | undefined;
  let pdfFilename: string | undefined;

  for (const vf of files) {
    const p = vf.path;
    const base = p.split('/').pop() ?? p;
    if (p.startsWith('inc/') && p.endsWith('.zip')) {
      incZips.push({ name: base, vf });
    } else if (p.startsWith('template/') && p.endsWith('.template_json')) {
      const cfg = parseTemplateJson(await vf.readBytes());
      if (cfg) {
        templateJsons.set(base.replace(/\.template_json$/, ''), cfg);
      }
    } else if (p.startsWith('template/') && !p.endsWith('.margin_template_suffix')) {
      templateAssets.set(base, await vf.readBytes());
    } else if (p.startsWith('resource/data/')) {
      resourceDataByName.set(base, vf);
    } else if (p.startsWith('resource/content/') && p.toLowerCase().endsWith('.pdf')) {
      pdfFilename = base;
      pdfBytes = await vf.readBytes();
    } else if (p === `${docId}.png` || (!p.includes('/') && p.endsWith('.png'))) {
      thumbnailBytes = await vf.readBytes();
    }
  }

  // Sort incremental zips chronologically (UUIDv7 filenames)
  incZips.sort((a, b) => a.name.localeCompare(b.name));

  let createdAt = 0;
  let updatedAt = 0;
  let sizeFormat = 'A4';
  let defaultPageSize: Rect = { ...DEFAULT_A4 };
  let pageMarginConfig: PageMarginConfig | undefined;

  interface RawPageState {
    id: string;
    order: number;
    createdAt: number;
    updatedAt: number;
    contentRect: Rect;
    fullRect: Rect;
    sourceRect?: Rect;
    pageType: string;
    templateOrPdfPath: string;
    pdfPageIndex?: number;
    marginBgColorArgb?: number;
    marginTemplateResource?: string;
    marginTemplateSpace?: number;
  }

  const pagesMap = new Map<string, RawPageState>();
  const resourceMapping = new Map<string, string>(); // uniqueId -> filename
  const shapesById = new Map<string, Partial<StarNoteShape>>();

  for (const { vf } of incZips) {
    const zipBytes = await vf.readBytes();
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(zipBytes);
    } catch {
      continue;
    }

    const entries: { name: string; entry: JSZip.JSZipObject }[] = [];
    zip.forEach((name, entry) => {
      if (!entry.dir) entries.push({ name: normalizePath(name), entry });
    });

    for (const { name, entry } of entries) {
      if (name.includes('/docData/doc/')) {
        const pb = parseProtobuf(await entry.async('uint8array'));
        createdAt = getVarintNumber(pb, 2) ?? createdAt;
        updatedAt = getVarintNumber(pb, 3) ?? updatedAt;
        const f9 = safeJsonParse<{
          sizeFormat?: string;
          contentPageSize?: Rect;
        }>(getString(pb, 9));
        if (f9?.sizeFormat) sizeFormat = f9.sizeFormat;
        if (f9?.contentPageSize) defaultPageSize = f9.contentPageSize;
        const f10 = safeJsonParse<{ pageMarginConfig?: PageMarginConfig }>(getString(pb, 10));
        if (f10?.pageMarginConfig) pageMarginConfig = f10.pageMarginConfig;
      } else if (name.includes('/docData/page/')) {
        const pb = parseProtobuf(await entry.async('uint8array'));
        for (const pagePb of getRepeatedMessages(pb, 1)) {
          const pid = getString(pagePb, 1);
          if (!pid) continue;
          const prev = pagesMap.get(pid);
          const f11Str = getString(pagePb, 11);
          const f11Json = safeJsonParse<{ pageIndex?: number }>(f11Str);
          const contentRect = safeJsonParse<Rect>(getString(pagePb, 6)) ?? prev?.contentRect ?? defaultPageSize;
          const fullRect = safeJsonParse<Rect>(getString(pagePb, 7)) ?? prev?.fullRect ?? contentRect;
          const sourceRect = safeJsonParse<Rect>(getString(pagePb, 8)) ?? prev?.sourceRect;
          pagesMap.set(pid, {
            id: pid,
            updatedAt: getVarintNumber(pagePb, 2) ?? prev?.updatedAt ?? 0,
            createdAt: getVarintNumber(pagePb, 3) ?? prev?.createdAt ?? 0,
            order: getFloat32(pagePb, 4) ?? prev?.order ?? 0,
            contentRect,
            fullRect,
            sourceRect,
            pageType: getString(pagePb, 9) ?? prev?.pageType ?? 'geo_layout',
            templateOrPdfPath: getString(pagePb, 10) ?? prev?.templateOrPdfPath ?? '',
            pdfPageIndex: f11Json?.pageIndex ?? prev?.pdfPageIndex,
            marginBgColorArgb: getArgbFromVarint(pagePb, 15) ?? prev?.marginBgColorArgb,
            marginTemplateResource: getString(pagePb, 16) ?? prev?.marginTemplateResource,
            marginTemplateSpace: getFloat32(pagePb, 17) ?? prev?.marginTemplateSpace,
          });
        }
      } else if (name.includes('/docData/resource/')) {
        const pb = parseProtobuf(await entry.async('uint8array'));
        for (const resPb of getRepeatedMessages(pb, 1)) {
          const uid = getString(resPb, 1);
          const rel = getString(resPb, 8) ?? getString(resPb, 12);
          if (uid && rel) {
            const fname = rel.split('/').pop() ?? rel;
            resourceMapping.set(uid, fname);
          }
        }
      } else if (name.includes('/shape/') && name.endsWith('.zip')) {
        const baseName = name.split('/').pop() ?? '';
        const pageId = baseName.split('#')[0];
        const innerBytes = await entry.async('uint8array');
        try {
          const innerZip = await JSZip.loadAsync(innerBytes);
          const innerEntries: JSZip.JSZipObject[] = [];
          innerZip.forEach((_, ie) => {
            if (!ie.dir) innerEntries.push(ie);
          });
          for (const ie of innerEntries) {
            const pb = parseProtobuf(await ie.async('uint8array'));
            for (const shapePb of getRepeatedMessages(pb, 1)) {
              const sid = getString(shapePb, 1);
              if (!sid) continue;
              const merged = mergeShapeFields(shapesById.get(sid), shapePb, pageId);
              shapesById.set(sid, merged);
            }
          }
        } catch {
          // ignore corrupted nested zip
        }
      }
    }
  }

  // Finalize all shapes & separate active vs deleted
  const allShapes = new Map<string, StarNoteShape>();
  const activeByPage = new Map<string, StarNoteShape[]>();
  let totalActiveShapes = 0;
  let totalDeletedShapes = 0;

  for (const [sid, partial] of shapesById.entries()) {
    const finalized = finalizeShape(partial);
    allShapes.set(sid, finalized);
    if (finalized.isDeleted) {
      totalDeletedShapes++;
    } else {
      totalActiveShapes++;
      const list = activeByPage.get(finalized.pageId) ?? [];
      list.push(finalized);
      activeByPage.set(finalized.pageId, list);
    }
  }

  // Resolve type=2000 shapeReferenceBean across pages
  for (const list of activeByPage.values()) {
    for (let i = 0; i < list.length; i++) {
      const sh = list[i];
      if (sh.shapeType === 2000 && sh.shapeReference?.isValid) {
        const ref = allShapes.get(sh.shapeReference.shapeId);
        if (ref && !ref.isDeleted) {
          const refMat =
            sh.shapeReference.matrixValues.length === 9
              ? sh.shapeReference.matrixValues
              : IDENTITY_MATRIX;
          list[i] = {
            ...ref,
            id: sh.id,
            pageId: sh.pageId,
            matrix: multiplyMatrix(refMat, ref.matrix),
            createdAt: sh.createdAt,
          };
        }
      }
    }
    // Sort shapes by layer: underContent first (highlighters), then createdAt order
    list.sort((a, b) => {
      if (a.underContent !== b.underContent) return a.underContent ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
  }

  // Load referenced resource images
  const resourceImages = new Map<string, Uint8Array>();
  for (const [uid, fname] of resourceMapping.entries()) {
    const vf = resourceDataByName.get(fname);
    if (vf) {
      resourceImages.set(uid, await vf.readBytes());
    }
  }

  // Build ordered pages
  const sortedRawPages = Array.from(pagesMap.values()).sort((a, b) => a.order - b.order);
  const pages: StarNotePage[] = sortedRawPages.map((rp) => {
    const tplFromPath = rp.templateOrPdfPath.split('/').pop()?.replace(/\.template_json$/, '');
    const templateConfig =
      templateJsons.get(rp.id) ??
      (tplFromPath ? templateJsons.get(tplFromPath) : undefined) ??
      templateJsons.get(docId) ??
      templateJsons.get('0');
    return {
      ...rp,
      templateConfig,
      shapes: activeByPage.get(rp.id) ?? [],
    };
  });

  // Derive human-readable title
  let title = `Notebook ${docId.slice(0, 8)}`;
  if (pdfFilename) {
    title = pdfFilename.replace(/\.pdf$/i, '');
  } else if (pages.length > 0) {
    const firstTpl = pages[0].templateConfig?.resName;
    if (firstTpl && firstTpl !== 'template_empty') {
      const pretty = firstTpl
        .replace(/^cover_(simple_|fruit_)?/, '')
        .replace(/^template_/, '')
        .replace(/_/g, ' ');
      title = `${pretty.charAt(0).toUpperCase() + pretty.slice(1)} (${docId.slice(0, 6)})`;
    }
  }

  return {
    id: docId,
    title,
    createdAt,
    updatedAt,
    sizeFormat,
    defaultPageSize,
    pageMarginConfig,
    pages,
    thumbnailBytes,
    thumbnailMime: thumbnailBytes ? 'image/png' : undefined,
    pdfBytes,
    pdfFilename,
    resourceImages,
    templateAssets,
    totalActiveShapes,
    totalDeletedShapes,
    incCount: incZips.length,
  };
}
