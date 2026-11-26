export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  empty?: boolean;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  extra: number;
  timeMs: number;
}

export interface BrushInfo {
  alphaFactor?: number;
  brushShape?: number;
  directionEnabled?: boolean;
  displayScale?: number;
  dpi?: number;
  maxPressure?: number;
  pressureSensitivity?: number;
  smoothLevel?: number;
}

export interface LineStyle {
  phase: number;
  type: number; // 0 = solid, 1 = dashed, 2 = dotted
}

export interface TableCell {
  startRow: number;
  startCol: number;
  rowSpan: number;
  colSpan: number;
  fillColor: number;
  fillColorEnable: boolean;
  isMerged: boolean;
}

export interface TableInfo {
  colCount: number;
  rowCount: number;
  colWidths: number[];
  rowHeights: number[];
  cells: TableCell[][];
  tableAttr: {
    strokeColor: number;
    strokeWidth: number;
    fillColor: number;
    fillColorEnable: boolean;
    colTitleEnable?: boolean;
    rowTitleEnable?: boolean;
  };
}

export interface ExcerptInfo {
  color: number;
  imgId?: string;
  note?: string;
  quote?: string;
  rectList?: Rect[];
  style?: number;
  type?: number;
}

export interface ShapeReferenceBean {
  isValid: boolean;
  matrixValues: number[];
  pageId: string;
  shapeId: string;
}

export interface StarNoteShape {
  id: string;
  pageId: string;
  createdAt: number;
  updatedAt: number;
  colorArgb: number; // unsigned 32-bit ARGB
  thickness: number;
  bbox?: Rect;
  matrix: number[]; // 9 elements [a,b,tx, c,d,ty, 0,0,1]
  brush?: BrushInfo;
  shapeType: number; // 2=stroke, 15=highlighter/geo, 19=image, 41/44=excerpt, 47=pen, 2000=ref, 406657105=table
  resourceUniqueId?: string;
  isDeleted: boolean;
  lineStyle?: LineStyle;
  underContent: boolean;
  roundCorner: boolean;
  tableInfo?: TableInfo;
  excerptInfo?: ExcerptInfo;
  shapeReference?: ShapeReferenceBean;
  points: StrokePoint[];
}

export interface TemplateConfig {
  layoutType?: string; // LayoutImage, LayoutVector, LayoutResVector
  fillColor?: number;
  fillEnableColor?: boolean;
  imageRelativePath?: string;
  resName?: string;
  strokeColor?: number;
  strokeWidth?: number;
}

export interface StarNotePage {
  id: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  contentRect: Rect;
  fullRect: Rect;
  sourceRect?: Rect;
  pageType: string; // 'geo_layout' | 'import_pdf'
  templateOrPdfPath: string;
  pdfPageIndex?: number;
  marginBgColorArgb?: number;
  marginTemplateResource?: string;
  marginTemplateSpace?: number;
  templateConfig?: TemplateConfig;
  shapes: StarNoteShape[];
}

export interface PageMarginConfig {
  margin?: { left: number; top: number; right: number; bottom: number };
  style?: {
    color?: number;
    style?: number;
    templateResource?: string;
    templateSpace?: number;
  };
}

export interface StarNoteDocument {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sizeFormat: string;
  defaultPageSize: Rect;
  pageMarginConfig?: PageMarginConfig;
  pages: StarNotePage[];
  thumbnailBytes?: Uint8Array;
  thumbnailMime?: string;
  pdfBytes?: Uint8Array;
  pdfFilename?: string;
  /** Map from resource uniqueId -> Uint8Array image bytes */
  resourceImages: Map<string, Uint8Array>;
  /** Map from basename -> template asset bytes (webp/png/svg) */
  templateAssets: Map<string, Uint8Array>;
  totalActiveShapes: number;
  totalDeletedShapes: number;
  incCount: number;
}

export interface ExportOptions {
  includeCover: boolean;
  includeMargins: boolean;
  includeExcerpts: boolean;
  /** Stitch all pages into one tall continuous-scroll PDF page */
  continuousScroll: boolean;
}
