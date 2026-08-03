import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";

declare module "@tiptap/core" {
  interface Storage {
    resizableImage: {
      onResize?: ((html: string) => void) | null;
      onAnnotate?: ((src: string, annotations: Annotation[] | null, getPos: () => number | undefined) => void) | null;
    };
  }
}
import StarterKit from "@tiptap/starter-kit";
import LinkExtension from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { useState, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, useRef, useCallback } from "react";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Heading2, Heading3, List, ListOrdered, Link as LinkIcon, ExternalLink,
  Quote, Undo, Redo, Code, ImageIcon, Columns2, Columns3,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, LayoutTemplate,
} from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../lib/utils";
import { Node, mergeAttributes } from "@tiptap/core";
import { ImageAnnotationDialog } from "../core/ImageAnnotationDialog";
import type { AnnotationHelpAssets } from "../core/AnnotationHelpDialog";
import type { Annotation, CanvasOffsets } from "../core/schema";
export type { Annotation, CanvasOffsets } from "../core/schema";

export interface RichTextEditorRef {
  editor: Editor | null;
  insertContent: (content: string) => void;
}

export interface RichTextEditorNotification {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Upload callback: receives the file, must return the final image URL. */
  onImageUpload?: (file: File) => Promise<string>;
  /**
   * Optional notification hook (e.g. wire to the host app's toast system).
   * Falls back to console.error for destructive messages.
   */
  onNotify?: (notification: RichTextEditorNotification) => void;
  /** Optional help assets (tutorial video / screenshot) for the annotation dialog. */
  annotationHelpAssets?: AnnotationHelpAssets;
}

