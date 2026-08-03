/**
 * Annotation data schema — public, versioned.
 *
 * These types describe the persisted annotation format. Saved annotations are
 * stored as a plain JSON array of `Annotation` objects (e.g. in a
 * `data-annotations` attribute of an <img>), optionally accompanied by
 * `CanvasOffsets` describing canvas expansion around the base image.
 *
 * Versioning:
 *  - `ANNOTATION_SCHEMA_VERSION` is the current schema version.
 *  - The historical (and still primary) wire format is a bare
 *    `Annotation[]` array — this corresponds to version 1.
 *  - `AnnotationDocument` is the recommended envelope for new integrations;
 *    `parseAnnotationDocument` accepts both forms.
 *
 * Compatibility rules:
 *  - New optional fields may be added within a version (readers must ignore
 *    unknown fields and fall back to documented defaults).
 *  - Removing fields or changing semantics requires a version bump; legacy
 *    fields (e.g. `fill` on circle/rect, superseded by `fillOpacity`) are
 *    kept and honoured by readers.
 */

export const ANNOTATION_SCHEMA_VERSION = 1;

export type ArrowAnnotation = {
  kind: "arrow";
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
  lineWidth: number;
};

export type LineAnnotation = {
  kind: "line";
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
  lineWidth: number;
};

export type CircleAnnotation = {
  kind: "circle";
  cx: number; cy: number;
  r: number;
  color: string;
  lineWidth: number;
  fill?: "none" | "solid" | "semi"; // legacy — use fillOpacity when present
  fillOpacity?: number; // 0-100 (0 = no fill, 100 = fully opaque)
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
};

export type EllipseAnnotation = {
  kind: "ellipse";
  cx: number; cy: number;
  rx: number; ry: number;  // semi-axes
  color: string;
  lineWidth: number;
  fillOpacity?: number; // 0-100 (0 = no fill, 100 = fully opaque)
  rotation?: number;   // radians
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
};

export type TextAnnotation = {
  kind: "text";
  x: number; y: number;
  text: string;
  color: string;
  fontSize: number;
  maxWidth?: number;   // canvas px at which lines wrap (0/undefined = no wrap)
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
};

export type RectAnnotation = {
  kind: "rect";
  x: number; y: number;
  w: number; h: number;
  color: string;
  lineWidth: number;
  fill?: "none" | "solid" | "semi"; // legacy — use fillOpacity when present
  fillOpacity?: number; // 0-100 (0 = no fill, 100 = fully opaque)
  rotation?: number;   // radians, around the rect centre
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
};

export type ImageAnnotation = {
  kind: "image";
  x: number; y: number;
  width: number; height: number;
  dataUrl: string;
  rotation?: number;    // radians, around the image centre
  opacity?: number;     // 0–100 (default 100 = fully opaque)
  borderWidth?: number; // px (0 = no border)
  borderColor?: string; // CSS colour string
  borderStyle?: "solid" | "dashed" | "dotted";
  borderRadius?: number; // corner radius in px
  shadowBlur?: number;    // px (0 = no shadow)
  shadowColor?: string;   // CSS colour with alpha, e.g. "rgba(0,0,0,0.5)"
  shadowOffsetX?: number; // px
  shadowOffsetY?: number; // px
  flipH?: boolean;        // mirror horizontally
  flipV?: boolean;        // mirror vertically
  brightness?: number;    // 50–150 (default 100 = unchanged)
  contrast?: number;      // 50–150 (default 100 = unchanged)
};

export type Annotation =
  | ArrowAnnotation
  | LineAnnotation
  | CircleAnnotation
  | EllipseAnnotation
  | TextAnnotation
  | RectAnnotation
  | ImageAnnotation;

/** Canvas expansion offsets (pixels added around the base image). */
export type CanvasOffsets = { x: number; y: number; right: number; bottom: number };

/** Versioned envelope for persisting annotations (recommended for new integrations). */
export type AnnotationDocument = {
  schemaVersion: number;
  annotations: Annotation[];
  canvasOffsets?: CanvasOffsets;
};

/** Wrap annotations in a versioned document envelope. */
export function createAnnotationDocument(
  annotations: Annotation[],
  canvasOffsets?: CanvasOffsets,
): AnnotationDocument {
  return { schemaVersion: ANNOTATION_SCHEMA_VERSION, annotations, ...(canvasOffsets ? { canvasOffsets } : {}) };
}

/**
 * Parse persisted annotation data. Accepts both the legacy bare-array form
 * (schema version 1) and the versioned `AnnotationDocument` envelope.
 * Returns null for unusable input.
 */
export function parseAnnotationDocument(raw: unknown): AnnotationDocument | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (Array.isArray(value)) {
    return { schemaVersion: 1, annotations: value as Annotation[] };
  }
  if (value && typeof value === "object" && Array.isArray((value as AnnotationDocument).annotations)) {
    const doc = value as AnnotationDocument;
    return {
      schemaVersion: typeof doc.schemaVersion === "number" ? doc.schemaVersion : 1,
      annotations: doc.annotations,
      ...(doc.canvasOffsets ? { canvasOffsets: doc.canvasOffsets } : {}),
    };
  }
  return null;
}
