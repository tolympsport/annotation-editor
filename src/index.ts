/**
 * @tolymp/annotation-editor — main entry point.
 *
 * Pure image annotation dialog (no TipTap dependencies):
 * image in → onSave(blob, annotations, canvasOffsets) out.
 */
export { ImageAnnotationDialog } from "./core/ImageAnnotationDialog";
export { PhotoInboxDialog, type PhotoInboxDialogProps } from "./photo-inbox/PhotoInboxDialog";
export type { PhotoInboxItemDto } from "./photo-inbox/types";
export { AnnotationHelpDialog, type AnnotationHelpAssets, type HelpTab } from "./core/AnnotationHelpDialog";
export {
  ANNOTATION_SCHEMA_VERSION,
  createAnnotationDocument,
  parseAnnotationDocument,
  type Annotation,
  type ArrowAnnotation,
  type LineAnnotation,
  type CircleAnnotation,
  type EllipseAnnotation,
  type TextAnnotation,
  type RectAnnotation,
  type ImageAnnotation,
  type CanvasOffsets,
  type AnnotationDocument,
} from "./core/schema";