function unescapeHtmlEntities(html: string): string {
  if (!html) return html;
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function looksLikeEscapedHtml(text: string): boolean {
  return /&lt;\s*\/?\s*\w/.test(text);
}

const ResizableImage = Node.create({
  name: "resizableImage",
  group: "inline",
  inline: true,
  draggable: true,
  atom: true,

  addStorage() {
    return {
      // Called by the node view after a resize — bypasses the stale-closure
      // problem with TipTap's update event in React.
      onResize: null as ((html: string) => void) | null,
      // Called when the user double-clicks an image to open the annotation dialog.
      onAnnotate: null as ((src: string, getPos: () => number | undefined) => void) | null,
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
      width: {
        default: null,
        // Explicit parseHTML so the width survives HTML round-trips
        parseHTML: (el) => {
          const attr = el.getAttribute("width");
          if (attr) return parseInt(attr, 10) || null;
          const m = (el as HTMLElement).style?.width?.match(/^(\d+)px$/);
          return m ? parseInt(m[1], 10) : null;
        },
      },
      annotations: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute("data-annotations");
          if (!raw) return null;
          try { return JSON.parse(raw) as Annotation[]; } catch { return null; }
        },
      },
      // Stores the clean (unannotated) original image URL so the canvas always
      // renders from the unmodified base, preventing cumulative annotation baking.
      originalSrc: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-original-src") || null,
      },
      // Canvas expansion offsets (pixels added around the image)
      canvasOffsetX: {
        default: 0,
        parseHTML: (el) => parseInt(el.getAttribute("data-canvas-offset-x") ?? "0", 10) || 0,
      },
      canvasOffsetY: {
        default: 0,
        parseHTML: (el) => parseInt(el.getAttribute("data-canvas-offset-y") ?? "0", 10) || 0,
      },
      canvasPaddingRight: {
        default: 0,
        parseHTML: (el) => parseInt(el.getAttribute("data-canvas-padding-right") ?? "0", 10) || 0,
      },
      canvasPaddingBottom: {
        default: 0,
        parseHTML: (el) => parseInt(el.getAttribute("data-canvas-padding-bottom") ?? "0", 10) || 0,
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const { width, annotations, originalSrc,
            canvasOffsetX, canvasOffsetY, canvasPaddingRight, canvasPaddingBottom,
            ...rest } = HTMLAttributes;
    const style = `height: auto; max-width: 100%;${width ? ` width: ${width}px;` : ""}`;
    const annAttr = annotations ? { "data-annotations": JSON.stringify(annotations) } : {};
    const origAttr = originalSrc ? { "data-original-src": originalSrc } : {};
    const canvasAttrs: Record<string, string> = {};
    if (canvasOffsetX)      canvasAttrs["data-canvas-offset-x"]       = String(canvasOffsetX);
    if (canvasOffsetY)      canvasAttrs["data-canvas-offset-y"]       = String(canvasOffsetY);
    if (canvasPaddingRight) canvasAttrs["data-canvas-padding-right"]  = String(canvasPaddingRight);
    if (canvasPaddingBottom) canvasAttrs["data-canvas-padding-bottom"] = String(canvasPaddingBottom);
    return ["img", mergeAttributes(rest, { style, width: width ?? undefined, ...annAttr, ...origAttr, ...canvasAttrs })];
  },

  addNodeView() {
    // `editor` is available here — we use it to call the onResize storage callback
    return ({ node, editor, getPos }) => {
      const commitWidth = (w: number) => {
        // Write the width directly into the document via a positioned transaction.
        try {
          const pos = typeof getPos === "function" ? getPos() : null;
          if (pos != null && pos >= 0) {
            const { state, view } = editor;
            const docNode = state.doc.nodeAt(pos);
            if (docNode && docNode.type.name === "resizableImage") {
              view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...docNode.attrs, width: w }));
            }
          }
        } catch { /* ignore */ }
        const html = editor.getHTML();
        editor.storage.resizableImage?.onResize?.(html === "<p></p>" ? "" : html);
      };

      const wrapper = document.createElement("span");
      wrapper.style.cssText =
        "display: inline-block; position: relative; max-width: 100%; line-height: 0;";

      const img = document.createElement("img");
      img.src = node.attrs.src;
      img.alt = node.attrs.alt || "";
      const initW = node.attrs.width;
      img.style.cssText = `display: block; height: auto; max-width: 100%; ${initW ? `width: ${initW}px;` : ""}`;
      wrapper.appendChild(img);

      // 8 Word/PowerPoint-style resize handles: 4 corners + 4 edge midpoints.
      // Each handle: 8×8 px white square with blue border, positioned on the selection border.
      // `dir`: +1 = drag-right widens, -1 = drag-right narrows (left-side handles).
      const HANDLE_DEFS: { top?: string; left?: string; right?: string; bottom?: string; transform?: string; cursor: string; dir: 1 | -1 }[] = [
        { top: "-5px",    left: "-5px",  cursor: "nw-resize",  dir: -1 },
        { top: "-5px",    left: "50%",   transform: "translateX(-50%)", cursor: "n-resize", dir:  1 },
        { top: "-5px",    right: "-5px", cursor: "ne-resize",  dir:  1 },
        { top: "50%",     left: "-5px",  transform: "translateY(-50%)", cursor: "w-resize",  dir: -1 },
        { top: "50%",     right: "-5px", transform: "translateY(-50%)", cursor: "e-resize",  dir:  1 },
        { bottom: "-5px", left: "-5px",  cursor: "sw-resize",  dir: -1 },
        { bottom: "-5px", left: "50%",   transform: "translateX(-50%)", cursor: "s-resize",  dir:  1 },
        { bottom: "-5px", right: "-5px", cursor: "se-resize",  dir:  1 },
      ];

      const handleEls: HTMLSpanElement[] = [];

      for (const def of HANDLE_DEFS) {
        const h = document.createElement("span");
        h.setAttribute("draggable", "false");
        h.style.touchAction = "none";
        h.style.cssText = [
          "position: absolute",
          "width: 8px",
          "height: 8px",
          "background: #fff",
          "border: 1.5px solid #3b82f6",
          "box-sizing: border-box",
          `cursor: ${def.cursor}`,
          "z-index: 20",
          "display: none",        // hidden until selected
          def.top    ? `top: ${def.top}`       : "",
          def.left   ? `left: ${def.left}`     : "",
          def.right  ? `right: ${def.right}`   : "",
          def.bottom ? `bottom: ${def.bottom}` : "",
          def.transform ? `transform: ${def.transform}` : "",
        ].filter(Boolean).join("; ");

        const dir = def.dir;
        h.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          try { h.setPointerCapture(e.pointerId); } catch { /* ignore */ }
          const startX = e.clientX;
          const startWidth = img.offsetWidth;

          const onMove = (ev: PointerEvent) => {
            const w = Math.max(40, Math.round(startWidth + dir * (ev.clientX - startX)));
            img.style.width = `${w}px`;
          };
          const onUp = (ev: PointerEvent) => {
            const w = Math.max(40, Math.round(startWidth + dir * (ev.clientX - startX)));
            commitWidth(w);
            h.removeEventListener("pointermove", onMove);
            h.removeEventListener("pointerup", onUp);
            h.releasePointerCapture(e.pointerId);
          };
          h.addEventListener("pointermove", onMove);
          h.addEventListener("pointerup", onUp);
        });

        wrapper.appendChild(h);
        handleEls.push(h);
      }

      // "Annotieren" button — appears whenever the image is selected
      const annotateBtn = document.createElement("button");
      annotateBtn.type = "button";
      annotateBtn.textContent = "✏ Annotieren";
      annotateBtn.title = "Bild annotieren";
      annotateBtn.style.cssText = [
        "position: absolute",
        "top: -30px",
        "right: 0",
        "display: none",
        "align-items: center",
        "gap: 4px",
        "padding: 2px 8px",
        "background: #3b82f6",
        "color: #fff",
        "font-size: 11px",
        "font-family: system-ui, sans-serif",
        "font-weight: 500",
        "line-height: 20px",
        "border: none",
        "border-radius: 4px",
        "cursor: pointer",
        "white-space: nowrap",
        "z-index: 30",
        "box-shadow: 0 1px 4px rgba(0,0,0,0.25)",
      ].join("; ");

      const openAnnotationDialog = () => {
        let currentAnnotations: Annotation[] | null = null;
        let dialogSrc = img.src;
        try {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pos != null) {
            const docNode = editor.state.doc.nodeAt(pos);
            if (docNode?.attrs?.annotations) currentAnnotations = docNode.attrs.annotations;
            if (docNode?.attrs?.originalSrc) dialogSrc = docNode.attrs.originalSrc;
          }
        } catch { /* ignore */ }
        editor.storage.resizableImage?.onAnnotate?.(dialogSrc, currentAnnotations, () => {
          try { return typeof getPos === "function" ? getPos() : undefined; } catch { return undefined; }
        });
      };

      annotateBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      annotateBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAnnotationDialog();
      });

      wrapper.appendChild(annotateBtn);

      const showHandles = (visible: boolean) => {
        for (const h of handleEls) h.style.display = visible ? "block" : "none";
        annotateBtn.style.display = visible ? "block" : "none";
        if (visible) {
          wrapper.style.outline = "1.5px dashed #3b82f6";
          wrapper.style.outlineOffset = "3px";
        } else {
          wrapper.style.outline = "";
          wrapper.style.outlineOffset = "";
        }
      };

      // Double-click → open annotation dialog via storage callback
      img.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Read current annotations and originalSrc from the live node attrs.
        // Always open the dialog with the clean unannotated base so annotations
        // never get baked on top of an already-annotated image.
        let currentAnnotations: Annotation[] | null = null;
        let dialogSrc = img.src; // default: the displayed (possibly flat annotated) image
        try {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pos != null) {
            const docNode = editor.state.doc.nodeAt(pos);
            if (docNode?.attrs?.annotations) currentAnnotations = docNode.attrs.annotations;
            if (docNode?.attrs?.originalSrc) dialogSrc = docNode.attrs.originalSrc;
          }
        } catch { /* ignore */ }
        editor.storage.resizableImage?.onAnnotate?.(dialogSrc, currentAnnotations, () => {
          try { return typeof getPos === "function" ? getPos() : undefined; } catch { return undefined; }
        });
      });

      // Right-click context menu entry "Annotieren"
      img.addEventListener("contextmenu", (e) => {
        // Let browser default open; we rely on dblclick as primary trigger
      });

      return {
        dom: wrapper,
        selectNode()   { showHandles(true);  },
        deselectNode() { showHandles(false); },
        update(updatedNode) {
          if (updatedNode.type.name !== "resizableImage") return false;
          img.src = updatedNode.attrs.src;
          img.alt = updatedNode.attrs.alt || "";
          const w = updatedNode.attrs.width;
          img.style.width = w ? `${w}px` : "";
          return true;
        },
        // Prevent ProseMirror from re-parsing the node when we mutate
        // img.style.width during dragging (would reset the document state).
        ignoreMutation() {
          return true;
        },
        // Keep ProseMirror away from pointer events on the resize handles,
        // otherwise it may interpret the drag as node drag-and-drop.
        // Also intercept dblclick on the image itself so the annotation dialog can open.
        stopEvent(event: Event) {
          if (event.type === "dblclick" && (event.target === img || event.target === wrapper)) return true;
          if (event.target === annotateBtn || (event as PointerEvent).composedPath?.().includes(annotateBtn)) return true;
          const path = (event as PointerEvent).composedPath?.() ?? [];
          return handleEls.some((h) => event.target === h || path.includes(h));
        },
      };
    };
  },
});

