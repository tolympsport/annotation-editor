/**
 * @tolymp/annotation-editor/tiptap — TipTap entry point.
 *
 * RichTextEditor incl. ResizableImage node with annotation persistence as
 * data-* attributes and onImageUpload callback. Requires the TipTap peer
 * dependencies to be installed.
 */
export {
  default as RichTextEditor,
  default,
  type RichTextEditorRef,
  type RichTextEditorProps,
  type RichTextEditorNotification,
} from "./tiptap/RichTextEditor";
export type { Annotation, CanvasOffsets } from "./core/schema";
