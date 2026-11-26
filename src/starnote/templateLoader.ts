import type { StarNoteDocument, StarNotePage } from './types';

const loadedImageCache = new Map<string, HTMLImageElement>();

export function bytesToBlobUrl(bytes: Uint8Array, mime: string): string {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return URL.createObjectURL(new Blob([ab], { type: mime }));
}

export function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

export async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  const cached = loadedImageCache.get(url);
  if (cached && cached.complete) return cached;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedImageCache.set(url, img);
      resolve(img);
    };
    img.onerror = (e) => reject(e);
    img.src = url;
  });
}

export async function resolveTemplateImage(
  doc: StarNoteDocument,
  page: StarNotePage
): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return null;
  const tpl = page.templateConfig;
  if (!tpl) return null;

  const candidates: string[] = [];
  if (tpl.imageRelativePath) {
    const base = tpl.imageRelativePath.split('/').pop()!;
    candidates.push(base);
  }
  if (tpl.resName && tpl.resName !== 'template_empty') {
    candidates.push(`${tpl.resName}.svg`, `${tpl.resName}.webp`, `${tpl.resName}.png`);
  }

  for (const name of candidates) {
    const localBytes = doc.templateAssets.get(name);
    if (localBytes) {
      const url = bytesToBlobUrl(localBytes, guessMime(name));
      try {
        return await loadImageFromUrl(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  for (const name of candidates) {
    try {
      return await loadImageFromUrl(`/starnote-assets/${name}`);
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function resolveShapeImage(
  doc: StarNoteDocument,
  uniqueId: string | undefined
): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined' || !uniqueId) return null;
  const bytes = doc.resourceImages.get(uniqueId);
  if (!bytes) return null;
  const url = bytesToBlobUrl(bytes, 'image/png');
  try {
    return await loadImageFromUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