const ColumnNode = Node.create({
  name: "column",
  group: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "column",
        class: "rte-column",
        style: "flex: 1 1 0%; min-width: 0;",
      }),
      0,
    ];
  },
});

const ColumnsNode = Node.create({
  name: "columns",
  group: "block",
  content: "column+",

  addAttributes() {
    return {
      count: { default: 2 },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "columns",
        class: "rte-columns",
        style: "display: flex; gap: 1rem; align-items: flex-start;",
      }),
      0,
    ];
  },
});

// ── Callout / content-block templates ────────────────────────────────────────

type CalloutType =
  | "warning" | "danger" | "info" | "tip"
  | "tools" | "steps" | "forbidden" | "delivery" | "dimensions";

const CALLOUT_STYLE_MAP: Record<CalloutType, { border: string; bg: string }> = {
  warning:    { border: "#f97316", bg: "#fff7ed" },
  danger:     { border: "#dc2626", bg: "#fef2f2" },
  info:       { border: "#3b82f6", bg: "#eff6ff" },
  tip:        { border: "#16a34a", bg: "#f0fdf4" },
  tools:      { border: "#6b7280", bg: "#f9fafb" },
  steps:      { border: "#1e40af", bg: "#dbeafe" },
  forbidden:  { border: "#991b1b", bg: "#fff1f2" },
  delivery:   { border: "#4d7c0f", bg: "#f7fee7" },
  dimensions: { border: "#475569", bg: "#f8fafc" },
};

const CALLOUT_DEFS: { type: CalloutType; emoji: string; label: string }[] = [
  { type: "warning",    emoji: "⚠️",  label: "Warnung" },
  { type: "danger",     emoji: "🔴",  label: "Achtung / Gefahr" },
  { type: "info",       emoji: "ℹ️",   label: "Hinweis" },
  { type: "tip",        emoji: "✅",  label: "Tipp" },
  { type: "tools",      emoji: "🔧",  label: "Werkzeug & Material" },
  { type: "steps",      emoji: "📋",  label: "Montageschritt" },
  { type: "forbidden",  emoji: "🚫",  label: "Nicht zulässig" },
  { type: "delivery",   emoji: "📦",  label: "Lieferumfang" },
  { type: "dimensions", emoji: "📐",  label: "Maße & Abstände" },
];

const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",

  addAttributes() {
    return {
      calloutType: {
        default: "info" as CalloutType,
        parseHTML: (el) => (el.getAttribute("data-callout-type") as CalloutType) || "info",
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const type = (HTMLAttributes.calloutType || "info") as CalloutType;
    const { border, bg } = CALLOUT_STYLE_MAP[type] ?? CALLOUT_STYLE_MAP.info;
    return [
      "div",
      mergeAttributes(
        { "data-type": "callout", "data-callout-type": type },
        { style: `border-left: 4px solid ${border}; background-color: ${bg}; padding: 12px 16px; margin: 8px 0; border-radius: 4px;` }
      ),
      0,
    ];
  },
});

function insertCallout(editor: Editor, type: CalloutType) {
  const def = CALLOUT_DEFS.find((d) => d.type === type)!;
  const heading = {
    type: "paragraph",
    content: [{ type: "text", marks: [{ type: "bold" }], text: `${def.emoji} ${def.label}` }],
  };

  let body: object[];
  if (type === "steps") {
    body = [{ type: "orderedList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Schritt 1 beschreiben …" }] }] },
      { type: "listItem", content: [{ type: "paragraph" }] },
      { type: "listItem", content: [{ type: "paragraph" }] },
    ]}];
  } else if (type === "tools" || type === "delivery") {
    body = [{ type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Hier Ihren Text eingeben …" }] }] },
      { type: "listItem", content: [{ type: "paragraph" }] },
      { type: "listItem", content: [{ type: "paragraph" }] },
    ]}];
  } else if (type === "dimensions") {
    body = [{ type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Breite: — mm" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Tiefe: — mm" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Höhe: — mm" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Gewicht: — kg" }] }] },
    ]}];
  } else {
    body = [{ type: "paragraph", content: [{ type: "text", text: "Hier Ihren Text eingeben …" }] }];
  }

  editor.chain().focus().insertContent({
    type: "callout",
    attrs: { calloutType: type },
    content: [heading, ...body],
  }).run();
}

// ─────────────────────────────────────────────────────────────────────────────

function insertColumns(editor: Editor, count: 2 | 3) {
  const columns = Array.from({ length: count }, () => ({
    type: "column",
    content: [{ type: "paragraph" }],
  }));
  editor
    .chain()
    .focus()
    .insertContent({ type: "columns", attrs: { count }, content: columns })
    .run();
}

const RichTextEditor = forwardRef<RichTextEditorRef, RichTextEditorProps>(
  ({ value, onChange, disabled = false, placeholder, onImageUpload, onNotify, annotationHelpAssets }, ref) => {
    const toast = useCallback((n: RichTextEditorNotification) => {
      if (onNotify) onNotify(n);
      else if (n.variant === "destructive") console.error(`${n.title}${n.description ? `: ${n.description}` : ""}`);
    }, [onNotify]);
    const [showSource, setShowSource] = useState(false);
    const [sourceValue, setSourceValue] = useState("");
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
    const [linkUrl, setLinkUrl] = useState("");
    const [linkNewTab, setLinkNewTab] = useState(true);
    const [templatesPopoverOpen, setTemplatesPopoverOpen] = useState(false);
    const [bubbleLinkOpen, setBubbleLinkOpen] = useState(false);
    const [bubbleLinkUrl, setBubbleLinkUrl] = useState("");
    const [bubbleLinkNewTab, setBubbleLinkNewTab] = useState(true);

    // Annotation dialog state
    const [annotationState, setAnnotationState] = useState<{
      src: string;
      initialAnnotations: Annotation[] | null;
      initialCanvasOffsets: CanvasOffsets | null;
      getPos: () => number | undefined;
    } | null>(null);
    // Radix needs a proper close sequence (open → false, layer removal, focus
    // restore) BEFORE the dialog unmounts. Unmounting the ImageAnnotationDialog
    // abruptly while open={true} (setAnnotationState(null) directly) corrupts
    // Radix's layer stack — in production builds this closes the parent
    // Montagehinweise dialog too and leaves the page frozen (stale focus trap /
    // body pointer-events lock). So: first set aeOpen=false, then unmount after
    // the close sequence has run.
    const [aeOpen, setAeOpen] = useState(true);
    useEffect(() => {
      if (annotationState) setAeOpen(true);
    }, [annotationState]);
    const closeAnnotationEditor = useCallback(() => {
      setAeOpen(false);
      setTimeout(() => setAnnotationState(null), 250);
    }, []);

    // Refs to avoid stale closures in TipTap callbacks
    const onChangeRef = useRef(onChange);
    const showSourceRef = useRef(showSource);
    const onImageUploadRef = useRef(onImageUpload);
    useLayoutEffect(() => { onChangeRef.current = onChange; });
    useLayoutEffect(() => { showSourceRef.current = showSource; });
    useLayoutEffect(() => { onImageUploadRef.current = onImageUpload; });

    // Mutable ref that always points to the current handleImageFile implementation.
    // Used inside editorProps (set after function definition below).
    const handleImageFileRef = useRef<((file: File) => Promise<void>) | null>(null);
    // Handles Word/LibreOffice HTML paste: extracts base64 images, uploads them,
    // then inserts the cleaned HTML into the editor.
    const handleWordPasteRef = useRef<((html: string) => Promise<void>) | null>(null);

    const processedInitial = value && looksLikeEscapedHtml(value) ? unescapeHtmlEntities(value) : (value || "");

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
        }),
        LinkExtension.configure({
          openOnClick: false,
          HTMLAttributes: { class: "text-primary underline" },
        }),
        Underline,
        Placeholder.configure({
          placeholder: placeholder || "Inhalt eingeben...",
        }),
        ResizableImage,
        CalloutNode,
        ColumnNode,
        ColumnsNode,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
      ],
      content: processedInitial,
      editable: !disabled,
      editorProps: {
        // Safety net: no matter which paste path TipTap takes, base64 images must
        // never enter the document. Word images are uploaded via handlePaste below;
        // anything that slips through gets stripped here (synchronously).
        transformPastedHTML(html) {
          return html.replace(/<img[^>]*src=["']data:image\/[^"']*["'][^>]*\/?>/gi, "");
        },
        handlePaste(_view, event) {
          const items = Array.from(event.clipboardData?.items ?? []);

          // ── Path A: direct image item (screenshots, copy-image from browser) ──
          const imageItem = items.find((item) => item.type.startsWith("image/"));
          if (imageItem) {
            if (!onImageUploadRef.current) return true; // block base64 fallback before first save
            const file = imageItem.getAsFile();
            if (!file) return false;
            handleImageFileRef.current?.(file);
            return true;
          }

          // ── Path B: HTML clipboard (Word, LibreOffice) with base64 images ──
          // We must decide synchronously whether to consume the event (return true)
          // before TipTap touches the clipboard. If text/html is present and we have
          // an upload handler, we take full ownership of the paste:
          //   • base64 <img> tags → upload → replace src → insert cleaned HTML
          //   • no base64 images   → insert HTML ourselves (same result as TipTap default)
          const htmlItem = items.find((item) => item.type === "text/html");
          if (htmlItem && onImageUploadRef.current) {
            // Consume the event NOW so TipTap never inserts raw base64.
            htmlItem.getAsString((html) => {
              handleWordPasteRef.current?.(html);
            });
            return true; // ← block TipTap's default paste handler entirely
          }

          return false; // no HTML / no upload handler → let TipTap handle normally
        },
        handleDrop(_view, event) {
          const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
          const imageFile = files.find((f) => f.type.startsWith("image/"));
          if (!imageFile) return false;
          if (!onImageUploadRef.current) return true; // block drop without upload handler
          handleImageFileRef.current?.(imageFile);
          return true;
        },
      },
    });

    // Fresh update listener — avoids stale closure over onChange/showSource
    useEffect(() => {
      if (!editor) return;
      const handler = () => {
        if (!showSourceRef.current) {
          const html = editor.getHTML();
          onChangeRef.current(html === "<p></p>" ? "" : html);
        }
      };
      editor.on("update", handler);
      return () => { editor.off("update", handler); };
    }, [editor]);

    // Register the image-resize callback in the ResizableImage extension storage.
    // The node view calls this directly after updateAttributes so the parent's
    // state is updated regardless of whether the TipTap update event fires.
    useEffect(() => {
      if (!editor) return;
      editor.storage.resizableImage.onResize = (html: string) => {
        onChangeRef.current(html);
      };
      return () => {
        editor.storage.resizableImage.onResize = null;
      };
    }, [editor]);

    // Register the annotation-open callback so the NodeView can trigger the dialog.
    useEffect(() => {
      if (!editor) return;
      editor.storage.resizableImage.onAnnotate = (
        src: string,
        annotations: Annotation[] | null,
        getPos: () => number | undefined,
      ) => {
        // Read persisted canvas offsets from the live node attrs so the dialog
        // reopens with the same expanded canvas the user saved last time.
        let initialCanvasOffsets: CanvasOffsets | null = null;
        try {
          const pos = typeof getPos === "function" ? getPos() : undefined;
          if (pos != null) {
            const docNode = editor.state.doc.nodeAt(pos);
            if (docNode) {
              const { canvasOffsetX, canvasOffsetY, canvasPaddingRight, canvasPaddingBottom } = docNode.attrs;
              if (canvasOffsetX || canvasOffsetY || canvasPaddingRight || canvasPaddingBottom) {
                initialCanvasOffsets = {
                  x: canvasOffsetX ?? 0,
                  y: canvasOffsetY ?? 0,
                  right: canvasPaddingRight ?? 0,
                  bottom: canvasPaddingBottom ?? 0,
                };
              }
            }
          }
        } catch { /* ignore */ }
        setAnnotationState({ src, initialAnnotations: annotations, initialCanvasOffsets, getPos });
      };
      return () => {
        editor.storage.resizableImage.onAnnotate = null;
      };
    }, [editor]);

    useImperativeHandle(ref, () => ({
      editor,
      insertContent: (content: string) => {
        if (showSource) {
          setSourceValue(prev => prev + content);
        } else if (editor) {
          editor.chain().focus().insertContent(content).run();
        }
      },
    }), [editor, showSource]);

    useEffect(() => {
      if (!editor || showSource) return;
      const processed = value && looksLikeEscapedHtml(value) ? unescapeHtmlEntities(value) : (value || "");
      const current = editor.getHTML();
      const currentNorm = current === "<p></p>" ? "" : current;
      if (processed !== currentNorm) {
        editor.commands.setContent(processed, { emitUpdate: false });
      }
    }, [value, editor, showSource]);

    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled);
      }
    }, [disabled, editor]);

    function toggleSource() {
      if (showSource) {
        if (editor) {
          editor.commands.setContent(sourceValue, { emitUpdate: false });
          requestAnimationFrame(() => {
            const html = editor.getHTML();
            onChange(html === "<p></p>" ? "" : html);
          });
        }
        setShowSource(false);
      } else {
        const html = editor?.getHTML() || "";
        setSourceValue(html === "<p></p>" ? "" : html);
        setShowSource(true);
      }
    }

    function handleSourceChange(newHtml: string) {
      setSourceValue(newHtml);
      onChange(newHtml);
    }

    async function handleImageFile(file: File) {
      if (!onImageUpload || !editor) return;
      setUploading(true);
      try {
        const url = await onImageUpload(file);
        editor.chain().focus().insertContent({
          type: "resizableImage",
          attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, "") },
        }).run();
      } catch (err) {
        toast({
          title: "Bild-Upload fehlgeschlagen",
          description: err instanceof Error ? err.message : "Das Bild konnte nicht hochgeladen werden.",
          variant: "destructive",
        });
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }

    async function handleWordPaste(html: string) {
      if (!editor) return;
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img[src^='data:image']"));

      // No base64 images → insert the HTML as-is (replaces TipTap's own default handler
      // since we already consumed the paste event with return true).
      if (imgs.length === 0 || !onImageUpload) {
        editor.chain().focus().insertContent(doc.body.innerHTML).run();
        return;
      }

      // Upload every base64 image and replace its src with the proxy URL.
      setUploading(true);
      try {
        await Promise.all(imgs.map(async (img) => {
          try {
            const src = img.getAttribute("src") ?? "";
            const [header, b64] = src.split(",");
            const mime = header.match(/:(.*?);/)?.[1] ?? "image/png";
            const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const file = new File([bytes], `paste.${ext}`, { type: mime });
            const url = await onImageUpload(file);
            img.setAttribute("src", url);
          } catch {
            img.remove(); // silently drop images that fail to upload
          }
        }));
        // All base64 srcs are now proxy URLs — insert the cleaned HTML once.
        editor.chain().focus().insertContent(doc.body.innerHTML).run();
      } catch (err) {
        toast({
          title: "Bild-Upload fehlgeschlagen",
          description: err instanceof Error ? err.message : "Das Bild konnte nicht hochgeladen werden.",
          variant: "destructive",
        });
      } finally {
        setUploading(false);
      }
    }

    // Keep the refs in sync so editorProps callbacks always call the latest closure.
    handleImageFileRef.current = handleImageFile;
    handleWordPasteRef.current = handleWordPaste;

    // ── Annotation save ────────────────────────────────────────────────────────
    async function handleAnnotationSave(blob: Blob, annotations: Annotation[], canvasOffsets: CanvasOffsets) {
      if (!editor || !onImageUpload || !annotationState) return;
      const file = new File([blob], "annotated.png", { type: "image/png" });
      const newUrl = await onImageUpload(file);
      const pos = annotationState.getPos();
      if (pos != null && pos >= 0) {
        try {
          const { state, view } = editor;
          const docNode = state.doc.nodeAt(pos);
          if (docNode && docNode.type.name === "resizableImage") {
            // annotationState.src is always the clean unannotated base URL
            // (the dblclick handler already resolves originalSrc → dialogSrc).
            // Preserve it as originalSrc while annotations exist OR canvas was
            // expanded (non-zero offsets); clear it only when both are absent so
            // src itself is the unexpanded base again.
            const hasOffsets = canvasOffsets.x !== 0 || canvasOffsets.y !== 0 ||
                               canvasOffsets.right !== 0 || canvasOffsets.bottom !== 0;
            const originalSrc = (annotations.length > 0 || hasOffsets) ? annotationState.src : null;
            view.dispatch(state.tr.setNodeMarkup(pos, undefined, {
              ...docNode.attrs,
              src: newUrl,
              originalSrc,
              annotations: annotations.length > 0 ? annotations : null,
              canvasOffsetX: canvasOffsets.x,
              canvasOffsetY: canvasOffsets.y,
              canvasPaddingRight: canvasOffsets.right,
              canvasPaddingBottom: canvasOffsets.bottom,
            }));
            const html = editor.getHTML();
            onChangeRef.current(html === "<p></p>" ? "" : html);
          }
        } catch { /* ignore */ }
      }
      closeAnnotationEditor();
    }

    if (!editor) return null;

    return (
      <>
      <div className={cn("border rounded-md shadow-sm bg-white dark:bg-zinc-900", disabled && "opacity-60")} data-testid="rich-text-editor">
        {!disabled && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b bg-background rounded-t-md" data-testid="editor-toolbar">
            {!showSource && (
              <>
                {/* ── Text formatting ── */}
                <div className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
                  <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Fett" testId="toolbar-bold">
                    <Bold className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Kursiv" testId="toolbar-italic">
                    <Italic className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Unterstrichen" testId="toolbar-underline">
                    <UnderlineIcon className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} title="Durchgestrichen" testId="toolbar-strike">
                    <Strikethrough className="h-4 w-4" />
                  </ToolbarButton>
                </div>

                {/* ── Struktur ── */}
                <div className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
                  <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} title="Überschrift 2" testId="toolbar-h2">
                    <Heading2 className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} title="Überschrift 3" testId="toolbar-h3">
                    <Heading3 className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Aufzählung" testId="toolbar-bullet-list">
                    <List className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Nummerierung" testId="toolbar-ordered-list">
                    <ListOrdered className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="Zitat" testId="toolbar-blockquote">
                    <Quote className="h-4 w-4" />
                  </ToolbarButton>
                </div>

                {/* ── Link ── */}
                <div className="flex items-center bg-muted/60 rounded-md p-0.5">
                  <Popover open={linkPopoverOpen} onOpenChange={setLinkPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button" variant="ghost" size="sm"
                        title="Link einfügen / bearbeiten"
                        data-testid="toolbar-link"
                        className={cn(
                          "h-8 px-2 gap-1.5 text-[11px] font-medium transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700",
                          editor.isActive("link") && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                        )}
                        onClick={() => {
                          if (editor.isActive("link")) {
                            const attrs = editor.getAttributes("link");
                            setLinkUrl(attrs.href || "");
                            setLinkNewTab(attrs.target !== "_self" && attrs.target !== null && attrs.target !== "");
                          } else {
                            setLinkUrl("");
                            setLinkNewTab(true);
                          }
                        }}
                      >
                        <LinkIcon className="h-3.5 w-3.5" />
                        Link
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-72 p-3" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                      <div className="space-y-3">
                        <p className="text-xs font-semibold">Link bearbeiten</p>
                        <Input
                          value={linkUrl}
                          onChange={(e) => setLinkUrl(e.target.value)}
                          placeholder="https://..."
                          className="h-8 text-sm"
                          data-testid="input-link-url"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              if (linkUrl.trim()) editor.chain().focus().setLink({ href: linkUrl.trim(), target: linkNewTab ? "_blank" : "_self" }).run();
                              setLinkPopoverOpen(false);
                            }
                            if (e.key === "Escape") setLinkPopoverOpen(false);
                          }}
                          autoFocus
                        />
                        <label className="flex items-center gap-2 cursor-pointer text-sm select-none">
                          <input type="checkbox" checked={linkNewTab} onChange={(e) => setLinkNewTab(e.target.checked)} className="h-4 w-4 accent-primary" data-testid="checkbox-link-new-tab" />
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                          In neuem Tab öffnen
                        </label>
                        <div className="flex items-center gap-2">
                          {editor.isActive("link") && (
                            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive" data-testid="button-link-remove"
                              onClick={() => { editor.chain().focus().unsetLink().run(); setLinkPopoverOpen(false); }}>
                              Entfernen
                            </Button>
                          )}
                          <div className="flex gap-1.5 ml-auto">
                            <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setLinkPopoverOpen(false)}>Abbrechen</Button>
                            <Button type="button" size="sm" className="h-7 px-2 text-xs" data-testid="button-link-apply" disabled={!linkUrl.trim()}
                              onClick={() => { editor.chain().focus().setLink({ href: linkUrl.trim(), target: linkNewTab ? "_blank" : "_self" }).run(); setLinkPopoverOpen(false); }}>
                              Setzen
                            </Button>
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* ── Ausrichtung ── */}
                <div className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
                  <ToolbarButton onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })} title="Linksbündig" testId="toolbar-align-left">
                    <AlignLeft className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })} title="Zentriert" testId="toolbar-align-center">
                    <AlignCenter className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })} title="Rechtsbündig" testId="toolbar-align-right">
                    <AlignRight className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().setTextAlign("justify").run()} active={editor.isActive({ textAlign: "justify" })} title="Blocksatz" testId="toolbar-align-justify">
                    <AlignJustify className="h-4 w-4" />
                  </ToolbarButton>
                </div>

                {/* ── Layout ── */}
                <div className="flex items-center gap-0.5 bg-muted/60 rounded-md p-0.5">
                  <ToolbarButton onClick={() => insertColumns(editor, 2)} active={editor.isActive("columns")} title="2 Spalten" testId="toolbar-columns-2">
                    <Columns2 className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => insertColumns(editor, 3)} active={false} title="3 Spalten" testId="toolbar-columns-3">
                    <Columns3 className="h-4 w-4" />
                  </ToolbarButton>
                </div>

                {/* ── Einfügen (blue pill — visually distinct "add content" zone) ── */}
                <div className="flex items-center gap-0.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-md p-0.5">
                  <Popover open={templatesPopoverOpen} onOpenChange={setTemplatesPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        type="button" variant="ghost" size="sm"
                        title="Inhaltsblock einfügen"
                        data-testid="toolbar-templates"
                        className="h-8 px-2 gap-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                      >
                        <LayoutTemplate className="h-3.5 w-3.5" />
                        Vorlagen
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-52 p-1" align="start">
                      <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">Inhaltsblock einfügen</p>
                      {CALLOUT_DEFS.map((def) => (
                        <button key={def.type} type="button"
                          className="flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                          onClick={() => { insertCallout(editor, def.type); setTemplatesPopoverOpen(false); }}
                        >
                          <span className="w-1 shrink-0 rounded-sm" style={{ backgroundColor: CALLOUT_STYLE_MAP[def.type].border, alignSelf: "stretch", minHeight: "16px" }} />
                          <span>{def.emoji} {def.label}</span>
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>

                  {onImageUpload && (
                    <Button
                      type="button" variant="ghost" size="sm"
                      title="Bild einfügen"
                      data-testid="toolbar-image"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                      className="h-8 px-2 gap-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      {uploading ? "Lädt…" : "Bild"}
                    </Button>
                  )}
                </div>
              </>
            )}

            {/* ── Aktionen — always right-aligned ── */}
            <div className="flex items-center gap-0.5 ml-auto">
              {!showSource && (
                <>
                  <ToolbarButton onClick={() => editor.chain().focus().undo().run()} active={false} title="Rückgängig" testId="toolbar-undo" disabled={!editor.can().undo()}>
                    <Undo className="h-4 w-4" />
                  </ToolbarButton>
                  <ToolbarButton onClick={() => editor.chain().focus().redo().run()} active={false} title="Wiederholen" testId="toolbar-redo" disabled={!editor.can().redo()}>
                    <Redo className="h-4 w-4" />
                  </ToolbarButton>
                  <div className="w-px h-4 bg-border mx-1" />
                </>
              )}
              <ToolbarButton onClick={toggleSource} active={showSource} title={showSource ? "Zurück zum Editor" : "Quellcode anzeigen"} testId="toolbar-source">
                <Code className="h-4 w-4" />
              </ToolbarButton>
              {showSource && (
                <span className="text-xs text-muted-foreground self-center ml-2">HTML-Quellcode</span>
              )}
            </div>
          </div>
        )}

        {onImageUpload && (
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImageFile(file);
            }}
            data-testid="input-image-upload"
          />
        )}

        {showSource ? (
          <Textarea
            value={sourceValue}
            onChange={e => handleSourceChange(e.target.value)}
            disabled={disabled}
            rows={12}
            className="border-0 rounded-none font-mono text-sm resize-y"
            placeholder="HTML-Code hier einfügen..."
            data-testid="editor-source"
          />
        ) : (
          <EditorContent
            editor={editor}
            className="prose prose-sm dark:prose-invert max-w-none p-3 min-h-[200px] focus-within:outline-none [&_.tiptap]:outline-none [&_.tiptap]:min-h-[180px] [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:h-0 [&_.rte-column]:border [&_.rte-column]:border-dashed [&_.rte-column]:border-muted-foreground/30 [&_.rte-column]:rounded [&_.rte-column]:p-2 [&_.rte-column]:bg-muted/20"
            data-testid="editor-content"
          />
        )}
      </div>

      {/* Bubble menu — appears above text selection */}
      {!showSource && (
        <BubbleMenu
          editor={editor}
          options={{ placement: "top" }}
          shouldShow={({ editor: ed, from, to }) => {
            // Hide inside code blocks
            if (ed.isActive("codeBlock") || ed.isActive("code")) return false;
            // Hide when an image node is selected (text formatting is meaningless on images)
            if (ed.isActive("resizableImage")) return false;
            // Hide when no selection
            return from !== to;
          }}
        >
          <div className="flex items-center gap-0.5 bg-popover border rounded-md shadow-md p-0.5">
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleBold().run()}
              active={editor.isActive("bold")}
              title="Fett"
              testId="bubble-bold"
            >
              <Bold className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleItalic().run()}
              active={editor.isActive("italic")}
              title="Kursiv"
              testId="bubble-italic"
            >
              <Italic className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              active={editor.isActive("underline")}
              title="Unterstrichen"
              testId="bubble-underline"
            >
              <UnderlineIcon className="h-3.5 w-3.5" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => editor.chain().focus().toggleStrike().run()}
              active={editor.isActive("strike")}
              title="Durchgestrichen"
              testId="bubble-strike"
            >
              <Strikethrough className="h-3.5 w-3.5" />
            </ToolbarButton>
            <div className="w-px h-5 bg-border mx-0.5" />
            <Popover open={bubbleLinkOpen} onOpenChange={setBubbleLinkOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  title="Link einfügen / bearbeiten"
                  data-testid="bubble-link"
                  className={cn(
                    "h-8 w-8 p-0 transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-700",
                    editor.isActive("link") && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                  )}
                  onClick={() => {
                    if (editor.isActive("link")) {
                      const attrs = editor.getAttributes("link");
                      setBubbleLinkUrl(attrs.href || "");
                      setBubbleLinkNewTab(attrs.target !== "_self" && attrs.target !== null && attrs.target !== "");
                    } else {
                      setBubbleLinkUrl("");
                      setBubbleLinkNewTab(true);
                    }
                  }}
                >
                  <LinkIcon className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-3" align="start" onOpenAutoFocus={(e) => e.preventDefault()}>
                <div className="space-y-3">
                  <p className="text-xs font-semibold">Link bearbeiten</p>
                  <Input
                    value={bubbleLinkUrl}
                    onChange={(e) => setBubbleLinkUrl(e.target.value)}
                    placeholder="https://..."
                    className="h-8 text-sm"
                    data-testid="bubble-input-link-url"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (bubbleLinkUrl.trim()) editor.chain().focus().setLink({ href: bubbleLinkUrl.trim(), target: bubbleLinkNewTab ? "_blank" : "_self" }).run();
                        setBubbleLinkOpen(false);
                      }
                      if (e.key === "Escape") setBubbleLinkOpen(false);
                    }}
                    autoFocus
                  />
                  <label className="flex items-center gap-2 cursor-pointer text-sm select-none">
                    <input type="checkbox" checked={bubbleLinkNewTab} onChange={(e) => setBubbleLinkNewTab(e.target.checked)} className="h-4 w-4 accent-primary" />
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    In neuem Tab öffnen
                  </label>
                  <div className="flex items-center gap-2">
                    {editor.isActive("link") && (
                      <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={() => { editor.chain().focus().unsetLink().run(); setBubbleLinkOpen(false); }}>
                        Entfernen
                      </Button>
                    )}
                    <div className="flex gap-1.5 ml-auto">
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setBubbleLinkOpen(false)}>Abbrechen</Button>
                      <Button type="button" size="sm" className="h-7 px-2 text-xs" disabled={!bubbleLinkUrl.trim()}
                        onClick={() => { editor.chain().focus().setLink({ href: bubbleLinkUrl.trim(), target: bubbleLinkNewTab ? "_blank" : "_self" }).run(); setBubbleLinkOpen(false); }}>
                        Setzen
                      </Button>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </BubbleMenu>
      )}

      {/* Annotation dialog — rendered outside the editor div to avoid z-index issues */}
      {annotationState && onImageUpload && (
        <ImageAnnotationDialog
          open={aeOpen}
          imageUrl={annotationState.src}
          initialAnnotations={annotationState.initialAnnotations}
          initialCanvasOffsets={annotationState.initialCanvasOffsets}
          onSave={handleAnnotationSave}
          onClose={closeAnnotationEditor}
          helpAssets={annotationHelpAssets}
        />
      )}
    </>
  );
  }
);

RichTextEditor.displayName = "RichTextEditor";

function ToolbarButton({
  onClick,
  active,
  title,
  testId,
  disabled = false,
  children,
}: {
  onClick: () => void;
  active: boolean;
  title: string;
  testId: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-8 w-8 p-0 transition-colors",
        active
          ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
          : "hover:bg-zinc-200 dark:hover:bg-zinc-700"
      )}
      data-testid={testId}
    >
      {children}
    </Button>
  );
}

export default RichTextEditor;
