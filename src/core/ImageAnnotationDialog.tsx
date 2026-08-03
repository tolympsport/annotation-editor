/**
 * ImageAnnotationDialog
 *
 * Öffnet ein Bild auf einem Canvas, erlaubt das Zeichnen von Pfeilen, Kreisen
 * und Textetiketten. „Fertig" rendert das Ergebnis als PNG-Blob und ruft
 * onSave(blob) auf.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { cn } from "../lib/utils";
import { ArrowRight, ArrowLeft, ArrowUp, ArrowDown, Circle, Square, Type, MousePointer, Trash2, Undo2, Redo2, PenLine, Pencil, PaintBucket, Copy, Bold, Italic, Underline, Strikethrough, Minus, ZoomIn, ZoomOut, Maximize2, Crop, HelpCircle, ImagePlus } from "lucide-react";
import { AnnotationHelpDialog, type AnnotationHelpAssets } from "./AnnotationHelpDialog";

// ─── Annotation types (public, versioned schema) ────────────────────────────
import type {
  Annotation,
  ArrowAnnotation,
  LineAnnotation,
  CircleAnnotation,
  EllipseAnnotation,
  TextAnnotation,
  RectAnnotation,
  ImageAnnotation,
  CanvasOffsets,
} from "./schema";
export type {
  Annotation,
  ArrowAnnotation,
  LineAnnotation,
  CircleAnnotation,
  EllipseAnnotation,
  TextAnnotation,
  RectAnnotation,
  ImageAnnotation,
  CanvasOffsets,
} from "./schema";
export { ANNOTATION_SCHEMA_VERSION, createAnnotationDocument, parseAnnotationDocument, type AnnotationDocument } from "./schema";

type Tool = "select" | "arrow" | "line" | "circle" | "ellipse" | "rect" | "text" | "crop";

const COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ffffff", // white
  "#000000", // black
];

/** Rotate point (px, py) around (cx, cy) by angle radians. */
function rotatePoint(px: number, py: number, cx: number, cy: number, angle: number): { x: number; y: number } {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/**
 * Image-crop helpers — convert between real canvas space and "unrotated crop space".
 *
 * When an image annotation has a non-zero rotation the crop rect is tracked in the
 * image's local (unrotated) coordinate frame so that the extracted pixels are always
 * correct regardless of how the image is rotated on the canvas.
 *
 * "Unrotated crop space" is canvas space as seen with the image's rotation stripped out:
 * every canvas point is counter-rotated around the image centre by -rotation.  In that
 * space the image occupies the usual axis-aligned rectangle [x, x+w] × [y, y+h].
 */
function toUnrotatedCropSpace(cx: number, cy: number, ann: { x: number; y: number; width: number; height: number; rotation?: number }): { x: number; y: number } {
  const rot = ann.rotation ?? 0;
  if (rot === 0) return { x: cx, y: cy };
  return rotatePoint(cx, cy, ann.x + ann.width / 2, ann.y + ann.height / 2, -rot);
}
function fromUnrotatedCropSpace(ux: number, uy: number, ann: { x: number; y: number; width: number; height: number; rotation?: number }): { x: number; y: number } {
  const rot = ann.rotation ?? 0;
  if (rot === 0) return { x: ux, y: uy };
  return rotatePoint(ux, uy, ann.x + ann.width / 2, ann.y + ann.height / 2, rot);
}
function distPtToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitTest(ann: Annotation, x: number, y: number): boolean {
  const HIT = 10;
  if (ann.kind === "arrow" || ann.kind === "line") {
    return distPtToSegment(x, y, ann.x1, ann.y1, ann.x2, ann.y2) <= HIT;
  }
  if (ann.kind === "circle") {
    const dist = Math.hypot(x - ann.cx, y - ann.cy);
    if (ann.fill && ann.fill !== "none") return dist <= ann.r + HIT; // filled: entire interior
    return Math.abs(dist - ann.r) <= HIT; // stroke-only: ring
  }
  if (ann.kind === "text") {
    const bb = getBBox(ann);
    return x >= bb.left - HIT && x <= bb.right + HIT &&
           y >= bb.top  - HIT && y <= bb.bottom + HIT;
  }
  if (ann.kind === "ellipse") {
    // Transform point into the ellipse's local (unrotated) coordinate space
    const rot = ann.rotation ?? 0;
    const lp = rot !== 0 ? rotatePoint(x, y, ann.cx, ann.cy, -rot) : { x, y };
    const nx = (lp.x - ann.cx) / ann.rx, ny = (lp.y - ann.cy) / ann.ry;
    const nd = Math.sqrt(nx * nx + ny * ny);
    if ((ann.fillOpacity ?? 0) > 0) return nd <= 1 + HIT / Math.min(ann.rx, ann.ry);
    // stroke-only: ring check — map HIT to normalised space (use smaller semi-axis as approx)
    const hitN = HIT / Math.min(ann.rx, ann.ry);
    return Math.abs(nd - 1) <= hitN;
  }
  if (ann.kind === "rect") {
    const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
    const rot = ann.rotation ?? 0;
    // Transform point into the rect's local (unrotated) coordinate space
    const lp = rot !== 0 ? rotatePoint(x, y, rcx, rcy, -rot) : { x, y };
    const x1 = ann.x, x2 = ann.x + ann.w;
    const y1 = ann.y, y2 = ann.y + ann.h;
    const lx = lp.x, ly = lp.y;
    const filled = (ann.fillOpacity ?? 0) > 0 || (ann.fill && ann.fill !== "none");
    if (filled) {
      return lx >= x1 - HIT && lx <= x2 + HIT && ly >= y1 - HIT && ly <= y2 + HIT;
    }
    // stroke-only: hit on any of the 4 edges
    const onH = lx >= x1 - HIT && lx <= x2 + HIT;
    const onV = ly >= y1 - HIT && ly <= y2 + HIT;
    return (onH && (Math.abs(ly - y1) <= HIT || Math.abs(ly - y2) <= HIT)) ||
           (onV && (Math.abs(lx - x1) <= HIT || Math.abs(lx - x2) <= HIT));
  }
  if (ann.kind === "image") {
    // Images are always fully filled; transform into local unrotated space
    const rot = ann.rotation ?? 0;
    const rcx = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
    const lp = rot !== 0 ? rotatePoint(x, y, rcx, rcy, -rot) : { x, y };
    return lp.x >= ann.x - HIT && lp.x <= ann.x + ann.width + HIT &&
           lp.y >= ann.y - HIT && lp.y <= ann.y + ann.height + HIT;
  }
  return false;
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  size: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function renderAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
  selected: boolean,
  imageCache?: Map<string, HTMLImageElement>,
) {
  ctx.save();
  if (selected) {
    ctx.shadowColor = "rgba(59,130,246,0.8)";
    ctx.shadowBlur = 8;
  }

  if (ann.kind === "arrow") {
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ann.x1, ann.y1);
    ctx.lineTo(ann.x2, ann.y2);
    ctx.stroke();
    drawArrowhead(ctx, ann.x1, ann.y1, ann.x2, ann.y2, ann.lineWidth * 4 + 8);
  } else if (ann.kind === "line") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ann.x1, ann.y1);
    ctx.lineTo(ann.x2, ann.y2);
    ctx.stroke();
  } else if (ann.kind === "circle") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.beginPath();
    ctx.arc(ann.cx, ann.cy, ann.r, 0, Math.PI * 2);
    const circleAlpha = effectiveFillAlpha(ann);
    if (circleAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = circleAlpha;
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
  } else if (ann.kind === "ellipse") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    ctx.beginPath();
    ctx.ellipse(ann.cx, ann.cy, ann.rx, ann.ry, ann.rotation ?? 0, 0, Math.PI * 2);
    const ellipseAlpha = effectiveFillAlpha(ann);
    if (ellipseAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = ellipseAlpha;
      ctx.fillStyle = ann.color;
      ctx.fill();
      ctx.restore();
    }
    ctx.stroke();
  } else if (ann.kind === "rect") {
    ctx.strokeStyle = ann.color;
    ctx.lineWidth = ann.lineWidth;
    const rot = ann.rotation ?? 0;
    if (rot !== 0) {
      const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
      ctx.translate(rcx, rcy);
      ctx.rotate(rot);
      ctx.translate(-rcx, -rcy);
    }
    const rectAlpha = effectiveFillAlpha(ann);
    if (rectAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = rectAlpha;
      ctx.fillStyle = ann.color;
      ctx.fillRect(ann.x, ann.y, ann.w, ann.h);
      ctx.restore();
    }
    ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
  } else if (ann.kind === "text") {
    const fontStyle  = ann.italic ? "italic " : "";
    const fontWeight = ann.bold   ? "700"     : "600";
    ctx.font = `${fontStyle}${fontWeight} ${ann.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const hex = ann.color.replace("#", "");
    const ri = parseInt(hex.slice(0, 2), 16) || 0;
    const gi = parseInt(hex.slice(2, 4), 16) || 0;
    const bi = parseInt(hex.slice(4, 6), 16) || 0;
    const luminance  = (0.299 * ri + 0.587 * gi + 0.114 * bi) / 255;
    const outlineClr = luminance > 0.55 ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.7)";
    const outlineMid = luminance > 0.55 ? "rgba(0,0,0,0.5)"  : "rgba(255,255,255,0.6)";

    const lineH = ann.fontSize * 1.3;
    const lines = wrapTextLines(ctx, ann.text, ann.maxWidth ?? 0);
    const lw    = Math.max(1, ann.fontSize / 16);

    lines.forEach((line, li) => {
      const ly = ann.y + li * lineH;
      // Outline pass
      ctx.strokeStyle = outlineClr;
      ctx.lineWidth   = 2;
      ctx.strokeText(line, ann.x, ly);
      // Fill
      ctx.fillStyle = ann.color;
      ctx.fillText(line, ann.x, ly);
      // Underline / strikethrough
      if (ann.underline || ann.strikethrough) {
        const tw = ctx.measureText(line).width;
        ctx.lineCap = "butt";
        if (ann.underline) {
          const uy = ly + ann.fontSize + 2;
          ctx.strokeStyle = outlineMid; ctx.lineWidth = lw + 2;
          ctx.beginPath(); ctx.moveTo(ann.x, uy); ctx.lineTo(ann.x + tw, uy); ctx.stroke();
          ctx.strokeStyle = ann.color;  ctx.lineWidth = lw;
          ctx.beginPath(); ctx.moveTo(ann.x, uy); ctx.lineTo(ann.x + tw, uy); ctx.stroke();
        }
        if (ann.strikethrough) {
          const sy = ly + ann.fontSize * 0.56;
          ctx.strokeStyle = outlineMid; ctx.lineWidth = lw + 2;
          ctx.beginPath(); ctx.moveTo(ann.x, sy); ctx.lineTo(ann.x + tw, sy); ctx.stroke();
          ctx.strokeStyle = ann.color;  ctx.lineWidth = lw;
          ctx.beginPath(); ctx.moveTo(ann.x, sy); ctx.lineTo(ann.x + tw, sy); ctx.stroke();
        }
      }
    });
  } else if (ann.kind === "image") {
    const imgEl = imageCache?.get(ann.dataUrl);
    if (imgEl) {
      const rot    = ann.rotation ?? 0;
      const rcx    = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
      const radius = ann.borderRadius ?? 0;
      const bw     = ann.borderWidth  ?? 0;
      const alpha  = (ann.opacity ?? 100) / 100;
      const shadowBlur = ann.shadowBlur ?? 0;
      const flipH  = ann.flipH ?? false;
      const flipV  = ann.flipV ?? false;

      ctx.globalAlpha = alpha;

      if (rot !== 0 || flipH || flipV) {
        ctx.translate(rcx, rcy);
        if (rot !== 0) ctx.rotate(rot);
        if (flipH || flipV) ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.translate(-rcx, -rcy);
      }

      // Drop-shadow: fill the shape with near-transparent white while shadow is active.
      // The shadow is cast by the path shape (honouring borderRadius); the fill itself
      // is invisible because the image is drawn on top immediately after.
      if (shadowBlur > 0) {
        ctx.save();
        ctx.shadowBlur    = shadowBlur;
        ctx.shadowColor   = ann.shadowColor ?? "rgba(0,0,0,0.5)";
        ctx.shadowOffsetX = ann.shadowOffsetX ?? 4;
        ctx.shadowOffsetY = ann.shadowOffsetY ?? 4;
        ctx.fillStyle = "#000"; // fully opaque — shadow alpha ∝ fill alpha in Canvas 2D; image is drawn on top and covers this fill completely
        ctx.beginPath();
        if (radius > 0) ctx.roundRect(ann.x, ann.y, ann.width, ann.height, radius);
        else            ctx.rect(ann.x, ann.y, ann.width, ann.height);
        ctx.fill();
        ctx.restore();
      }

      // Rounded-corner clip path (applied after shadow so shadow isn't clipped)
      if (radius > 0) {
        ctx.beginPath();
        ctx.roundRect(ann.x, ann.y, ann.width, ann.height, radius);
        ctx.clip();
      }

      // Apply brightness / contrast filter (reset afterwards so it doesn't affect other drawing)
      const brightness = ann.brightness ?? 100;
      const contrast   = ann.contrast   ?? 100;
      if (brightness !== 100 || contrast !== 100) {
        ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
      }
      ctx.drawImage(imgEl, ann.x, ann.y, ann.width, ann.height);
      ctx.filter = "none";

      // Border drawn on top of the image (inside the clip)
      if (bw > 0) {
        const style = ann.borderStyle ?? "solid";
        ctx.strokeStyle = ann.borderColor ?? "#000000";
        ctx.lineWidth   = bw;
        if (style === "dashed")  ctx.setLineDash([bw * 4, bw * 2]);
        else if (style === "dotted") ctx.setLineDash([bw, bw * 1.5]);
        else ctx.setLineDash([]);
        if (radius > 0) {
          ctx.beginPath();
          ctx.roundRect(
            ann.x + bw / 2, ann.y + bw / 2,
            ann.width - bw, ann.height - bw,
            Math.max(0, radius - bw / 2),
          );
          ctx.stroke();
        } else {
          ctx.strokeRect(ann.x + bw / 2, ann.y + bw / 2, ann.width - bw, ann.height - bw);
        }
        ctx.setLineDash([]);
      }

      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// ─── Canvas expand helpers ────────────────────────────────────────────────────

const EXPAND_PX_DEFAULT = 200; // fallback / initial step size

// ── Session-persistent tool preferences ──────────────────────────────────────
const TOOL_PREFS_KEY = "annotation-tool-prefs";
function loadToolPrefs(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(TOOL_PREFS_KEY) ?? "{}"); }
  catch { return {}; }
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Resolve the effective fill alpha (0–1) for circle/ellipse/rect, handling legacy field. */
function effectiveFillAlpha(ann: CircleAnnotation | EllipseAnnotation | RectAnnotation): number {
  if (ann.fillOpacity !== undefined) return ann.fillOpacity / 100;
  if (ann.kind === "ellipse") return 0; // no legacy fill field on ellipse
  if (ann.fill === "solid") return 1;
  if (ann.fill === "semi")  return 0.4;
  return 0;
}

/** Shift all coordinates of an annotation by (dx, dy). */
function shiftAnnotation(ann: Annotation, dx: number, dy: number): Annotation {
  if (ann.kind === "arrow" || ann.kind === "line")
    return { ...ann, x1: ann.x1 + dx, y1: ann.y1 + dy, x2: ann.x2 + dx, y2: ann.y2 + dy };
  if (ann.kind === "circle")  return { ...ann, cx: ann.cx + dx, cy: ann.cy + dy };
  if (ann.kind === "ellipse") return { ...ann, cx: ann.cx + dx, cy: ann.cy + dy };
  return { ...ann, x: ann.x + dx, y: ann.y + dy }; // text, rect & image all use x/y
}

// ─── Bounding-box helper ──────────────────────────────────────────────────────

type BBox = { left: number; right: number; top: number; bottom: number; cx: number; cy: number };

function getBBox(ann: Annotation): BBox {
  if (ann.kind === "arrow" || ann.kind === "line") {
    const left = Math.min(ann.x1, ann.x2), right = Math.max(ann.x1, ann.x2);
    const top  = Math.min(ann.y1, ann.y2), bottom = Math.max(ann.y1, ann.y2);
    return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
  }
  if (ann.kind === "circle")
    return { left: ann.cx - ann.r, right: ann.cx + ann.r, top: ann.cy - ann.r, bottom: ann.cy + ann.r, cx: ann.cx, cy: ann.cy };
  if (ann.kind === "ellipse") {
    const rot = ann.rotation ?? 0;
    if (rot === 0) {
      return { left: ann.cx - ann.rx, right: ann.cx + ann.rx, top: ann.cy - ann.ry, bottom: ann.cy + ann.ry, cx: ann.cx, cy: ann.cy };
    }
    // AABB of a rotated ellipse
    const hw = Math.sqrt(ann.rx * ann.rx * Math.cos(rot) ** 2 + ann.ry * ann.ry * Math.sin(rot) ** 2);
    const hh = Math.sqrt(ann.rx * ann.rx * Math.sin(rot) ** 2 + ann.ry * ann.ry * Math.cos(rot) ** 2);
    return { left: ann.cx - hw, right: ann.cx + hw, top: ann.cy - hh, bottom: ann.cy + hh, cx: ann.cx, cy: ann.cy };
  }
  if (ann.kind === "rect") {
    const rot = ann.rotation ?? 0;
    if (rot === 0) {
      const left = Math.min(ann.x, ann.x + ann.w), right = Math.max(ann.x, ann.x + ann.w);
      const top  = Math.min(ann.y, ann.y + ann.h), bottom = Math.max(ann.y, ann.y + ann.h);
      return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
    }
    // Rotate all 4 corners and take AABB
    const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
    const corners = [
      rotatePoint(ann.x,          ann.y,          rcx, rcy, rot),
      rotatePoint(ann.x + ann.w,  ann.y,          rcx, rcy, rot),
      rotatePoint(ann.x + ann.w,  ann.y + ann.h,  rcx, rcy, rot),
      rotatePoint(ann.x,          ann.y + ann.h,  rcx, rcy, rot),
    ];
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    const left = Math.min(...xs), right = Math.max(...xs);
    const top  = Math.min(...ys), bottom = Math.max(...ys);
    return { left, right, top, bottom, cx: rcx, cy: rcy };
  }
  if (ann.kind === "image") {
    const rot = ann.rotation ?? 0;
    const rcx = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
    if (rot === 0) {
      return { left: ann.x, right: ann.x + ann.width, top: ann.y, bottom: ann.y + ann.height, cx: rcx, cy: rcy };
    }
    const corners = [
      rotatePoint(ann.x,             ann.y,              rcx, rcy, rot),
      rotatePoint(ann.x + ann.width, ann.y,              rcx, rcy, rot),
      rotatePoint(ann.x + ann.width, ann.y + ann.height, rcx, rcy, rot),
      rotatePoint(ann.x,             ann.y + ann.height, rcx, rcy, rot),
    ];
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), cx: rcx, cy: rcy };
  }
  // text
  const w = ann.maxWidth && ann.maxWidth > 0 ? ann.maxWidth : Math.max(10, ann.text.length * ann.fontSize * 0.55);
  const lineCount = ann.text.split("\n").length;
  const h = lineCount * ann.fontSize * 1.3;
  return { left: ann.x, right: ann.x + w, top: ann.y, bottom: ann.y + h, cx: ann.x + w / 2, cy: ann.y + h / 2 };
}

// ─── Multi-line text helpers ──────────────────────────────────────────────────

/** Splits text into display lines, respecting explicit \n and wrapping at maxWidth. */
function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const result: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (!maxWidth || ctx.measureText(rawLine).width <= maxWidth) {
      result.push(rawLine || " "); continue;
    }
    const words = rawLine.split(" ");
    let cur = "";
    for (const word of words) {
      const test = cur ? cur + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && cur) { result.push(cur); cur = word; }
      else { cur = test; }
    }
    result.push(cur || " ");
  }
  return result.length ? result : [" "];
}

// ─── Magic-line (alignment-guide) helper ─────────────────────────────────────

type Guide = { x1: number; y1: number; x2: number; y2: number };

/** Equal-spacing indicator drawn between two adjacent gaps (like Figma's magenta brackets). */
type SpacingGuide = {
  axis: "h" | "v";
  gap1Start: number; // e.g. right edge of A  / bottom edge of A
  gap1End:   number; // e.g. left  edge of B  / top    edge of B
  gap2Start: number; // e.g. right edge of B  / bottom edge of B
  gap2End:   number; // e.g. left  edge of M  / top    edge of M
  mid:       number; // perpendicular coord at which to draw the bracket
  snapDx: number;
  snapDy: number;
};

/** Returns visual alignment guides + snap offsets for the currently moved BBox vs all others. */
function computeGuides(movingBox: BBox, others: BBox[]): { guides: Guide[]; snapDx: number; snapDy: number } {
  const SNAP = 8;
  const guides: Guide[] = [];
  let snapDx = 0, snapDy = 0, snappedX = false, snappedY = false;
  const mXs = [movingBox.left, movingBox.cx, movingBox.right];
  const mYs = [movingBox.top,  movingBox.cy, movingBox.bottom];
  for (const other of others) {
    if (!snappedX) {
      outer: for (const mx of mXs) for (const ox of [other.left, other.cx, other.right]) {
        if (Math.abs(mx - ox) <= SNAP) {
          snapDx = ox - mx; snappedX = true;
          guides.push({ x1: ox, y1: -99999, x2: ox, y2: 99999 }); break outer;
        }
      }
    }
    if (!snappedY) {
      outer: for (const my of mYs) for (const oy of [other.top, other.cy, other.bottom]) {
        if (Math.abs(my - oy) <= SNAP) {
          snapDy = oy - my; snappedY = true;
          guides.push({ x1: -99999, y1: oy, x2: 99999, y2: oy }); break outer;
        }
      }
    }
    if (snappedX && snappedY) break;
  }
  return { guides, snapDx, snapDy };
}

/**
 * Detects equal-spacing situations: moving object's gap to its nearest neighbour
 * matches the gap between that neighbour and the next one — like Figma's magenta brackets.
 * Returns at most one guide per axis (best match).
 */
function computeSpacingGuides(movingBox: BBox, others: BBox[]): SpacingGuide[] {
  const SNAP = 10;
  const result: SpacingGuide[] = [];

  // ── Horizontal ────────────────────────────────────────────────────────────
  const byX = [...others].sort((a, b) => a.cx - b.cx);
  let bestH: { guide: SpacingGuide; diff: number } | null = null;
  for (let i = 0; i < byX.length; i++) {
    for (let j = i + 1; j < byX.length; j++) {
      const A = byX[i], B = byX[j];
      const refGap = B.left - A.right;
      if (refGap < 0) continue; // overlapping reference objects — skip

      const allTops    = [A.top,    B.top,    movingBox.top];
      const allBottoms = [A.bottom, B.bottom, movingBox.bottom];
      const mid = (Math.min(...allTops) + Math.max(...allBottoms)) / 2;

      // Moving object to the RIGHT of B
      const curGap1 = movingBox.left - B.right;
      const diff1   = Math.abs(curGap1 - refGap);
      if (diff1 <= SNAP && (!bestH || diff1 < bestH.diff)) {
        bestH = { diff: diff1, guide: {
          axis: "h",
          gap1Start: A.right,       gap1End: B.left,
          gap2Start: B.right,       gap2End: movingBox.left,
          mid,
          snapDx: refGap - curGap1, snapDy: 0,
        }};
      }

      // Moving object to the LEFT of A
      const curGap2 = A.left - movingBox.right;
      const diff2   = Math.abs(curGap2 - refGap);
      if (diff2 <= SNAP && (!bestH || diff2 < bestH.diff)) {
        bestH = { diff: diff2, guide: {
          axis: "h",
          gap1Start: movingBox.right, gap1End: A.left,
          gap2Start: A.right,         gap2End: B.left,
          mid,
          snapDx: -(refGap - curGap2), snapDy: 0,
        }};
      }
    }
  }
  if (bestH) result.push(bestH.guide);

  // ── Vertical ──────────────────────────────────────────────────────────────
  const byY = [...others].sort((a, b) => a.cy - b.cy);
  let bestV: { guide: SpacingGuide; diff: number } | null = null;
  for (let i = 0; i < byY.length; i++) {
    for (let j = i + 1; j < byY.length; j++) {
      const A = byY[i], B = byY[j];
      const refGap = B.top - A.bottom;
      if (refGap < 0) continue;

      const allLefts  = [A.left,  B.left,  movingBox.left];
      const allRights = [A.right, B.right, movingBox.right];
      const mid = (Math.min(...allLefts) + Math.max(...allRights)) / 2;

      // Moving object BELOW B
      const curGap1 = movingBox.top - B.bottom;
      const diff1   = Math.abs(curGap1 - refGap);
      if (diff1 <= SNAP && (!bestV || diff1 < bestV.diff)) {
        bestV = { diff: diff1, guide: {
          axis: "v",
          gap1Start: A.bottom,      gap1End: B.top,
          gap2Start: B.bottom,      gap2End: movingBox.top,
          mid,
          snapDx: 0, snapDy: refGap - curGap1,
        }};
      }

      // Moving object ABOVE A
      const curGap2 = A.top - movingBox.bottom;
      const diff2   = Math.abs(curGap2 - refGap);
      if (diff2 <= SNAP && (!bestV || diff2 < bestV.diff)) {
        bestV = { diff: diff2, guide: {
          axis: "v",
          gap1Start: movingBox.bottom, gap1End: A.top,
          gap2Start: A.bottom,         gap2End: B.top,
          mid,
          snapDx: 0, snapDy: -(refGap - curGap2),
        }};
      }
    }
  }
  if (bestV) result.push(bestV.guide);

  return result;
}

// ─── Smart dimension guides (equal length / width / height / radius) ─────────

/** Snap tolerance for dimension matching (canvas px). */
const DIM_SNAP = 8;

/** Marker drawn when two elements have an equal dimension (magenta, PowerPoint-style). */
type DimGuide =
  | { kind: "len"; x1: number; y1: number; x2: number; y2: number } // segment marked with double ticks at midpoint
  | { kind: "w"; left: number; right: number; y: number }           // horizontal dimension line with end caps
  | { kind: "h"; top: number; bottom: number; x: number };          // vertical dimension line with end caps

type LenRef = { v: number; x1: number; y1: number; x2: number; y2: number };
type BoxRef = { v: number; left: number; top: number; right: number; bottom: number };
type RadRef = { v: number; cx: number; cy: number };

type RefDims = { lengths: LenRef[]; widths: BoxRef[]; heights: BoxRef[]; radii: RadRef[] };

/** Extract reference dimensions from all existing annotations (except `exclude`). */
function collectRefDims(anns: Annotation[], exclude: number | null): RefDims {
  const r: RefDims = { lengths: [], widths: [], heights: [], radii: [] };
  anns.forEach((a, i) => {
    if (i === exclude) return;
    if (a.kind === "arrow" || a.kind === "line") {
      const v = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      if (v > 5) r.lengths.push({ v, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });
    } else if (a.kind === "circle") {
      r.radii.push({ v: a.r, cx: a.cx, cy: a.cy });
    } else if (a.kind === "rect") {
      const box = { left: a.x, top: a.y, right: a.x + a.w, bottom: a.y + a.h };
      r.widths.push({ v: a.w, ...box });
      r.heights.push({ v: a.h, ...box });
    } else if (a.kind === "ellipse") {
      const box = { left: a.cx - a.rx, top: a.cy - a.ry, right: a.cx + a.rx, bottom: a.cy + a.ry };
      r.widths.push({ v: a.rx * 2, ...box });
      r.heights.push({ v: a.ry * 2, ...box });
    } else if (a.kind === "image") {
      const box = { left: a.x, top: a.y, right: a.x + a.width, bottom: a.y + a.height };
      r.widths.push({ v: a.width, ...box });
      r.heights.push({ v: a.height, ...box });
    }
  });
  return r;
}

/** Nearest reference whose value is within DIM_SNAP of `value`. */
function nearestDim<T extends { v: number }>(value: number, refs: T[]): T | null {
  let best: T | null = null;
  for (const rf of refs) {
    const d = Math.abs(rf.v - value);
    if (d <= DIM_SNAP && (!best || d < Math.abs(best.v - value))) best = rf;
  }
  return best;
}

/** Snap a segment's free endpoint (x2,y2) so its length equals a reference length. */
function snapSegLen(x1: number, y1: number, x2: number, y2: number, lengths: LenRef[]):
  { x2: number; y2: number; ref: LenRef } | null {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 5) return null;
  const ref = nearestDim(len, lengths);
  if (!ref) return null;
  const s = ref.v / len;
  return { x2: x1 + (x2 - x1) * s, y2: y1 + (y2 - y1) * s, ref };
}

/** "Equal length" markers for the active segment and its reference segment. */
function segLenGuides(x1: number, y1: number, x2: number, y2: number, ref: LenRef): DimGuide[] {
  return [
    { kind: "len", x1, y1, x2, y2 },
    { kind: "len", x1: ref.x1, y1: ref.y1, x2: ref.x2, y2: ref.y2 },
  ];
}

/** "Equal radius" markers: horizontal radius segment for active + reference circle. */
function radiusGuides(cx: number, cy: number, r: number, ref: RadRef): DimGuide[] {
  return [
    { kind: "len", x1: cx, y1: cy, x2: cx + r, y2: cy },
    { kind: "len", x1: ref.cx, y1: ref.cy, x2: ref.cx + ref.v, y2: ref.cy },
  ];
}

/** "Equal width" dimension lines under the active box and the reference box. */
function widthGuides(box: { left: number; right: number; bottom: number }, ref: BoxRef): DimGuide[] {
  return [
    { kind: "w", left: box.left, right: box.right, y: box.bottom + 8 },
    { kind: "w", left: ref.left, right: ref.right, y: ref.bottom + 8 },
  ];
}

/** "Equal height" dimension lines right of the active box and the reference box. */
function heightGuides(box: { top: number; bottom: number; right: number }, ref: BoxRef): DimGuide[] {
  return [
    { kind: "h", top: box.top, bottom: box.bottom, x: box.right + 8 },
    { kind: "h", top: ref.top, bottom: ref.bottom, x: ref.right + 8 },
  ];
}

// ─── Handle constants & rendering ─────────────────────────────────────────────

const HANDLE_HIT = 13; // hit-test radius in canvas pixels
const HANDLE_R   = 8;  // drawn radius for arrow / rotation handles
const HANDLE_SZ  = 7;  // half-size of resize knobs (circle & rect)

/** Returns the resize knob position for a circle (east edge). */
function circleResizeHandle(ann: CircleAnnotation): { hx: number; hy: number } {
  const d = ann.r / Math.SQRT2; // cos(45°) = sin(45°) = 1/√2
  return { hx: ann.cx + d, hy: ann.cy + d };
}

const ROTATION_HANDLE_DIST = 30; // pixels from shape edge to rotation handle
/** Draw interactive handles on top of a selected arrow, circle, or rect. */
function renderHandles(ctx: CanvasRenderingContext2D, ann: Annotation) {
  ctx.save();
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth   = 2.5;
  ctx.fillStyle   = "white";
  // Drop shadow so handles stand out against dark imagery
  ctx.shadowColor   = "rgba(0,0,0,0.45)";
  ctx.shadowBlur    = 5;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1.5;

  if (ann.kind === "arrow" || ann.kind === "line") {
    for (const [hx, hy] of [[ann.x1, ann.y1], [ann.x2, ann.y2]] as [number, number][]) {
      ctx.beginPath();
      ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (ann.kind === "circle") {
    const { hx, hy } = circleResizeHandle(ann);
    ctx.beginPath();
    ctx.rect(hx - HANDLE_SZ, hy - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2);
    ctx.fill();
    ctx.stroke();
  } else if (ann.kind === "ellipse") {
    // Resize handle: rotated bottom-right corner of bounding box
    const rot = ann.rotation ?? 0;
    const rhp = rotatePoint(ann.cx + ann.rx, ann.cy + ann.ry, ann.cx, ann.cy, rot);
    ctx.beginPath();
    ctx.rect(rhp.x - HANDLE_SZ, rhp.y - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2);
    ctx.fill();
    ctx.stroke();
    // Rotation handle
    const { hx, hy, lx, ly } = rotationHandlePos(ann);
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.6)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Rotation arc indicator inside the circle
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "transparent";
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R * 0.55, 0.2, Math.PI * 1.7);
    ctx.stroke();
    ctx.restore();
  } else if (ann.kind === "rect") {
    // Resize handle: rotated bottom-right corner
    const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
    const rot = ann.rotation ?? 0;
    const rhp = rotatePoint(ann.x + ann.w, ann.y + ann.h, rcx, rcy, rot);
    ctx.beginPath();
    ctx.rect(rhp.x - HANDLE_SZ, rhp.y - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2);
    ctx.fill();
    ctx.stroke();
    // Rotation handle
    const { hx, hy, lx, ly } = rotationHandlePos(ann);
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.6)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Rotation arc indicator inside the circle
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "transparent";
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R * 0.55, 0.2, Math.PI * 1.7);
    ctx.stroke();
    ctx.restore();
  } else if (ann.kind === "text") {
    const bb = getBBox(ann);
    // Subtle right-edge guide line
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(bb.right, bb.top - 4); ctx.lineTo(bb.right, bb.bottom + 4);
    ctx.stroke();
    ctx.restore();
    // Right-center resize handle (↔ width)
    ctx.beginPath();
    ctx.rect(bb.right - HANDLE_SZ, bb.cy - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2);
    ctx.fill();
    ctx.stroke();
  } else if (ann.kind === "image") {
    // Resize handle: rotated bottom-right corner
    const rcx = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
    const rot = ann.rotation ?? 0;
    const rhp = rotatePoint(ann.x + ann.width, ann.y + ann.height, rcx, rcy, rot);
    ctx.beginPath();
    ctx.rect(rhp.x - HANDLE_SZ, rhp.y - HANDLE_SZ, HANDLE_SZ * 2, HANDLE_SZ * 2);
    ctx.fill();
    ctx.stroke();
    // Rotation handle
    const { hx, hy, lx, ly } = imageRotHandlePos(ann);
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.6)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "transparent";
    ctx.beginPath();
    ctx.arc(hx, hy, HANDLE_R * 0.55, 0.2, Math.PI * 1.7);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/** True if (x,y) is within HANDLE_HIT pixels of (hx,hy). */
function nearPoint(x: number, y: number, hx: number, hy: number): boolean {
  return Math.hypot(x - hx, y - hy) <= HANDLE_HIT;
}

// ─── Component ───────────────────────────────────────────────────────────────

interface ImageAnnotationDialogProps {
  open: boolean;
  imageUrl: string;
  initialAnnotations?: Annotation[] | null;
  /** Previously-persisted canvas expansion offsets; restored on re-open. */
  initialCanvasOffsets?: CanvasOffsets | null;
  onSave: (blob: Blob, annotations: Annotation[], canvasOffsets: CanvasOffsets) => Promise<void>;
  onClose: () => void;
  /**
   * Optional help assets (tutorial video / host-app screenshot). When omitted,
   * the corresponding help tabs and the video-tutorial hint are hidden.
   */
  helpAssets?: AnnotationHelpAssets;
}

// ─── Reusable slider + number-input combo ─────────────────────────────────────
// Defined at module level so React sees a stable component identity across re-renders.
// If it were defined inside the parent render function, React would unmount/remount
// the inputs on every render cycle, causing sliders to "stutter" while dragging.
function SliderNum({
  label, min, max, step = 1, value, unit = "",
  onChange,
}: {
  label: string; min: number; max: number; step?: number;
  value: number; unit?: string;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="flex items-center gap-1 border rounded px-2 h-7 bg-background text-xs shrink-0" title={label}>
      <span className="text-muted-foreground select-none shrink-0">{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-12 h-1.5 accent-primary cursor-pointer"
      />
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
        onWheel={(e) => { e.preventDefault(); onChange(clamp(value + (e.deltaY < 0 ? step : -step))); }}
        className="w-9 text-xs text-right tabular-nums bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary rounded px-0.5 text-muted-foreground"
      />
      {unit && <span className="text-muted-foreground select-none -ml-1">{unit}</span>}
    </div>
  );
}

export function ImageAnnotationDialog({
  open,
  imageUrl,
  initialAnnotations,
  initialCanvasOffsets,
  onSave,
  onClose,
  helpAssets,
}: ImageAnnotationDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** Cache of dataUrl → HTMLImageElement for image annotations */
  const imageElemCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  /** Stable pointer to latest redraw — used by async image-load callbacks */
  const redrawRef = useRef<() => void>(() => {});
  /** Hidden file input for toolbar "insert image" button */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // ── Undo / Redo history ───────────────────────────────────────────────────────
  const undoStackRef    = useRef<Annotation[][]>([]);
  const redoStackRef    = useRef<Annotation[][]>([]);
  const annotationsRef  = useRef<Annotation[]>([]);   // always-current mirror for history helpers
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Parallel canvas-offset history so crop can be undone/redone
  type OffsetSnap = { ox: number; oy: number; pr: number; pb: number };
  const canvasOffsetHistoryRef = useRef<OffsetSnap[]>([]);
  const canvasOffsetRedoRef    = useRef<OffsetSnap[]>([]);
  const canvasOffsetXRef         = useRef(0);
  const canvasOffsetYRef         = useRef(0);
  const canvasPaddingRightRef    = useRef(0);
  const canvasPaddingBottomRef   = useRef(0);

  // Keep annotationsRef and canvas-offset refs in sync
  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);

  /** Call BEFORE any mutation to snapshot the current state onto the undo stack. */
  function pushHistory() {
    undoStackRef.current = [...undoStackRef.current.slice(-49), [...annotationsRef.current]];
    canvasOffsetHistoryRef.current = [...canvasOffsetHistoryRef.current.slice(-49), {
      ox: canvasOffsetXRef.current, oy: canvasOffsetYRef.current,
      pr: canvasPaddingRightRef.current, pb: canvasPaddingBottomRef.current,
    }];
    redoStackRef.current = [];
    canvasOffsetRedoRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }
  // ── Crop tool state ──────────────────────────────────────────────────────────
  const [cropRect, setCropRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  type CropHandle = "nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w";
  type CropHit    = CropHandle | "move";
  type CropDragState =
    | { kind: "draw";   startX: number; startY: number }
    | { kind: "move";   startX: number; startY: number; origRect: { x1: number; y1: number; x2: number; y2: number } }
    | { kind: "resize"; handle: CropHandle; startX: number; startY: number; origRect: { x1: number; y1: number; x2: number; y2: number } };
  const cropDragRef    = useRef<CropDragState | null>(null);
  const [cropHitArea, setCropHitArea] = useState<CropHit | null>(null);

  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [guides,        setGuides]        = useState<Guide[]>([]);
  const [spacingGuides, setSpacingGuides] = useState<SpacingGuide[]>([]);
  const [dimGuides,     setDimGuides]     = useState<DimGuide[]>([]);
  // Convenience: the one selected item when exactly one is selected; null otherwise.
  const selectedIndex = selectedIndices.length === 1 ? selectedIndices[0] : null;
  function setSelectedIndex(i: number | null) { setSelectedIndices(i != null ? [i] : []); }
  const [tool, setTool] = useState<Tool>("select");
  // imageCropMode: true when crop tool is active AND exactly one image annotation is selected.
  // In this mode the crop rect is constrained to that image and applies to its dataUrl.
  const cropTargetAnn  = (tool === "crop" && selectedIndices.length === 1
    ? annotations[selectedIndices[0]]
    : null) as ImageAnnotation | null;
  const imageCropMode = cropTargetAnn?.kind === "image";
  const [color, setColor] = useState(() => { const p = loadToolPrefs(); return str(p.color, "#000000"); });
  const [lineWidth, setLineWidth] = useState(() => { const p = loadToolPrefs(); return num(p.lineWidth, 1); });
  const [fontSize, setFontSize] = useState(() => { const p = loadToolPrefs(); return num(p.fontSize, 20); });
  const [fillOpacity, setFillOpacity] = useState(() => { const p = loadToolPrefs(); return num(p.fillOpacity, 0); }); // 0 = no fill, 1-100 = opacity %
  // Text formatting state
  const [textBold,          setTextBold]          = useState(() => { const p = loadToolPrefs(); return bool(p.textBold, false); });
  const [textItalic,        setTextItalic]        = useState(() => { const p = loadToolPrefs(); return bool(p.textItalic, false); });
  const [textUnderline,     setTextUnderline]     = useState(() => { const p = loadToolPrefs(); return bool(p.textUnderline, false); });
  const [textStrikethrough, setTextStrikethrough] = useState(() => { const p = loadToolPrefs(); return bool(p.textStrikethrough, false); });
  const [saving, setSaving] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpSeen, setHelpSeen] = useState(() => localStorage.getItem("annotation-help-seen") === "1");
  const [videoHintDismissed, setVideoHintDismissed] = useState(
    () => localStorage.getItem("annotation-video-hint-seen") === "1",
  );
  const dismissVideoHint = () => {
    setVideoHintDismissed(true);
    localStorage.setItem("annotation-video-hint-seen", "1");
  };
  const markHelpSeen = () => {
    if (!helpSeen) {
      setHelpSeen(true);
      localStorage.setItem("annotation-help-seen", "1");
    }
  };

  // Text input overlay (also used for editing existing text annotations)
  const [textInput, setTextInput] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);

  // Drag state
  const dragRef = useRef<{
    kind: "draw" | "move" | "handle";
    startX: number; startY: number;
    annIndex?: number;
    origX?: number; origY?: number;
    origX2?: number; origY2?: number;
    /** Which handle is being dragged (arrow endpoint or circle resize knob) */
    handle?: "start" | "end" | "resize" | "rotate";
    /** Original circle radius at drag start */
    origR?: number;
    /** Original circle/ellipse/rect centre at drag start (also rotation pivot) */
    origCx?: number; origCy?: number;
    /** Snapshot of annotation at drag-start — used for Ctrl+drag copy */
    origAnn?: Annotation;
    /** Snapshots of ALL selected annotations at drag-start — used for multi-select group move */
    origAnns?: Map<number, Annotation>;
  } | null>(null);

  /** Which handle type the pointer is hovering over — drives the cursor style */
  const [overHandle, setOverHandle] = useState<"endpoint" | "resize" | "text-resize" | "rotate" | false>(false);
  /** true while the pointer hovers over an annotation body → shows move cursor */
  const [overBody, setOverBody] = useState(false);

  // ── Zoom / Pan ────────────────────────────────────────────────────────────────
  const [zoom, setZoom]       = useState(1.0);
  const zoomRef               = useRef(1.0);  // sync mirror for wheel-handler closure
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  const viewportRef           = useRef<HTMLDivElement>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const spacePanningRef       = useRef(false);

  // ── Smart-duplicate offset (PowerPoint-style) ─────────────────────────────
  // lastDuplOffsetRef: the Δx/Δy applied by the next Ctrl+D / duplicate button.
  // Starts at the default nudge; updated whenever the user moves a freshly-made
  // copy, so consecutive Ctrl+Ds produce evenly-spaced results.
  const lastDuplOffsetRef  = useRef<{ dx: number; dy: number }>({ dx: 15, dy: 15 });
  // pendingDuplRef: set right after a duplication; cleared once the user moves
  // the freshly-created copies (so we can learn the intended spacing).
  const pendingDuplRef     = useRef<{ indices: number[] } | null>(null);
  // Reactive display value for the tooltip — null = using the default 15/15.
  const [smartDuplOffset, setSmartDuplOffset] = useState<{ dx: number; dy: number } | null>(null);

  /** Reset smart-duplicate state back to the default nudge (call on undo/redo/etc.) */
  function resetDuplOffset() {
    lastDuplOffsetRef.current = { dx: 15, dy: 15 };
    pendingDuplRef.current    = null;
    setSmartDuplOffset(null);
  }
  const panDragRef            = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  // ── Canvas padding (extra whitespace added around the image) ─────────────────
  const [canvasOffsetX, setCanvasOffsetX] = useState(0); // left padding  → shifts image right
  const [canvasOffsetY, setCanvasOffsetY] = useState(0); // top padding   → shifts image down
  const [canvasPaddingRight,  setCanvasPaddingRight]  = useState(0);
  const [canvasPaddingBottom, setCanvasPaddingBottom] = useState(0);
  // Keep offset refs in sync for use in pushHistory() closures
  useEffect(() => { canvasOffsetXRef.current       = canvasOffsetX;       }, [canvasOffsetX]);
  useEffect(() => { canvasOffsetYRef.current        = canvasOffsetY;        }, [canvasOffsetY]);
  useEffect(() => { canvasPaddingRightRef.current   = canvasPaddingRight;   }, [canvasPaddingRight]);
  useEffect(() => { canvasPaddingBottomRef.current  = canvasPaddingBottom;  }, [canvasPaddingBottom]);

  const [preview, setPreview] = useState<Annotation | null>(null);

  // ── Image annotation style state ─────────────────────────────────────────────
  const [imgOpacity,      setImgOpacity]      = useState(() => { const p = loadToolPrefs(); return num(p.imgOpacity,      100); });
  const [imgBorderWidth,  setImgBorderWidth]  = useState(() => { const p = loadToolPrefs(); return num(p.imgBorderWidth,  0);   });
  const [imgBorderColor,  setImgBorderColor]  = useState(() => { const p = loadToolPrefs(); return str(p.imgBorderColor,  "#000000"); });
  const [imgBorderStyle,  setImgBorderStyle]  = useState<"solid" | "dashed" | "dotted">(() => { const p = loadToolPrefs(); const v = p.imgBorderStyle; return (v === "solid" || v === "dashed" || v === "dotted") ? v : "solid"; });
  const [imgBorderRadius, setImgBorderRadius] = useState(() => { const p = loadToolPrefs(); return num(p.imgBorderRadius, 0);   });
  const [imgShadowOn,     setImgShadowOn]     = useState(() => { const p = loadToolPrefs(); return bool(p.imgShadowOn,    false); });
  const [imgShadowBlur,   setImgShadowBlur]   = useState(() => { const p = loadToolPrefs(); return num(p.imgShadowBlur,   8);   });
  const [imgShadowColor,  setImgShadowColor]  = useState(() => { const p = loadToolPrefs(); return str(p.imgShadowColor,  "#000000"); });
  const [imgShadowAlpha,  setImgShadowAlpha]  = useState(() => { const p = loadToolPrefs(); return num(p.imgShadowAlpha,  50);  }); // 0-100
  const [imgShadowX,      setImgShadowX]      = useState(() => { const p = loadToolPrefs(); return num(p.imgShadowX,      4);   });
  const [imgShadowY,      setImgShadowY]      = useState(() => { const p = loadToolPrefs(); return num(p.imgShadowY,      4);   });
  const [imgFlipH,        setImgFlipH]        = useState(() => { const p = loadToolPrefs(); return bool(p.imgFlipH,       false); });
  const [imgFlipV,        setImgFlipV]        = useState(() => { const p = loadToolPrefs(); return bool(p.imgFlipV,       false); });
  const [imgBrightness,   setImgBrightness]   = useState(() => { const p = loadToolPrefs(); return num(p.imgBrightness,   100); }); // 50–150 %
  const [imgContrast,     setImgContrast]     = useState(() => { const p = loadToolPrefs(); return num(p.imgContrast,     100); });

  // ── Persist tool preferences across dialog opens ─────────────────────────────
  useEffect(() => {
    localStorage.setItem(TOOL_PREFS_KEY, JSON.stringify({
      color, lineWidth, fontSize, fillOpacity,
      textBold, textItalic, textUnderline, textStrikethrough,
      imgOpacity, imgBorderWidth, imgBorderColor, imgBorderStyle, imgBorderRadius,
      imgShadowOn, imgShadowBlur, imgShadowColor, imgShadowAlpha, imgShadowX, imgShadowY,
      imgFlipH, imgFlipV, imgBrightness, imgContrast,
    }));
  }, [color, lineWidth, fontSize, fillOpacity,
      textBold, textItalic, textUnderline, textStrikethrough,
      imgOpacity, imgBorderWidth, imgBorderColor, imgBorderStyle, imgBorderRadius,
      imgShadowOn, imgShadowBlur, imgShadowColor, imgShadowAlpha, imgShadowX, imgShadowY,
      imgFlipH, imgFlipV, imgBrightness, imgContrast]);

  // ── Canvas expand step size ──────────────────────────────────────────────────
  const [expandPx, setExpandPx] = useState(EXPAND_PX_DEFAULT);

  // ── Zoom / Pan helpers ────────────────────────────────────────────────────────

  const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

  function applyZoom(next: number, pivotX?: number, pivotY?: number) {
    const vp = viewportRef.current;
    next = Math.min(4, Math.max(0.1, next));
    const prev = zoomRef.current;
    setZoom(next);
    zoomRef.current = next;
    if (vp && pivotX !== undefined && pivotY !== undefined) {
      requestAnimationFrame(() => {
        vp.scrollLeft = (vp.scrollLeft + pivotX) * (next / prev) - pivotX;
        vp.scrollTop  = (vp.scrollTop  + pivotY) * (next / prev) - pivotY;
      });
    }
  }

  function zoomIn()  { const i = ZOOM_STEPS.findIndex(z => z > zoomRef.current); applyZoom(i >= 0 ? ZOOM_STEPS[i] : 4); }
  function zoomOut() { const i = [...ZOOM_STEPS].reverse().findIndex(z => z < zoomRef.current); applyZoom(i >= 0 ? [...ZOOM_STEPS].reverse()[i] : 0.1); }

  function fitZoom() {
    const vp  = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img) return;
    const baseW = (img.naturalWidth  + canvasOffsetX + canvasPaddingRight)  * 1.5;
    const baseH = (img.naturalHeight + canvasOffsetY + canvasPaddingBottom) * 1.5;
    const z = Math.min((vp.clientWidth - 20) / baseW, (vp.clientHeight - 20) / baseH, 1);
    applyZoom(Math.max(0.1, z));
    requestAnimationFrame(() => { if (vp) { vp.scrollLeft = 0; vp.scrollTop = 0; } });
  }

  // Non-passive wheel handler for Ctrl+Scroll zoom-to-cursor
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || !open) return;
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = vp!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), px, py);
    }
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, imgLoaded]);

  // ── Auto-fit when image finishes loading ─────────────────────────────────────
  useEffect(() => {
    if (!imgLoaded || !open) return;
    // Two rAF frames: first lets the canvas resize/render, second lets the
    // viewport report its final clientWidth/clientHeight before we measure.
    requestAnimationFrame(() => requestAnimationFrame(() => fitZoom()));
  // fitZoom is stable (defined in render scope); open/imgLoaded are the triggers
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgLoaded, open]);

  // ── Load image ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setAnnotations(initialAnnotations ? [...initialAnnotations] : []);
    setSelectedIndex(null);
    setPreview(null);
    setTextInput(null);
    setImgLoaded(false);
    setImgError(false);
    dragRef.current = null;
    panDragRef.current = null;
    spacePanningRef.current = false;
    setSpaceDown(false);
    setZoom(1);
    zoomRef.current = 1;
    // Restore persisted canvas offsets, or reset to 0 for a fresh image.
    setCanvasOffsetX(initialCanvasOffsets?.x ?? 0);
    setCanvasOffsetY(initialCanvasOffsets?.y ?? 0);
    setCanvasPaddingRight(initialCanvasOffsets?.right ?? 0);
    setCanvasPaddingBottom(initialCanvasOffsets?.bottom ?? 0);
    // Reset crop state
    setCropRect(null);
    cropDragRef.current = null;
    // Reset drawing tool state so the displayed values always match what gets drawn
    setTool("select");
    setLineWidth(1);
    setColor("#000000");
    setFillOpacity(0);
    setTextBold(false);
    setTextItalic(false);
    setTextUnderline(false);
    setTextStrikethrough(false);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.onerror = () => {
      // Try without crossOrigin (some proxied images may refuse the header)
      const img2 = new Image();
      img2.onload = () => {
        imgRef.current = img2;
        setImgLoaded(true);
      };
      img2.onerror = () => setImgError(true);
      img2.src = imageUrl;
    };
    img.src = imageUrl;

    // Pre-load any image annotations from initialAnnotations into the cache
    (initialAnnotations ?? []).forEach(ann => {
      if (ann.kind === "image") {
        const dataUrl = ann.dataUrl;
        if (!imageElemCacheRef.current.has(dataUrl)) {
          const el = new Image();
          el.onload = () => { imageElemCacheRef.current.set(dataUrl, el); redrawRef.current(); };
          el.src = dataUrl;
        }
      }
    });
  }, [open, imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Redraw ──────────────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Resize canvas to include any added padding
    const w = img.naturalWidth  + canvasOffsetX + canvasPaddingRight;
    const h = img.naturalHeight + canvasOffsetY + canvasPaddingBottom;
    canvas.width  = w;
    canvas.height = h;

    // White background for the padded area
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // Draw image at offset so left/top padding shows as white space
    ctx.drawImage(img, canvasOffsetX, canvasOffsetY);

    const imgCache = imageElemCacheRef.current;
    annotations.forEach((ann, i) => renderAnnotation(ctx, ann, selectedIndices.includes(i), imgCache));
    if (preview) renderAnnotation(ctx, preview, false, imgCache);

    // ── UI-only selection / discoverability indicators (not in exported canvas) ──
    const PAD = 5;
    annotations.forEach((ann, i) => {
      const isSel = selectedIndices.includes(i);
      const bb    = getBBox(ann);
      ctx.save();
      ctx.shadowBlur = 0;

      if (!isSel && ann.kind === "text") {
        // Faint dashed outline so text blocks are visible when not selected
        ctx.strokeStyle = "rgba(120,120,120,0.28)";
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(bb.left - 3, bb.top - 3, bb.right - bb.left + 6, bb.bottom - bb.top + 6);
      }

      if (isSel) {
        // Semi-transparent blue fill tint
        ctx.fillStyle = "rgba(59,130,246,0.10)";
        ctx.fillRect(bb.left - PAD, bb.top - PAD, bb.right - bb.left + PAD * 2, bb.bottom - bb.top + PAD * 2);
        // Solid blue dashed border
        ctx.strokeStyle = "rgba(59,130,246,0.95)";
        ctx.lineWidth   = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(bb.left - PAD, bb.top - PAD, bb.right - bb.left + PAD * 2, bb.bottom - bb.top + PAD * 2);
      }

      ctx.restore();
    });

    // Group bounding box when 2+ items are selected
    if (selectedIndices.length > 1) {
      const boxes   = selectedIndices.filter(i => annotations[i]).map(i => getBBox(annotations[i]));
      const gLeft   = Math.min(...boxes.map(b => b.left));
      const gTop    = Math.min(...boxes.map(b => b.top));
      const gRight  = Math.max(...boxes.map(b => b.right));
      const gBottom = Math.max(...boxes.map(b => b.bottom));
      const GP = 14;
      ctx.save();
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = "rgba(59,130,246,0.45)";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([7, 5]);
      ctx.strokeRect(gLeft - GP, gTop - GP, gRight - gLeft + GP * 2, gBottom - gTop + GP * 2);
      ctx.restore();
    }

    // Handles only when exactly one annotation is selected
    if (selectedIndex != null && annotations[selectedIndex]) {
      renderHandles(ctx, annotations[selectedIndex]);
    }
    // Alignment guides (blue dashed lines)
    if (guides.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.65;
      for (const g of guides) {
        ctx.beginPath();
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Equal-spacing guides (magenta brackets — like Figma)
    if (spacingGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#e91e63";
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      const CAP = 5; // half-length of the perpendicular end-cap tick
      for (const sg of spacingGuides) {
        if (sg.axis === "h") {
          const y = sg.mid;
          // gap 1
          ctx.beginPath(); ctx.moveTo(sg.gap1Start, y); ctx.lineTo(sg.gap1End, y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sg.gap1Start, y - CAP); ctx.lineTo(sg.gap1Start, y + CAP); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sg.gap1End,   y - CAP); ctx.lineTo(sg.gap1End,   y + CAP); ctx.stroke();
          // gap 2
          ctx.beginPath(); ctx.moveTo(sg.gap2Start, y); ctx.lineTo(sg.gap2End, y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sg.gap2Start, y - CAP); ctx.lineTo(sg.gap2Start, y + CAP); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(sg.gap2End,   y - CAP); ctx.lineTo(sg.gap2End,   y + CAP); ctx.stroke();
        } else {
          const x = sg.mid;
          // gap 1
          ctx.beginPath(); ctx.moveTo(x, sg.gap1Start); ctx.lineTo(x, sg.gap1End); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - CAP, sg.gap1Start); ctx.lineTo(x + CAP, sg.gap1Start); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - CAP, sg.gap1End);   ctx.lineTo(x + CAP, sg.gap1End);   ctx.stroke();
          // gap 2
          ctx.beginPath(); ctx.moveTo(x, sg.gap2Start); ctx.lineTo(x, sg.gap2End); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - CAP, sg.gap2Start); ctx.lineTo(x + CAP, sg.gap2Start); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - CAP, sg.gap2End);   ctx.lineTo(x + CAP, sg.gap2End);   ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Equal-dimension markers (magenta — like PowerPoint's "same size" indicators)
    if (dimGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = "#e91e63";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.9;
      const CAP = 5;
      for (const g of dimGuides) {
        if (g.kind === "len") {
          // Double tick marks perpendicular to the segment, at its midpoint
          const mx = (g.x1 + g.x2) / 2, my = (g.y1 + g.y2) / 2;
          const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
          const ux = (g.x2 - g.x1) / len, uy = (g.y2 - g.y1) / len; // along
          const px = -uy, py = ux;                                  // perpendicular
          const T = 7;   // tick half-length
          const S = 3;   // spacing between the two ticks
          for (const off of [-S, S]) {
            const cx = mx + ux * off, cy = my + uy * off;
            ctx.beginPath();
            ctx.moveTo(cx - px * T, cy - py * T);
            ctx.lineTo(cx + px * T, cy + py * T);
            ctx.stroke();
          }
        } else if (g.kind === "w") {
          ctx.beginPath(); ctx.moveTo(g.left, g.y); ctx.lineTo(g.right, g.y); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.left,  g.y - CAP); ctx.lineTo(g.left,  g.y + CAP); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.right, g.y - CAP); ctx.lineTo(g.right, g.y + CAP); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.moveTo(g.x, g.top); ctx.lineTo(g.x, g.bottom); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.x - CAP, g.top);    ctx.lineTo(g.x + CAP, g.top);    ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.x - CAP, g.bottom); ctx.lineTo(g.x + CAP, g.bottom); ctx.stroke();
        }
      }
      ctx.restore();
    }
    // ── Crop-tool overlay (UI-only, not exported) ──────────────────────────────
    if (cropRect || imageCropMode) {
      const cW = img.naturalWidth  + canvasOffsetX + canvasPaddingRight;
      const cH = img.naturalHeight + canvasOffsetY + canvasPaddingBottom;

      ctx.save();
      ctx.shadowBlur = 0;

      // In image-crop mode: dim everything outside the target image annotation.
      // For rotated images use the AABB as an approximation for the dim region;
      // the amber outline is drawn in the image's rotated coordinate frame.
      if (imageCropMode && cropTargetAnn) {
        const ia = cropTargetAnn;
        const iaRot = ia.rotation ?? 0;
        if (iaRot === 0) {
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(0,              0,              cW,                    ia.y);
          ctx.fillRect(0,              ia.y + ia.height, cW,                  cH - ia.y - ia.height);
          ctx.fillRect(0,              ia.y,            ia.x,                 ia.height);
          ctx.fillRect(ia.x + ia.width, ia.y,           cW - ia.x - ia.width, ia.height);
        } else {
          // Dim the whole canvas and let the rotated clip punch out the image area
          const iaBB  = getBBox(ia);
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(0, 0, cW, iaBB.top);
          ctx.fillRect(0, iaBB.bottom, cW, cH - iaBB.bottom);
          ctx.fillRect(0, iaBB.top, iaBB.left, iaBB.bottom - iaBB.top);
          ctx.fillRect(iaBB.right, iaBB.top, cW - iaBB.right, iaBB.bottom - iaBB.top);
        }
        // Amber dashed border — drawn in the image's rotated frame
        ctx.save();
        const iaRot2 = ia.rotation ?? 0;
        if (iaRot2 !== 0) {
          const icx = ia.x + ia.width / 2, icy = ia.y + ia.height / 2;
          ctx.translate(icx, icy); ctx.rotate(iaRot2); ctx.translate(-icx, -icy);
        }
        ctx.strokeStyle = "#f59e0b";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(ia.x, ia.y, ia.width, ia.height);
        ctx.setLineDash([]);
        ctx.restore();
      }

      if (!cropRect) { ctx.restore(); return; }
      const x1 = Math.min(cropRect.x1, cropRect.x2);
      const y1 = Math.min(cropRect.y1, cropRect.y2);
      const x2 = Math.max(cropRect.x1, cropRect.x2);
      const y2 = Math.max(cropRect.y1, cropRect.y2);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

      // For a rotated image annotation the crop rect is tracked in "unrotated crop space"
      // (the image's local frame).  Rotate the canvas context so the overlay sits correctly.
      const cropRot = (imageCropMode && cropTargetAnn) ? (cropTargetAnn.rotation ?? 0) : 0;
      if (cropRot !== 0 && cropTargetAnn) {
        const icx = cropTargetAnn.x + cropTargetAnn.width  / 2;
        const icy = cropTargetAnn.y + cropTargetAnn.height / 2;
        ctx.translate(icx, icy); ctx.rotate(cropRot); ctx.translate(-icx, -icy);
      }

      if (!imageCropMode) {
        // Canvas-crop: dim outside the crop rect (full canvas)
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(0,  0,  cW,       y1);
        ctx.fillRect(0,  y2, cW,       cH - y2);
        ctx.fillRect(0,  y1, x1,       y2 - y1);
        ctx.fillRect(x2, y1, cW - x2,  y2 - y1);
      } else if (cropTargetAnn) {
        // Image-crop: dim the image area outside the crop rect
        const ia = cropTargetAnn;
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(ia.x,            ia.y,            ia.width,             y1 - ia.y);
        ctx.fillRect(ia.x,            y2,              ia.width,             ia.y + ia.height - y2);
        ctx.fillRect(ia.x,            y1,              x1 - ia.x,           y2 - y1);
        ctx.fillRect(x2,              y1,              ia.x + ia.width - x2, y2 - y1);
      }

      // Dashed border around the crop rect
      ctx.strokeStyle = imageCropMode ? "#f59e0b" : "#fff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      // Rule-of-thirds grid (faint)
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      const gW = (x2 - x1) / 3, gH = (y2 - y1) / 3;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(x1 + gW * i, y1); ctx.lineTo(x1 + gW * i, y2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1 + gH * i); ctx.lineTo(x2, y1 + gH * i); ctx.stroke();
      }
      // Resize handles — 8 white squares at corners + edge midpoints
      const HR = 5; // handle half-size in canvas px
      const handles = [
        { hx: x1, hy: y1 }, { hx: mx, hy: y1 }, { hx: x2, hy: y1 },
        { hx: x2, hy: my }, { hx: x2, hy: y2 }, { hx: mx, hy: y2 },
        { hx: x1, hy: y2 }, { hx: x1, hy: my },
      ];
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1;
      for (const { hx, hy } of handles) {
        ctx.fillRect(hx - HR, hy - HR, HR * 2, HR * 2);
        ctx.strokeRect(hx - HR, hy - HR, HR * 2, HR * 2);
      }
      ctx.restore();
    }
  }, [annotations, selectedIndices, guides, spacingGuides, dimGuides, preview, imgLoaded,
      canvasOffsetX, canvasOffsetY, canvasPaddingRight, canvasPaddingBottom, cropRect,
      imageCropMode, cropTargetAnn]);

  // Keep redrawRef pointing at the latest redraw so async callbacks (image load) can call it
  useEffect(() => { redrawRef.current = redraw; }, [redraw]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  // ── Unsaved-changes guard ─────────────────────────────────────────────────────

  function hasChanges(): boolean {
    if (canvasOffsetX !== 0 || canvasOffsetY !== 0 || canvasPaddingRight !== 0 || canvasPaddingBottom !== 0) return true;
    const initial = initialAnnotations ?? [];
    if (annotations.length !== initial.length) return true;
    return JSON.stringify(annotations) !== JSON.stringify(initial);
  }

  // ── Canvas expand ─────────────────────────────────────────────────────────────


  function addPadding(side: "left" | "top" | "right" | "bottom") {
    const px = expandPx;
    if (side === "left") {
      setCanvasOffsetX(prev => prev + px);
      setAnnotations(prev => prev.map(ann => shiftAnnotation(ann, px, 0)));
    } else if (side === "top") {
      setCanvasOffsetY(prev => prev + px);
      setAnnotations(prev => prev.map(ann => shiftAnnotation(ann, 0, px)));
    } else if (side === "right") {
      setCanvasPaddingRight(prev => prev + px);
    } else {
      setCanvasPaddingBottom(prev => prev + px);
    }
  }

  /** Shrink the canvas to the tightest rect that encloses the image and every annotation. */
  function trimCanvas() {
    const img = imgRef.current;
    if (!img) return;
    pushHistory();

    // Start with the image boundary
    let minX = canvasOffsetX;
    let minY = canvasOffsetY;
    let maxX = canvasOffsetX + img.naturalWidth;
    let maxY = canvasOffsetY + img.naturalHeight;

    // Expand to cover every annotation (incl. half-stroke on each side)
    for (const ann of annotations) {
      const bb   = getBBox(ann);
      const half = ("lineWidth" in ann ? (ann as { lineWidth: number }).lineWidth : 0) / 2;
      minX = Math.min(minX, bb.left  - half);
      minY = Math.min(minY, bb.top   - half);
      maxX = Math.max(maxX, bb.right + half);
      maxY = Math.max(maxY, bb.bottom + half);
    }

    // Clamp to canvas bounds (coordinates can't be negative)
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.ceil(maxX);
    maxY = Math.ceil(maxY);

    // Shift all annotations so they stay correct in the new coordinate space
    const dx = -minX;
    const dy = -minY;

    setAnnotations(prev => prev.map(ann => shiftAnnotation(ann, dx, dy)));
    setCanvasOffsetX(canvasOffsetX - minX);
    setCanvasOffsetY(canvasOffsetY - minY);
    setCanvasPaddingRight(Math.max(0, maxX - canvasOffsetX - img.naturalWidth));
    setCanvasPaddingBottom(Math.max(0, maxY - canvasOffsetY - img.naturalHeight));
  }

  // ── Crop apply ────────────────────────────────────────────────────────────────

  /** Crop a single image annotation's dataUrl to the current cropRect. */
  function applyImageCrop() {
    if (!cropRect || !cropTargetAnn) return;
    const ann = cropTargetAnn;
    const imgEl = imageElemCacheRef.current.get(ann.dataUrl);
    if (!imgEl) return;

    // cropRect is stored in "unrotated crop space" (see toUnrotatedCropSpace).
    // For rotation=0 this is identical to canvas space.
    const x1 = Math.round(Math.min(cropRect.x1, cropRect.x2));
    const y1 = Math.round(Math.min(cropRect.y1, cropRect.y2));
    const x2 = Math.round(Math.max(cropRect.x1, cropRect.x2));
    const y2 = Math.round(Math.max(cropRect.y1, cropRect.y2));
    if (x2 - x1 < 2 || y2 - y1 < 2) { setCropRect(null); return; }

    // Map unrotated-crop-space crop rect → image natural-pixel space.
    // In unrotated crop space the image occupies [ann.x, ann.x+ann.width] × [ann.y, ann.y+ann.height],
    // so the relative offset is simply (x1 - ann.x, y1 - ann.y).
    const scaleX = imgEl.naturalWidth  / ann.width;
    const scaleY = imgEl.naturalHeight / ann.height;
    const relX1 = Math.max(0, x1 - ann.x);
    const relY1 = Math.max(0, y1 - ann.y);
    const relX2 = Math.min(ann.width,  x2 - ann.x);
    const relY2 = Math.min(ann.height, y2 - ann.y);
    const srcX = Math.round(relX1 * scaleX);
    const srcY = Math.round(relY1 * scaleY);
    const srcW = Math.max(1, Math.round((relX2 - relX1) * scaleX));
    const srcH = Math.max(1, Math.round((relY2 - relY1) * scaleY));

    // Draw cropped region onto offscreen canvas → new PNG dataUrl
    const off = document.createElement("canvas");
    off.width  = srcW;
    off.height = srcH;
    const ctx2 = off.getContext("2d")!;
    ctx2.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
    const newDataUrl = off.toDataURL("image/png");

    pushHistory();

    const newW = relX2 - relX1;
    const newH = relY2 - relY1;

    // Compute the new canvas-space top-left.
    // The crop rect was drawn in unrotated space, so the new annotation top-left in
    // unrotated space is (ann.x + relX1, ann.y + relY1).  For a rotated image we must
    // rotate the new centre point back into real canvas space (keeping the same rotation).
    const rot = ann.rotation ?? 0;
    let newX: number, newY: number;
    if (rot === 0) {
      newX = ann.x + relX1;
      newY = ann.y + relY1;
    } else {
      // Original image centre (real canvas space)
      const origCx = ann.x + ann.width  / 2;
      const origCy = ann.y + ann.height / 2;
      // New bounding-box centre in unrotated crop space
      const uCx = ann.x + relX1 + newW / 2;
      const uCy = ann.y + relY1 + newH / 2;
      // Rotate new centre back to real canvas space
      const { x: rCx, y: rCy } = rotatePoint(uCx, uCy, origCx, origCy, rot);
      newX = rCx - newW / 2;
      newY = rCy - newH / 2;
    }

    const annIdx = selectedIndices[0];
    setAnnotations(prev =>
      prev.map((a, i) =>
        i === annIdx
          ? { ...ann, dataUrl: newDataUrl, x: newX, y: newY, width: newW, height: newH } as ImageAnnotation
          : a
      )
    );
    // Register the new image in the cache so the canvas renders immediately
    const newEl = new Image();
    newEl.onload = () => { imageElemCacheRef.current.set(newDataUrl, newEl); redrawRef.current(); };
    newEl.src = newDataUrl;

    setCropRect(null);
    setTool("select");
  }

  function applyCrop() {
    // Delegate to image-annotation crop when a single image is selected
    if (imageCropMode) { applyImageCrop(); return; }
    if (!cropRect || !imgRef.current) return;
    // Normalise rect
    const x1 = Math.round(Math.min(cropRect.x1, cropRect.x2));
    const y1 = Math.round(Math.min(cropRect.y1, cropRect.y2));
    const x2 = Math.round(Math.max(cropRect.x1, cropRect.x2));
    const y2 = Math.round(Math.max(cropRect.y1, cropRect.y2));
    if (x2 - x1 < 4 || y2 - y1 < 4) { setCropRect(null); return; }

    const img = imgRef.current;
    pushHistory();

    // The canvas coordinate formula (used in handleSave / redraw / fitZoom) is:
    //   canvas_width  = imgW + canvasOffsetX + canvasPaddingRight
    //   canvas_height = imgH + canvasOffsetY + canvasPaddingBottom
    //   image drawn at (canvasOffsetX, canvasOffsetY)
    //
    // After crop to (x1,y1)-(x2,y2) the new canvas must be exactly (x2-x1) × (y2-y1).
    // Solving canvas_width = imgW + newOX + newPR = x2-x1 and newOX = canvasOffsetX - x1:
    //   newPR = (x2-x1) - imgW - (canvasOffsetX-x1) = x2 - canvasOffsetX - imgW
    // This can be negative → the canvas clips the right/bottom of the image, which is correct.
    const newOX = canvasOffsetX - x1;
    const newOY = canvasOffsetY - y1;
    const newPR = x2 - canvasOffsetX - img.naturalWidth;
    const newPB = y2 - canvasOffsetY - img.naturalHeight;
    // Single source of truth for the post-crop canvas bounds (in the shifted coordinate space)
    const newW  = x2 - x1;
    const newH  = y2 - y1;

    // Shift all annotations to the new origin, then remove any entirely outside the new canvas
    setAnnotations(prev =>
      prev
        .map(ann => shiftAnnotation(ann, -x1, -y1))
        .filter(ann => {
          const bb = getBBox(ann);
          return bb.right > 0 && bb.bottom > 0 && bb.left < newW && bb.top < newH;
        })
    );
    setCanvasOffsetX(newOX);
    setCanvasOffsetY(newOY);
    setCanvasPaddingRight(newPR);
    setCanvasPaddingBottom(newPB);
    setCropRect(null);
    setTool("select");
    setSelectedIndices([]);
  }

  function requestClose() {
    if (hasChanges()) {
      setShowExitConfirm(true);
    } else {
      onClose();
    }
  }

  // ── Canvas coordinate helper ─────────────────────────────────────────────────

  function canvasCoords(e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  // ── Pointer handlers ─────────────────────────────────────────────────────────

  /** Returns which handle (if any) the pointer (x,y) is over for the selected annotation. */
  function hitTestHandles(ann: Annotation, x: number, y: number): "start" | "end" | "resize" | "rotate" | null {
    if (ann.kind === "arrow" || ann.kind === "line") {
      if (nearPoint(x, y, ann.x1, ann.y1)) return "start";
      if (nearPoint(x, y, ann.x2, ann.y2)) return "end";
    } else if (ann.kind === "circle") {
      const { hx, hy } = circleResizeHandle(ann);
      if (nearPoint(x, y, hx, hy)) return "resize";
    } else if (ann.kind === "ellipse") {
      // Check rotation handle first (larger priority)
      const { hx: rhx, hy: rhy } = rotationHandlePos(ann);
      if (nearPoint(x, y, rhx, rhy)) return "rotate";
      const rot = ann.rotation ?? 0;
      const rhp = rotatePoint(ann.cx + ann.rx, ann.cy + ann.ry, ann.cx, ann.cy, rot);
      if (nearPoint(x, y, rhp.x, rhp.y)) return "resize";
    } else if (ann.kind === "rect") {
      const { hx: rhx, hy: rhy } = rotationHandlePos(ann);
      if (nearPoint(x, y, rhx, rhy)) return "rotate";
      const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
      const rot = ann.rotation ?? 0;
      const rhp = rotatePoint(ann.x + ann.w, ann.y + ann.h, rcx, rcy, rot);
      if (nearPoint(x, y, rhp.x, rhp.y)) return "resize";
    } else if (ann.kind === "text") {
      const bb = getBBox(ann);
      if (nearPoint(x, y, bb.right, bb.cy)) return "resize";
    } else if (ann.kind === "image") {
      const { hx: rhx, hy: rhy } = imageRotHandlePos(ann);
      if (nearPoint(x, y, rhx, rhy)) return "rotate";
      const rcx = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
      const rot = ann.rotation ?? 0;
      const rhp = rotatePoint(ann.x + ann.width, ann.y + ann.height, rcx, rcy, rot);
      if (nearPoint(x, y, rhp.x, rhp.y)) return "resize";
    }
    return null;
  }

  /** Hit-test cursor position against a crop rect — returns handle name, "move", or null. */
  function hitTestCropRect(x: number, y: number, r: { x1: number; y1: number; x2: number; y2: number }) {
    const CROP_HIT_R = 8 / zoomRef.current; // px in canvas coords
    const x1 = Math.min(r.x1, r.x2), y1 = Math.min(r.y1, r.y2);
    const x2 = Math.max(r.x1, r.x2), y2 = Math.max(r.y1, r.y2);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    // Corner handles (priority over edge midpoints)
    if (Math.hypot(x - x1, y - y1) <= CROP_HIT_R) return "nw" as const;
    if (Math.hypot(x - x2, y - y1) <= CROP_HIT_R) return "ne" as const;
    if (Math.hypot(x - x2, y - y2) <= CROP_HIT_R) return "se" as const;
    if (Math.hypot(x - x1, y - y2) <= CROP_HIT_R) return "sw" as const;
    // Edge midpoint handles
    if (Math.hypot(x - mx, y - y1) <= CROP_HIT_R) return "n" as const;
    if (Math.hypot(x - x2, y - my) <= CROP_HIT_R) return "e" as const;
    if (Math.hypot(x - mx, y - y2) <= CROP_HIT_R) return "s" as const;
    if (Math.hypot(x - x1, y - my) <= CROP_HIT_R) return "w" as const;
    // Interior — move
    if (x >= x1 && x <= x2 && y >= y1 && y <= y2) return "move" as const;
    return null;
  }

  /** Snap a canvas coordinate to the nearest image edge when within CROP_SNAP px. */
  function snapToImageEdge(v: number, axis: "x" | "y"): number {
    const CROP_SNAP = 8;
    const img = imgRef.current;
    if (!img) return v;
    if (axis === "x") {
      const left  = canvasOffsetXRef.current;
      const right = left + img.naturalWidth;
      if (Math.abs(v - left)  <= CROP_SNAP) return left;
      if (Math.abs(v - right) <= CROP_SNAP) return right;
    } else {
      const top    = canvasOffsetYRef.current;
      const bottom = top + img.naturalHeight;
      if (Math.abs(v - top)    <= CROP_SNAP) return top;
      if (Math.abs(v - bottom) <= CROP_SNAP) return bottom;
    }
    return v;
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (textInput) return; // text input in progress
    // Space-pan: record scroll anchor, skip annotation logic
    if (spacePanningRef.current) {
      const vp = viewportRef.current;
      if (vp) panDragRef.current = { x: e.clientX, y: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
      return;
    }
    const { x, y } = canvasCoords(e);

    if (tool === "select") {
      // 1. Check handles of the currently selected annotation first
      if (selectedIndex != null && annotations[selectedIndex]) {
        const ann = annotations[selectedIndex];
        const handle = hitTestHandles(ann, x, y);
        if (handle) {
          dragRef.current = {
            kind: "handle",
            startX: x, startY: y,
            annIndex: selectedIndex,
            handle,
            origX:  (ann.kind === "arrow" || ann.kind === "line") ? ann.x1 : (ann.kind === "rect") ? ann.x : ann.kind === "image" ? ann.x : undefined,
            origY:  (ann.kind === "arrow" || ann.kind === "line") ? ann.y1 : (ann.kind === "rect") ? ann.y : ann.kind === "image" ? ann.y : undefined,
            origX2: (ann.kind === "arrow" || ann.kind === "line") ? ann.x2 : (ann.kind === "rect") ? ann.x + ann.w : ann.kind === "image" ? ann.x + ann.width : undefined,
            origY2: (ann.kind === "arrow" || ann.kind === "line") ? ann.y2 : (ann.kind === "rect") ? ann.y + ann.h : ann.kind === "image" ? ann.y + ann.height : undefined,
            origCx: ann.kind === "circle" ? ann.cx : ann.kind === "ellipse" ? ann.cx : (ann.kind === "rect") ? ann.x + ann.w / 2 : ann.kind === "image" ? ann.x + ann.width / 2 : undefined,
            origCy: ann.kind === "circle" ? ann.cy : ann.kind === "ellipse" ? ann.cy : (ann.kind === "rect") ? ann.y + ann.h / 2 : ann.kind === "image" ? ann.y + ann.height / 2 : undefined,
            origR:  ann.kind === "circle" ? ann.r  : undefined,
          };
          return;
        }
      }
      // 2. Hit-test annotation bodies (topmost first)
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (hitTest(annotations[i], x, y)) {
          if (e.shiftKey) {
            // Shift-click: toggle this annotation in/out of multi-selection, no drag
            setSelectedIndices(prev =>
              prev.includes(i) ? prev.filter(j => j !== i) : [...prev, i]
            );
            return;
          }
          // Normal click: keep selection if already in it (allows group drag), else reset to [i]
          const newSel = selectedIndices.includes(i) ? selectedIndices : [i];
          setSelectedIndices(newSel);

          const ann = annotations[i];
          // Snapshot every item that will move together
          const moveIndices = selectedIndices.includes(i) ? selectedIndices : [i];
          const origAnns = new Map<number, Annotation>();
          moveIndices.forEach(idx => { if (annotations[idx]) origAnns.set(idx, { ...annotations[idx] }); });

          dragRef.current = {
            kind: "move",
            startX: x, startY: y,
            annIndex: i,
            origX:  (ann.kind === "arrow" || ann.kind === "line") ? ann.x1 : (ann.kind === "circle" || ann.kind === "ellipse") ? ann.cx : ann.x,
            origY:  (ann.kind === "arrow" || ann.kind === "line") ? ann.y1 : (ann.kind === "circle" || ann.kind === "ellipse") ? ann.cy : ann.y,
            origX2: (ann.kind === "arrow" || ann.kind === "line") ? ann.x2 : ann.kind === "rect" ? ann.x + ann.w : undefined,
            origY2: (ann.kind === "arrow" || ann.kind === "line") ? ann.y2 : ann.kind === "rect" ? ann.y + ann.h : undefined,
            origAnn: { ...ann },
            origAnns,
          };
          return;
        }
      }
      setSelectedIndices([]);
      return;
    }

    if (tool === "text") {
      setTextInput({ x, y });
      setTextValue("");
      return;
    }

    // crop: move/resize existing rect, or start a new one
    if (tool === "crop") {
      // In image-crop mode with a rotated annotation, convert to unrotated crop space first.
      const cropX = (imageCropMode && cropTargetAnn) ? toUnrotatedCropSpace(x, y, cropTargetAnn).x : x;
      const cropY = (imageCropMode && cropTargetAnn) ? toUnrotatedCropSpace(x, y, cropTargetAnn).y : y;
      if (cropRect) {
        const hit = hitTestCropRect(cropX, cropY, cropRect);
        if (hit === "move") {
          cropDragRef.current = { kind: "move", startX: cropX, startY: cropY, origRect: { ...cropRect } };
          return;
        }
        if (hit) {
          cropDragRef.current = { kind: "resize", handle: hit, startX: cropX, startY: cropY, origRect: { ...cropRect } };
          return;
        }
      }
      // Draw a new rect — in image-crop mode clamp start to the image annotation bounds
      let sx = imageCropMode ? cropX : snapToImageEdge(x, "x");
      let sy = imageCropMode ? cropY : snapToImageEdge(y, "y");
      if (imageCropMode && cropTargetAnn) {
        sx = Math.max(cropTargetAnn.x, Math.min(cropTargetAnn.x + cropTargetAnn.width,  sx));
        sy = Math.max(cropTargetAnn.y, Math.min(cropTargetAnn.y + cropTargetAnn.height, sy));
      }
      cropDragRef.current = { kind: "draw", startX: sx, startY: sy };
      setCropRect({ x1: sx, y1: sy, x2: sx, y2: sy });
      return;
    }

    // arrow, line, circle, rect: start drawing
    dragRef.current = { kind: "draw", startX: x, startY: y };
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    // Space-pan: update scroll position
    if (panDragRef.current) {
      const vp = viewportRef.current;
      if (vp) {
        vp.scrollLeft = panDragRef.current.sl - (e.clientX - panDragRef.current.x);
        vp.scrollTop  = panDragRef.current.st - (e.clientY - panDragRef.current.y);
      }
      return;
    }

    const { x, y } = canvasCoords(e);

    // Update hover state for cursor (only when not dragging)
    if (!dragRef.current && tool === "select") {
      const selAnn = selectedIndex != null ? annotations[selectedIndex] : null;
      const hitResult = selAnn ? hitTestHandles(selAnn, x, y) : null;
      const onHandle: "endpoint" | "resize" | "text-resize" | "rotate" | false =
        hitResult === null ? false
        : selAnn?.kind === "text" ? "text-resize"
        : (hitResult === "start" || hitResult === "end") ? "endpoint"
        : hitResult === "rotate" ? "rotate"
        : "resize";
      setOverHandle(onHandle);
      // Show move cursor when hovering over any annotation body
      const onBody = !onHandle && annotations.some(ann => hitTest(ann, x, y));
      setOverBody(onBody);
    }

    // Crop: update hover area (for cursor) and handle active drags
    if (tool === "crop") {
      const cd = cropDragRef.current;
      // In image-crop mode with a rotated annotation, convert to unrotated crop space.
      const cropX = (imageCropMode && cropTargetAnn) ? toUnrotatedCropSpace(x, y, cropTargetAnn).x : x;
      const cropY = (imageCropMode && cropTargetAnn) ? toUnrotatedCropSpace(x, y, cropTargetAnn).y : y;
      if (!cd) {
        // Not dragging — update hover area for cursor
        setCropHitArea(cropRect ? hitTestCropRect(cropX, cropY, cropRect) : null);
        return;
      }
      /** Clamp a crop-space coordinate to the image annotation bounds (image-crop mode only). */
      const clampToImg = (v: number, axis: "x" | "y") => {
        if (!imageCropMode || !cropTargetAnn) return v;
        return axis === "x"
          ? Math.max(cropTargetAnn.x, Math.min(cropTargetAnn.x + cropTargetAnn.width,  v))
          : Math.max(cropTargetAnn.y, Math.min(cropTargetAnn.y + cropTargetAnn.height, v));
      };

      if (cd.kind === "draw") {
        // imageCropMode: coords already in unrotated crop space; non-image-crop: snap to canvas image edges
        const sx = imageCropMode ? clampToImg(cropX, "x") : clampToImg(snapToImageEdge(x, "x"), "x");
        const sy = imageCropMode ? clampToImg(cropY, "y") : clampToImg(snapToImageEdge(y, "y"), "y");
        setCropRect({ x1: cd.startX, y1: cd.startY, x2: sx, y2: sy });
      } else if (cd.kind === "move") {
        const dx = cropX - cd.startX, dy = cropY - cd.startY;
        let r = {
          x1: cd.origRect.x1 + dx, y1: cd.origRect.y1 + dy,
          x2: cd.origRect.x2 + dx, y2: cd.origRect.y2 + dy,
        };
        // In image-crop mode: keep the rect inside the image (shift if it hits an edge)
        if (imageCropMode && cropTargetAnn) {
          const rw = r.x2 - r.x1, rh = r.y2 - r.y1;
          r.x1 = Math.max(cropTargetAnn.x, Math.min(cropTargetAnn.x + cropTargetAnn.width  - rw, r.x1));
          r.y1 = Math.max(cropTargetAnn.y, Math.min(cropTargetAnn.y + cropTargetAnn.height - rh, r.y1));
          r.x2 = r.x1 + rw; r.y2 = r.y1 + rh;
        }
        setCropRect(r);
      } else if (cd.kind === "resize") {
        const orig = cd.origRect;
        const dx = cropX - cd.startX, dy = cropY - cd.startY;
        let { x1, y1, x2, y2 } = orig;
        const h = cd.handle;
        if (h === "nw" || h === "w" || h === "sw") x1 = clampToImg(imageCropMode ? orig.x1 + dx : snapToImageEdge(orig.x1 + dx, "x"), "x");
        if (h === "ne" || h === "e" || h === "se") x2 = clampToImg(imageCropMode ? orig.x2 + dx : snapToImageEdge(orig.x2 + dx, "x"), "x");
        if (h === "nw" || h === "n" || h === "ne") y1 = clampToImg(imageCropMode ? orig.y1 + dy : snapToImageEdge(orig.y1 + dy, "y"), "y");
        if (h === "sw" || h === "s" || h === "se") y2 = clampToImg(imageCropMode ? orig.y2 + dy : snapToImageEdge(orig.y2 + dy, "y"), "y");
        setCropRect({ x1, y1, x2, y2 });
      }
      return;
    }

    if (!dragRef.current) return;
    const drag = dragRef.current;

    if (drag.kind === "draw") {
      // Shift: snap arrow/line to nearest 45° (horizontal, vertical, diagonal)
      let ex = x, ey = y;
      if (e.shiftKey && (tool === "arrow" || tool === "line")) {
        const dx = x - drag.startX, dy = y - drag.startY;
        const angle = Math.atan2(dy, dx);
        const snap  = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        const len   = Math.hypot(dx, dy);
        ex = drag.startX + len * Math.cos(snap);
        ey = drag.startY + len * Math.sin(snap);
      }
      // Alt = free draw, no dimension snapping
      const refs = e.altKey ? null : collectRefDims(annotations, null);
      const dg: DimGuide[] = [];
      if (tool === "arrow" || tool === "line") {
        if (refs) {
          const s = snapSegLen(drag.startX, drag.startY, ex, ey, refs.lengths);
          if (s) { ex = s.x2; ey = s.y2; dg.push(...segLenGuides(drag.startX, drag.startY, ex, ey, s.ref)); }
        }
        setPreview({ kind: tool, x1: drag.startX, y1: drag.startY, x2: ex, y2: ey, color, lineWidth });
      } else if (tool === "circle") {
        let r = Math.hypot(x - drag.startX, y - drag.startY);
        if (refs) {
          const ref = nearestDim(r, refs.radii);
          if (ref) { r = ref.v; dg.push(...radiusGuides(drag.startX, drag.startY, r, ref)); }
        }
        setPreview({ kind: "circle", cx: drag.startX, cy: drag.startY, r, color, lineWidth, fillOpacity });
      } else if (tool === "ellipse") {
        let rx = Math.abs(x - drag.startX), ry = Math.abs(y - drag.startY);
        if (e.shiftKey) { const s = Math.min(rx, ry); rx = s; ry = s; }
        let wRef: BoxRef | null = null, hRef: BoxRef | null = null;
        if (refs && !e.shiftKey) {
          wRef = nearestDim(rx * 2, refs.widths);  if (wRef) rx = wRef.v / 2;
          hRef = nearestDim(ry * 2, refs.heights); if (hRef) ry = hRef.v / 2;
          const box = { left: drag.startX - rx, right: drag.startX + rx, top: drag.startY - ry, bottom: drag.startY + ry };
          if (wRef) dg.push(...widthGuides(box, wRef));
          if (hRef) dg.push(...heightGuides(box, hRef));
        }
        setPreview({ kind: "ellipse", cx: drag.startX, cy: drag.startY, rx, ry, color, lineWidth, fillOpacity });
      } else if (tool === "rect") {
        let rw = x - drag.startX, rh = y - drag.startY;
        if (e.shiftKey) {
          const side = Math.min(Math.abs(rw), Math.abs(rh));
          rw = rw < 0 ? -side : side;
          rh = rh < 0 ? -side : side;
        }
        if (refs && !e.shiftKey) {
          const wRef = nearestDim(Math.abs(rw), refs.widths);
          const hRef = nearestDim(Math.abs(rh), refs.heights);
          if (wRef) rw = rw < 0 ? -wRef.v : wRef.v;
          if (hRef) rh = rh < 0 ? -hRef.v : hRef.v;
          const box = {
            left:   Math.min(drag.startX, drag.startX + rw),
            right:  Math.max(drag.startX, drag.startX + rw),
            top:    Math.min(drag.startY, drag.startY + rh),
            bottom: Math.max(drag.startY, drag.startY + rh),
          };
          if (wRef) dg.push(...widthGuides(box, wRef));
          if (hRef) dg.push(...heightGuides(box, hRef));
        }
        setPreview({ kind: "rect", x: drag.startX, y: drag.startY, w: rw, h: rh, color, lineWidth, fillOpacity });
      }
      setDimGuides(dg);
    } else if (drag.kind === "move" && drag.annIndex != null) {
      let dx = x - drag.startX;
      let dy = y - drag.startY;
      // Shift: lock to horizontal or vertical axis
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }

      if ((e.ctrlKey || e.metaKey) && drag.origAnn) {
        // Ctrl: ghost-copy — keep the original in place, show a moving preview of the primary
        const orig = drag.origAnn;
        const ghost = shiftAnnotation(orig, dx, dy);
        setAnnotations(prev => prev.map((ann, i) => i === drag.annIndex ? drag.origAnn! : ann));
        setPreview(ghost);
        setGuides([]);
      } else {
        // Normal move — apply to ALL selected annotations from their snapshots
        const moved = new Map<number, Annotation>();
        drag.origAnns?.forEach((orig, idx) => { moved.set(idx, shiftAnnotation(orig, dx, dy)); });

        // Compute smart guides for the primary annotation's moved bounding box
        // Alt key = free move, no snapping
        const primaryOrig = drag.origAnns?.get(drag.annIndex);
        if (primaryOrig && !e.altKey) {
          const movedBox = getBBox(shiftAnnotation(primaryOrig, dx, dy));
          const others   = annotations
            .filter((_, i) => !drag.origAnns!.has(i))
            .map(ann => getBBox(ann));

          // ── Alignment snap (edges/centres) ────────────────────────────────
          const { guides: newGuides, snapDx, snapDy } = computeGuides(movedBox, others);
          let fdx = dx, fdy = dy;
          if (newGuides.length > 0) {
            fdx = dx + snapDx; fdy = dy + snapDy;
            drag.origAnns?.forEach((orig, idx) => { moved.set(idx, shiftAnnotation(orig, fdx, fdy)); });
          }
          setGuides(newGuides);

          // ── Equal-spacing indicators (only when no alignment snap active) ─
          const snapBox     = getBBox(shiftAnnotation(primaryOrig, fdx, fdy));
          const newSpacing  = computeSpacingGuides(snapBox, others);
          if (newSpacing.length > 0 && newGuides.length === 0) {
            // Snap to equal spacing and recompute guides for accurate bracket positions
            const sfx = fdx + newSpacing[0].snapDx, sfy = fdy + newSpacing[0].snapDy;
            drag.origAnns?.forEach((orig, idx) => { moved.set(idx, shiftAnnotation(orig, sfx, sfy)); });
            const snappedBox    = getBBox(shiftAnnotation(primaryOrig, sfx, sfy));
            setSpacingGuides(computeSpacingGuides(snappedBox, others));
          } else {
            setSpacingGuides(newSpacing);
          }
        } else {
          setGuides([]);
          setSpacingGuides([]);
        }

        setPreview(null);
        setAnnotations(prev => prev.map((ann, i) => moved.has(i) ? moved.get(i)! : ann));
      }
    } else if (drag.kind === "handle" && drag.annIndex != null) {
      // Shift-constrain handle dragging to H/V (skip for rotation handles)
      let hx = x, hy = y;
      if (e.shiftKey && drag.handle !== "rotate") {
        const ddx = x - drag.startX, ddy = y - drag.startY;
        if (Math.abs(ddx) >= Math.abs(ddy)) hy = drag.startY; else hx = drag.startX;
      }
      const applyHandle = (ann: Annotation): Annotation => {
        if (ann.kind === "arrow" || ann.kind === "line") {
          if (drag.handle === "start") return { ...ann, x1: drag.origX! + (hx - drag.startX), y1: drag.origY! + (hy - drag.startY) };
          if (drag.handle === "end")   return { ...ann, x2: drag.origX2! + (hx - drag.startX), y2: drag.origY2! + (hy - drag.startY) };
        } else if (ann.kind === "circle" && drag.handle === "resize") {
          return { ...ann, r: Math.max(5, Math.hypot(hx - drag.origCx!, hy - drag.origCy!)) };
        } else if (ann.kind === "ellipse" && drag.handle === "resize") {
          // Resize in local (unrotated) frame
          const rot = ann.rotation ?? 0;
          const lp = rot !== 0 ? rotatePoint(hx, hy, drag.origCx!, drag.origCy!, -rot) : { x: hx, y: hy };
          let rx = Math.max(5, lp.x - drag.origCx!);
          let ry = Math.max(5, lp.y - drag.origCy!);
          if (e.shiftKey) { const s = Math.min(rx, ry); rx = s; ry = s; }
          return { ...ann, rx, ry };
        } else if (ann.kind === "ellipse" && drag.handle === "rotate") {
          let rotation = Math.atan2(hx - drag.origCx!, -(hy - drag.origCy!));
          if (e.shiftKey) { const step = Math.PI / 12; rotation = Math.round(rotation / step) * step; }
          return { ...ann, rotation };
        } else if (ann.kind === "rect" && drag.handle === "resize") {
          const rot = ann.rotation ?? 0;
          if (rot === 0) {
            // Non-rotated: simple absolute local approach
            return { ...ann, w: Math.max(10, hx - drag.origX!), h: Math.max(10, hy - drag.origY!) };
          }
          // Rotated: keep top-left world position fixed, move bottom-right to pointer.
          // TL_world was established at drag-start using the original centre and rotation.
          const tlWorld = rotatePoint(drag.origX!, drag.origY!, drag.origCx!, drag.origCy!, rot);
          const dx = hx - tlWorld.x, dy = hy - tlWorld.y;
          // Project (dx, dy) into the rect's local axes to get new w/h
          const newW = Math.max(10, dx * Math.cos(rot) + dy * Math.sin(rot));
          const newH = Math.max(10, -dx * Math.sin(rot) + dy * Math.cos(rot));
          // New centre = midpoint of fixed TL and new BR (= pointer)
          const newCx = (tlWorld.x + hx) / 2;
          const newCy = (tlWorld.y + hy) / 2;
          // ann.x/y is the top-left in the rect's local frame → centre - half-size
          return { ...ann, x: newCx - newW / 2, y: newCy - newH / 2, w: newW, h: newH };
        } else if (ann.kind === "rect" && drag.handle === "rotate") {
          let rotation = Math.atan2(hx - drag.origCx!, -(hy - drag.origCy!));
          if (e.shiftKey) { const step = Math.PI / 12; rotation = Math.round(rotation / step) * step; }
          return { ...ann, rotation };
        } else if (ann.kind === "text" && drag.handle === "resize") {
          // Drag right edge to set wrap width
          return { ...ann, maxWidth: Math.max(30, hx - ann.x) };
        } else if (ann.kind === "image" && drag.handle === "resize") {
          const origW = drag.origX2! - drag.origX!;
          const origH = drag.origY2! - drag.origY!;
          const diagSq = origW * origW + origH * origH;
          const rot = ann.rotation ?? 0;
          // Aspect ratio is always locked for images.
          // Scale = projection of (pointer - TL) onto the diagonal direction.
          if (rot === 0) {
            const dx = hx - drag.origX!, dy = hy - drag.origY!;
            const scale = Math.max(20 / Math.max(origW, origH), (dx * origW + dy * origH) / diagSq);
            const newW = Math.round(origW * scale);
            const newH = Math.round(origH * scale);
            return { ...ann, width: newW, height: newH };
          }
          // Rotated: project pointer into local frame first, then same algebra.
          const tlWorld = rotatePoint(drag.origX!, drag.origY!, drag.origCx!, drag.origCy!, rot);
          const ddx = hx - tlWorld.x, ddy = hy - tlWorld.y;
          // Local-frame displacement along each axis
          const localDx = ddx * Math.cos(rot) + ddy * Math.sin(rot);
          const localDy = -ddx * Math.sin(rot) + ddy * Math.cos(rot);
          const scale = Math.max(20 / Math.max(origW, origH), (localDx * origW + localDy * origH) / diagSq);
          const newW = Math.round(origW * scale);
          const newH = Math.round(origH * scale);
          // Keep top-left world position fixed; new centre is midpoint of TL and new BR
          const newBRLocal = rotatePoint(drag.origX! + newW, drag.origY! + newH, drag.origCx!, drag.origCy!, rot);
          const newCx = (tlWorld.x + newBRLocal.x) / 2;
          const newCy = (tlWorld.y + newBRLocal.y) / 2;
          return { ...ann, x: newCx - newW / 2, y: newCy - newH / 2, width: newW, height: newH };
        } else if (ann.kind === "image" && drag.handle === "rotate") {
          let rotation = Math.atan2(hx - drag.origCx!, -(hy - drag.origCy!));
          if (e.shiftKey) { const step = Math.PI / 12; rotation = Math.round(rotation / step) * step; }
          return { ...ann, rotation };
        }
        return ann;
      };

      const idx = drag.annIndex;
      const cur = annotations[idx];
      if (cur) {
        let updated = applyHandle(cur);
        const dg: DimGuide[] = [];
        // Alt = free resize; rotation handles never dimension-snap
        if (!e.altKey && drag.handle !== "rotate") {
          const refs = collectRefDims(annotations, idx);
          if ((updated.kind === "arrow" || updated.kind === "line") &&
              (drag.handle === "start" || drag.handle === "end")) {
            const fx = drag.handle === "start" ? updated.x2 : updated.x1;
            const fy = drag.handle === "start" ? updated.y2 : updated.y1;
            const mx = drag.handle === "start" ? updated.x1 : updated.x2;
            const my = drag.handle === "start" ? updated.y1 : updated.y2;
            const s = snapSegLen(fx, fy, mx, my, refs.lengths);
            if (s) {
              updated = drag.handle === "start"
                ? { ...updated, x1: s.x2, y1: s.y2 }
                : { ...updated, x2: s.x2, y2: s.y2 };
              dg.push(...segLenGuides(fx, fy, s.x2, s.y2, s.ref));
            }
          } else if (updated.kind === "circle" && drag.handle === "resize") {
            const ref = nearestDim(updated.r, refs.radii);
            if (ref) {
              updated = { ...updated, r: ref.v };
              dg.push(...radiusGuides(updated.cx, updated.cy, ref.v, ref));
            }
          } else if (updated.kind === "ellipse" && drag.handle === "resize" && !e.shiftKey) {
            const wRef = nearestDim(updated.rx * 2, refs.widths);
            const hRef = nearestDim(updated.ry * 2, refs.heights);
            if (wRef || hRef) {
              updated = { ...updated, rx: wRef ? wRef.v / 2 : updated.rx, ry: hRef ? hRef.v / 2 : updated.ry };
              const box = { left: updated.cx - updated.rx, right: updated.cx + updated.rx,
                            top: updated.cy - updated.ry, bottom: updated.cy + updated.ry };
              if (wRef) dg.push(...widthGuides(box, wRef));
              if (hRef) dg.push(...heightGuides(box, hRef));
            }
          } else if (updated.kind === "rect" && drag.handle === "resize") {
            const wRef = nearestDim(updated.w, refs.widths);
            const hRef = nearestDim(updated.h, refs.heights);
            if (wRef || hRef) {
              const nw = wRef ? wRef.v : updated.w;
              const nh = hRef ? hRef.v : updated.h;
              const rot = updated.rotation ?? 0;
              if (rot !== 0) {
                // Keep the world-space top-left corner fixed (same anchor as applyHandle)
                const tl = rotatePoint(updated.x, updated.y,
                                       updated.x + updated.w / 2, updated.y + updated.h / 2, rot);
                const ncx = tl.x + (nw / 2) * Math.cos(rot) - (nh / 2) * Math.sin(rot);
                const ncy = tl.y + (nw / 2) * Math.sin(rot) + (nh / 2) * Math.cos(rot);
                updated = { ...updated, x: ncx - nw / 2, y: ncy - nh / 2, w: nw, h: nh };
              } else {
                updated = { ...updated, w: nw, h: nh };
              }
              const box = { left: updated.x, right: updated.x + updated.w,
                            top: updated.y, bottom: updated.y + updated.h };
              if (wRef) dg.push(...widthGuides(box, wRef));
              if (hRef) dg.push(...heightGuides(box, hRef));
            }
          } else if (updated.kind === "image" && drag.handle === "resize") {
            // Aspect ratio is locked — match either width or height, whichever is closer
            const ar   = updated.height / updated.width;
            const wRef = nearestDim(updated.width, refs.widths);
            const hRef = nearestDim(updated.height, refs.heights);
            const wDiff = wRef ? Math.abs(wRef.v - updated.width)  : Infinity;
            const hDiff = hRef ? Math.abs(hRef.v - updated.height) : Infinity;
            let nw: number | null = null, nh: number | null = null;
            if (wRef && wDiff <= hDiff)      { nw = Math.round(wRef.v); nh = Math.round(wRef.v * ar); }
            else if (hRef)                   { nh = Math.round(hRef.v); nw = Math.round(hRef.v / ar); }
            if (nw != null && nh != null) {
              const rot = updated.rotation ?? 0;
              if (rot !== 0) {
                // Keep the world-space top-left corner fixed (same anchor as applyHandle)
                const tl = rotatePoint(updated.x, updated.y,
                                       updated.x + updated.width / 2, updated.y + updated.height / 2, rot);
                const ncx = tl.x + (nw / 2) * Math.cos(rot) - (nh / 2) * Math.sin(rot);
                const ncy = tl.y + (nw / 2) * Math.sin(rot) + (nh / 2) * Math.cos(rot);
                updated = { ...updated, x: ncx - nw / 2, y: ncy - nh / 2, width: nw, height: nh };
              } else {
                updated = { ...updated, width: nw, height: nh };
              }
              if (wRef && wDiff <= hDiff) {
                dg.push(...widthGuides({ left: updated.x, right: updated.x + updated.width,
                                         bottom: updated.y + updated.height }, wRef));
              } else if (hRef) {
                dg.push(...heightGuides({ top: updated.y, bottom: updated.y + updated.height,
                                          right: updated.x + updated.width }, hRef));
              }
            }
          }
        }
        setDimGuides(dg);
        setAnnotations(prev => prev.map((a, i) => (i === idx ? updated : a)));
      }
    }
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (panDragRef.current) { panDragRef.current = null; return; }
    // Crop tool uses its own ref — handle BEFORE the dragRef guard
    if (tool === "crop" && cropDragRef.current) {
      cropDragRef.current = null;
      // Keep cropRect — user confirms/cancels via the bar
      return;
    }
    if (!dragRef.current) return;
    const { x, y } = canvasCoords(e);
    const drag = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    setDimGuides([]);

    // Ctrl+drag: commit ghost copies for all selected annotations
    if (drag.kind === "move" && (e.ctrlKey || e.metaKey) && drag.origAnn) {
      let dx = x - drag.startX, dy = y - drag.startY;
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
      pushHistory();

      const copies: Annotation[] = [];
      drag.origAnns?.forEach(orig => { copies.push(shiftAnnotation(orig, dx, dy)); });
      if (copies.length === 0) copies.push(shiftAnnotation(drag.origAnn, dx, dy));

      setAnnotations(prev => {
        // Restore each selected annotation to its original position
        const restored = prev.map((ann, i) => drag.origAnns?.get(i) ?? ann);
        const next     = [...restored, ...copies];
        const newIdx   = Array.from({ length: copies.length }, (_, k) => restored.length + k);
        setSelectedIndices(newIdx);
        // Learn the spacing from this Ctrl+drag and mark fresh copies as "pending"
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          lastDuplOffsetRef.current = { dx, dy };
          setSmartDuplOffset({ dx, dy });
          pendingDuplRef.current = { indices: newIdx };
        }
        return next;
      });
      setPreview(null);
      setOverHandle(false);
      setOverBody(false);
      setSpacingGuides([]);
      return;
    }

    // Commit move — push history once, on mouseUp (not on every mousemove)
    if (drag.kind === "move" && !(e.ctrlKey || e.metaKey)) {
      const dx = x - drag.startX, dy = y - drag.startY;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        pushHistory();
        // Smart-duplicate: check if the user just moved freshly-duplicated copies
        if (pendingDuplRef.current) {
          const pending = pendingDuplRef.current;
          const sel     = selectedIndicesRef.current;
          const moved   = pending.indices.length === sel.length &&
                          pending.indices.every((idx, i) => idx === sel[i]);
          if (moved) {
            // User moved the fresh copies → learn this spacing for next Ctrl+D
            lastDuplOffsetRef.current = { dx, dy };
            setSmartDuplOffset({ dx, dy });
          } else {
            // User moved something else → abandon the chain, reset to default
            lastDuplOffsetRef.current = { dx: 15, dy: 15 };
            setSmartDuplOffset(null);
          }
          pendingDuplRef.current = null;
        }
      }
    }

    // Commit handle resize / endpoint drag
    if (drag.kind === "handle") pushHistory();

    if (drag.kind === "draw") {
      // Snap arrow/line endpoint to nearest 45° when Shift is held
      let ex = x, ey = y;
      if (e.shiftKey && (tool === "arrow" || tool === "line")) {
        const dx = x - drag.startX, dy = y - drag.startY;
        const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len  = Math.hypot(dx, dy);
        ex = drag.startX + len * Math.cos(snap);
        ey = drag.startY + len * Math.sin(snap);
      }
      // Same dimension snapping as the live preview (Alt disables)
      const refs = e.altKey ? null : collectRefDims(annotations, null);
      if (refs && (tool === "arrow" || tool === "line")) {
        const s = snapSegLen(drag.startX, drag.startY, ex, ey, refs.lengths);
        if (s) { ex = s.x2; ey = s.y2; }
      }
      if (tool === "arrow") {
        const dist = Math.hypot(ex - drag.startX, ey - drag.startY);
        if (dist > 5) {
          setAnnotations(prev => {
            const next = [...prev, { kind: "arrow" as const, x1: drag.startX, y1: drag.startY, x2: ex, y2: ey, color, lineWidth }];
            setSelectedIndex(next.length - 1);
            return next;
          });
        }
      } else if (tool === "line") {
        const dist = Math.hypot(ex - drag.startX, ey - drag.startY);
        if (dist > 5) {
          setAnnotations(prev => {
            const next = [...prev, { kind: "line" as const, x1: drag.startX, y1: drag.startY, x2: ex, y2: ey, color, lineWidth }];
            setSelectedIndex(next.length - 1);
            return next;
          });
        }
      } else if (tool === "circle") {
        let r = Math.hypot(x - drag.startX, y - drag.startY);
        if (refs) { const ref = nearestDim(r, refs.radii); if (ref) r = ref.v; }
        if (r > 5) {
          setAnnotations(prev => {
            const next = [...prev, { kind: "circle" as const, cx: drag.startX, cy: drag.startY, r, color, lineWidth, fillOpacity }];
            setSelectedIndex(next.length - 1);
            return next;
          });
        }
      } else if (tool === "ellipse") {
        let rx = Math.abs(x - drag.startX), ry = Math.abs(y - drag.startY);
        if (e.shiftKey) { const s = Math.min(rx, ry); rx = s; ry = s; }
        if (refs && !e.shiftKey) {
          const wRef = nearestDim(rx * 2, refs.widths);  if (wRef) rx = wRef.v / 2;
          const hRef = nearestDim(ry * 2, refs.heights); if (hRef) ry = hRef.v / 2;
        }
        if (rx > 5 && ry > 5) {
          setAnnotations(prev => {
            const next = [...prev, { kind: "ellipse" as const, cx: drag.startX, cy: drag.startY, rx, ry, color, lineWidth, fillOpacity }];
            setSelectedIndex(next.length - 1);
            return next;
          });
        }
      } else if (tool === "rect") {
        let w = x - drag.startX, h = y - drag.startY;
        if (e.shiftKey) {
          const side = Math.min(Math.abs(w), Math.abs(h));
          w = w < 0 ? -side : side;
          h = h < 0 ? -side : side;
        }
        if (refs && !e.shiftKey) {
          const wRef = nearestDim(Math.abs(w), refs.widths);
          const hRef = nearestDim(Math.abs(h), refs.heights);
          if (wRef) w = w < 0 ? -wRef.v : wRef.v;
          if (hRef) h = h < 0 ? -hRef.v : hRef.v;
        }
        if (Math.abs(w) > 5 && Math.abs(h) > 5) {
          // Normalise so x/y is always the top-left corner
          const rx = w < 0 ? drag.startX + w : drag.startX;
          const ry = h < 0 ? drag.startY + h : drag.startY;
          setAnnotations(prev => {
            const next = [...prev, { kind: "rect" as const, x: rx, y: ry, w: Math.abs(w), h: Math.abs(h), color, lineWidth, fillOpacity }];
            setSelectedIndex(next.length - 1);
            return next;
          });
        }
      }
    }

    setPreview(null);
    setOverHandle(false);
    setOverBody(false);
    // After drawing, immediately switch to select so the new element can be
    // resized / moved without the user having to click the select tool first.
    if (drag.kind === "draw") setTool("select");
  }

  function handleMouseLeave() {
    panDragRef.current = null;
    setPreview(null);
    setOverHandle(false);
    setOverBody(false);
    // Don't cancel drag — user may release outside canvas
  }

  // ── Text confirm ─────────────────────────────────────────────────────────────

  // ── Sync toolbar ↔ selected annotation ──────────────────────────────────────
  //
  // When the selection changes, pull the annotation's properties into the
  // toolbar so the user sees the correct values.
  // When the user then adjusts a toolbar control, we write the new value back
  // into the annotation immediately (see the onChange handlers below).
  useEffect(() => {
    if (selectedIndex == null) return;
    const ann = annotations[selectedIndex];
    if (!ann) return;
    if (ann.kind === "image") {
      setImgOpacity(ann.opacity ?? 100);
      setImgBorderWidth(ann.borderWidth ?? 0);
      setImgBorderColor(ann.borderColor ?? "#000000");
      setImgBorderStyle(ann.borderStyle ?? "solid");
      setImgBorderRadius(ann.borderRadius ?? 0);
      const hasShadow = (ann.shadowBlur ?? 0) > 0;
      setImgShadowOn(hasShadow);
      setImgShadowBlur(ann.shadowBlur ?? 8);
      setImgShadowX(ann.shadowOffsetX ?? 4);
      setImgShadowY(ann.shadowOffsetY ?? 4);
      setImgFlipH(ann.flipH ?? false);
      setImgFlipV(ann.flipV ?? false);
      setImgBrightness(ann.brightness ?? 100);
      setImgContrast(ann.contrast ?? 100);
      // Parse stored rgba colour back into hex + alpha
      const sc = ann.shadowColor ?? "rgba(0,0,0,0.5)";
      const m = sc.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (m) {
        const toHex = (n: string) => parseInt(n).toString(16).padStart(2, "0");
        setImgShadowColor(`#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`);
        setImgShadowAlpha(Math.round(parseFloat(m[4] ?? "1") * 100));
      }
      return;
    }
    setColor(ann.color);
    if ("lineWidth" in ann) setLineWidth((ann as ArrowAnnotation | CircleAnnotation).lineWidth);
    if (ann.kind === "text") {
      setFontSize(ann.fontSize);
      setTextBold(ann.bold ?? false);
      setTextItalic(ann.italic ?? false);
      setTextUnderline(ann.underline ?? false);
      setTextStrikethrough(ann.strikethrough ?? false);
    }
    if (ann.kind === "circle" || ann.kind === "ellipse" || ann.kind === "rect") {
      setFillOpacity(Math.round(effectiveFillAlpha(ann) * 100));
    }
  }, [selectedIndex]); // intentionally not in [annotations] — only re-sync on new selection

  // Helper: update a property of the currently selected annotation
  function updateSelected(patch: Record<string, unknown>) {
    if (selectedIndices.length === 0) return;
    setAnnotations(prev => prev.map((ann, i) =>
      selectedIndices.includes(i) ? { ...ann, ...patch } as Annotation : ann
    ));
  }

  // Focus the text input imperatively when it appears — autoFocus alone is not
  // reliable inside Radix Dialog's FocusScope and can fire an immediate blur.
  useEffect(() => {
    if (textInput) {
      // Small delay so the Dialog's focus trap has settled before we steal focus.
      const id = setTimeout(() => textInputRef.current?.focus(), 30);
      return () => clearTimeout(id);
    }
  }, [textInput]);

  function confirmText() {
    if (textInput && textValue.trim()) {
      pushHistory();
      if (editingIndex != null) {
        // Update existing text annotation
        setAnnotations(prev => prev.map((ann, i) =>
          i === editingIndex
            ? { ...ann, text: textValue.trim(), color, fontSize } as typeof ann
            : ann
        ));
      } else {
        // Capture the textarea's rendered width so multi-line wrapping matches on canvas.
        // The canvas is always displayed at 1.5× its natural pixel resolution, so
        // dividing the textarea's screen-pixel width by 1.5 gives canvas pixels.
        const textareaEl = textInputRef.current;
        let maxWidth: number | undefined;
        if (textareaEl) {
          const w = textareaEl.getBoundingClientRect().width;
          if (w > 0) maxWidth = Math.round(w / 1.5);
        }
        setAnnotations(prev => {
          const next = [...prev, {
            kind: "text" as const,
            x: textInput.x,
            y: textInput.y,
            text: textValue.trim(),
            color,
            fontSize,
            bold: textBold || undefined,
            italic: textItalic || undefined,
            underline: textUnderline || undefined,
            strikethrough: textStrikethrough || undefined,
            maxWidth,
          }];
          setSelectedIndex(next.length - 1);
          return next;
        });
      }
    } else if (editingIndex != null) {
      setSelectedIndex(editingIndex);
    }
    setTextInput(null);
    setTextValue("");
    setEditingIndex(null);
  }

  function handleDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (textInput) return;
    const { x, y } = canvasCoords(e);
    // Find topmost text annotation under cursor
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      if (ann.kind === "text" && hitTest(ann, x, y)) {
        setEditingIndex(i);
        setTextInput({ x: ann.x, y: ann.y });
        setTextValue(ann.text);
        setColor(ann.color);
        setFontSize(ann.fontSize);
        setTextBold(ann.bold ?? false);
        setTextItalic(ann.italic ?? false);
        setTextUnderline(ann.underline ?? false);
        setTextStrikethrough(ann.strikethrough ?? false);
        setSelectedIndex(i);
        return;
      }
    }
  }

  // ── Undo / Redo / Delete ─────────────────────────────────────────────────────

  function handleUndo() {
    const stack = undoStackRef.current;
    const oStack = canvasOffsetHistoryRef.current;
    if (stack.length === 0) return;
    const snapshot  = stack[stack.length - 1];
    const oSnapshot = oStack[oStack.length - 1];
    undoStackRef.current           = stack.slice(0, -1);
    canvasOffsetHistoryRef.current = oStack.slice(0, -1);
    redoStackRef.current         = [...redoStackRef.current,         [...annotationsRef.current]];
    canvasOffsetRedoRef.current  = [...canvasOffsetRedoRef.current,  { ox: canvasOffsetXRef.current, oy: canvasOffsetYRef.current, pr: canvasPaddingRightRef.current, pb: canvasPaddingBottomRef.current }];
    setAnnotations(snapshot);
    if (oSnapshot) {
      setCanvasOffsetX(oSnapshot.ox);
      setCanvasOffsetY(oSnapshot.oy);
      setCanvasPaddingRight(oSnapshot.pr);
      setCanvasPaddingBottom(oSnapshot.pb);
    }
    setSelectedIndices([]);
    setCanUndo(stack.length > 1);
    setCanRedo(true);
    resetDuplOffset();
  }

  function handleRedo() {
    const stack  = redoStackRef.current;
    const oStack = canvasOffsetRedoRef.current;
    if (stack.length === 0) return;
    const snapshot  = stack[stack.length - 1];
    const oSnapshot = oStack[oStack.length - 1];
    redoStackRef.current         = stack.slice(0, -1);
    canvasOffsetRedoRef.current  = oStack.slice(0, -1);
    undoStackRef.current           = [...undoStackRef.current,           [...annotationsRef.current]];
    canvasOffsetHistoryRef.current = [...canvasOffsetHistoryRef.current,  { ox: canvasOffsetXRef.current, oy: canvasOffsetYRef.current, pr: canvasPaddingRightRef.current, pb: canvasPaddingBottomRef.current }];
    setAnnotations(snapshot);
    if (oSnapshot) {
      setCanvasOffsetX(oSnapshot.ox);
      setCanvasOffsetY(oSnapshot.oy);
      setCanvasPaddingRight(oSnapshot.pr);
      setCanvasPaddingBottom(oSnapshot.pb);
    }
    setSelectedIndices([]);
    setCanUndo(true);
    setCanRedo(stack.length > 1);
    resetDuplOffset();
  }

  function handleDelete() {
    if (selectedIndices.length > 0) {
      pushHistory();
      setAnnotations(prev => prev.filter((_, i) => !selectedIndices.includes(i)));
      setSelectedIndices([]);
    }
  }

  function handleDuplicate() {
    const indices = selectedIndicesRef.current;
    if (indices.length === 0) return;
    pushHistory();
    const { dx, dy } = lastDuplOffsetRef.current;
    setAnnotations(prev => {
      const copies = indices.map(idx => shiftAnnotation({ ...prev[idx] }, dx, dy));
      const next   = [...prev, ...copies];
      const newIdx = Array.from({ length: copies.length }, (_, k) => prev.length + k);
      setSelectedIndices(newIdx);
      // Remember which annotations were just created so handleMouseUp can learn the spacing
      pendingDuplRef.current = { indices: newIdx };
      return next;
    });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;

    function onKeyDown(e: KeyboardEvent) {
      // Never fire when the user is typing in an input or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // Tool shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "v" || e.key === "V") { e.preventDefault(); setTool("select"); setCropRect(null); return; }
        if (e.key === "a" || e.key === "A") { e.preventDefault(); setTool("arrow");  setCropRect(null); return; }
        if (e.key === "l" || e.key === "L") { e.preventDefault(); setTool("line");   setCropRect(null); return; }
        if (e.key === "c" || e.key === "C") { e.preventDefault(); setTool("circle"); setCropRect(null); return; }
        if (e.key === "e" || e.key === "E") { e.preventDefault(); setTool("ellipse"); setCropRect(null); return; }
        if (e.key === "r" || e.key === "R") { e.preventDefault(); setTool("rect");   setCropRect(null); return; }
        if (e.key === "t" || e.key === "T") { e.preventDefault(); setTool("text");   setCropRect(null); return; }
        if (e.key === "x" || e.key === "X") { e.preventDefault(); setTool("crop");   setCropRect(null); return; }
        // Enter confirms a pending crop rect
        if (e.key === "Enter" && toolRef.current === "crop") {
          e.preventDefault();
          applyCropRef.current?.();
          return;
        }
      }

      // Delete / Backspace → remove all selected annotations
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const toDelete = new Set(selectedIndicesRef.current);
        if (toDelete.size > 0) {
          setAnnotations(prev => prev.filter((_, i) => !toDelete.has(i)));
          setSelectedIndices([]);
        }
        return;
      }

      // Ctrl+B/I/U/S → toggle text formatting on selected text annotation
      if (e.ctrlKey || e.metaKey) {
        const fmtKey = e.key.toLowerCase();
        if (fmtKey === "b" || fmtKey === "i" || fmtKey === "u" || fmtKey === "s") {
          const idx = selectedIndexRef.current;
          if (idx != null) {
            e.preventDefault();
            setAnnotations(prev => {
              const ann = prev[idx];
              if (!ann || ann.kind !== "text") return prev;
              let updated: TextAnnotation;
              if (fmtKey === "b") { const v = !ann.bold;          setTextBold(v);          updated = { ...ann, bold: v || undefined }; }
              else if (fmtKey === "i") { const v = !ann.italic;   setTextItalic(v);        updated = { ...ann, italic: v || undefined }; }
              else if (fmtKey === "u") { const v = !ann.underline; setTextUnderline(v);    updated = { ...ann, underline: v || undefined }; }
              else                     { const v = !ann.strikethrough; setTextStrikethrough(v); updated = { ...ann, strikethrough: v || undefined }; }
              const next = [...prev];
              next[idx] = updated;
              return next;
            });
            return;
          }
        }
      }

      // Ctrl+D → duplicate all selected annotations
      if ((e.ctrlKey || e.metaKey) && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        const indices = selectedIndicesRef.current;
        if (indices.length > 0) {
          pushHistory();
          const { dx, dy } = lastDuplOffsetRef.current;
          setAnnotations(prev => {
            const copies = indices.map(idx => shiftAnnotation({ ...prev[idx] }, dx, dy));
            const next   = [...prev, ...copies];
            const newIdx = Array.from({ length: copies.length }, (_, k) => prev.length + k);
            setSelectedIndices(newIdx);
            pendingDuplRef.current = { indices: newIdx };
            return next;
          });
        }
        return;
      }

      // Ctrl+Z → undo
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Ctrl+Y / Ctrl+Shift+Z → redo
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // ArrowUp/Down/Left/Right → move selected annotations by 1 px (10 px with Shift)
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const indices = selectedIndicesRef.current;
        if (indices.length > 0 && textInputRef.current !== document.activeElement) {
          e.preventDefault();
          // Push history only on the first keydown of a nudge sequence (not on auto-repeat)
          if (!e.repeat) pushHistory();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          const dy = e.key === "ArrowUp"   ? -step : e.key === "ArrowDown"  ? step : 0;
          const toMove = new Set(indices);
          setAnnotations(prev => {
            const next = [...prev];
            toMove.forEach(i => { if (next[i]) next[i] = shiftAnnotation(next[i], dx, dy); });
            return next;
          });
          return;
        }
      }

      // Escape: if in a drawing/text tool → back to select; otherwise deselect
      if (e.key === "Escape") {
        e.preventDefault();
        if (textInputRef.current === document.activeElement) {
          // text input in progress — cancel it
          setTextInput(null);
          setTextValue("");
          setEditingIndex(null);
          setSelectedIndex(null);
        } else if (toolRef.current === "crop") {
          // cancel any pending crop rect, stay in crop mode so user can retry
          setCropRect(null);
          cropDragRef.current = null;
          setTool("select");
        } else if (toolRef.current !== "select") {
          // drawing tool active → switch back to select, keep selection
          setTool("select");
          setPreview(null);
          dragRef.current = null;
        } else {
          // already in select mode → deselect
          setSelectedIndex(null);
        }
      }

      // Space → pan mode
      if (e.key === " " && !spacePanningRef.current) {
        e.preventDefault();
        spacePanningRef.current = true;
        setSpaceDown(true);
        return;
      }

      // Ctrl+= → zoom in; Ctrl+- → zoom out; Ctrl+0 → fit
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomIn(); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomOut(); return; }
        if (e.key === "0") { e.preventDefault(); fitZoom(); return; }
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === " ") { spacePanningRef.current = false; setSpaceDown(false); panDragRef.current = null; }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup",   onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // ↑ intentionally minimal deps — we access state via refs below, keeping the handler stable

  // Ref mirrors so the keydown closure can read current values without recreating
  const selectedIndexRef = useRef<number | null>(null);
  useEffect(() => { selectedIndexRef.current = selectedIndex; }, [selectedIndex]);
  const selectedIndicesRef = useRef<number[]>([]);
  useEffect(() => { selectedIndicesRef.current = selectedIndices; }, [selectedIndices]);
  const toolRef = useRef<Tool>("select");
  useEffect(() => { toolRef.current = tool; }, [tool]);
  // Stable ref so keyboard handler closure can call applyCrop without stale closure
  const applyCropRef = useRef<(() => void) | null>(null);
  useEffect(() => { applyCropRef.current = applyCrop; });

  // ── Image insertion (Paste / Drag-Drop / File-Button) ───────────────────────

  /**
   * Read a Blob as a data-URL, load it into the image cache, and push a new image annotation.
   * @param stackIndex  When inserting multiple images at once, pass the 0-based index so each
   *                    image is offset by STACK_OFFSET px relative to the previous one.
   */
  const insertImageFromBlob = useCallback((blob: Blob, stackIndex = 0) => {
    const STACK_OFFSET = 20;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const el = new Image();
      el.onload = () => {
        imageElemCacheRef.current.set(dataUrl, el);

        // Position centered in the current viewport (canvas-pixel space)
        const vp = viewportRef.current;
        const canvas = canvasRef.current;
        let cx = (el.naturalWidth  / 2) + canvasOffsetX;
        let cy = (el.naturalHeight / 2) + canvasOffsetY;
        if (vp && canvas) {
          const scaleX = canvas.width  / (canvas.offsetWidth  || 1);
          const scaleY = canvas.height / (canvas.offsetHeight || 1);
          cx = (vp.scrollLeft + vp.clientWidth  / 2) * scaleX;
          cy = (vp.scrollTop  + vp.clientHeight / 2) * scaleY;
        }
        // Default size: natural size, but cap at 600 × 400
        const w = Math.min(el.naturalWidth,  600);
        const h = el.naturalWidth > 0 ? Math.round(el.naturalHeight * (w / el.naturalWidth)) : 200;
        // Stagger each image by STACK_OFFSET so multiple images don't pile up
        const x = cx - w / 2 + stackIndex * STACK_OFFSET;
        const y = cy - h / 2 + stackIndex * STACK_OFFSET;

        pushHistory();
        setAnnotations(prev => {
          const next = [...prev, { kind: "image" as const, x, y, width: w, height: h, dataUrl }];
          setSelectedIndex(next.length - 1);
          return next;
        });
        setTool("select");
        redrawRef.current();
      };
      el.src = dataUrl;
    };
    reader.readAsDataURL(blob);
  }, [canvasOffsetX, canvasOffsetY, pushHistory]);

  // Paste: Ctrl+V with an image on the clipboard
  useEffect(() => {
    if (!open) return;
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (blob) insertImageFromBlob(blob);
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open, insertImageFromBlob]);

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function handleSave() {
    const canvas = canvasRef.current;
    const img    = imgRef.current;
    if (!canvas || !img || !imgLoaded) return;
    setSaving(true);
    try {
      // Export onto a fresh offscreen canvas — no selection glows, no UI-only bounding boxes.
      const w = img.naturalWidth  + canvasOffsetX + canvasPaddingRight;
      const h = img.naturalHeight + canvasOffsetY + canvasPaddingBottom;
      const off = document.createElement("canvas");
      off.width  = w;
      off.height = h;
      const octx = off.getContext("2d")!;
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, w, h);
      octx.drawImage(img, canvasOffsetX, canvasOffsetY);
      annotations.forEach(ann => renderAnnotation(octx, ann, false, imageElemCacheRef.current));

      const blob = await new Promise<Blob>((resolve, reject) => {
        off.toBlob((b) => b ? resolve(b) : reject(new Error("Canvas toBlob fehlgeschlagen")), "image/png");
      });
      const canvasOffsets: CanvasOffsets = {
        x: canvasOffsetX,
        y: canvasOffsetY,
        right: canvasPaddingRight,
        bottom: canvasPaddingBottom,
      };
      await onSave(blob, annotations, canvasOffsets);
    } finally {
      setSaving(false);
    }
  }

  // ── Canvas cursor ─────────────────────────────────────────────────────────────

  const cropActiveDrag = cropDragRef.current;
  const cursor =
    tool === "crop" ? (
      cropActiveDrag?.kind === "move" || (!cropActiveDrag && cropHitArea === "move")                           ? "move" :
      (cropActiveDrag?.kind === "resize" && (cropActiveDrag.handle === "nw" || cropActiveDrag.handle === "se")) ||
        (!cropActiveDrag && (cropHitArea === "nw" || cropHitArea === "se"))                                    ? "nwse-resize" :
      (cropActiveDrag?.kind === "resize" && (cropActiveDrag.handle === "ne" || cropActiveDrag.handle === "sw")) ||
        (!cropActiveDrag && (cropHitArea === "ne" || cropHitArea === "sw"))                                    ? "nesw-resize" :
      (cropActiveDrag?.kind === "resize" && (cropActiveDrag.handle === "n" || cropActiveDrag.handle === "s")) ||
        (!cropActiveDrag && (cropHitArea === "n" || cropHitArea === "s"))                                      ? "ns-resize" :
      (cropActiveDrag?.kind === "resize" && (cropActiveDrag.handle === "e" || cropActiveDrag.handle === "w")) ||
        (!cropActiveDrag && (cropHitArea === "e" || cropHitArea === "w"))                                      ? "ew-resize" :
      "crosshair"
    ) :
    tool !== "select"                  ? (tool === "text" ? "text" : "crosshair") :
    dragRef.current?.kind === "handle" ? (dragRef.current.handle === "rotate" ? "grabbing" : "grabbing") :
    panDragRef.current                 ? "grabbing" :
    spaceDown                          ? "grab" :
    dragRef.current?.kind === "move"   ? "grabbing" :
    overHandle === "rotate"            ? "grab" :
    overHandle === "resize"            ? "nwse-resize" :
    overHandle === "text-resize"       ? "ew-resize" :
    overHandle === "endpoint"          ? "grab" :
    overBody                           ? "move" :
    "default";

  return (
    <>
    <AlertDialog open={showExitConfirm} onOpenChange={setShowExitConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Annotationen verwerfen?</AlertDialogTitle>
          <AlertDialogDescription>
            Es gibt nicht gespeicherte Annotationen. Beim Schließen gehen alle Änderungen verloren.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Weiter bearbeiten</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onClose}
          >
            Verwerfen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={open} onOpenChange={(o) => { if (!o) requestClose(); }}>
      <DialogContent
        className="w-fit max-w-[98vw] max-h-[96vh] flex flex-col p-0 gap-0 overflow-hidden"
        style={{ minWidth: "min(98vw, 900px)" }}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="h-4 w-4" />
            Bild annotieren
            <button
              type="button"
              title="Hilfe anzeigen"
              onClick={() => {
                setHelpOpen(true);
                markHelpSeen();
              }}
              className="relative h-8 w-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <HelpCircle className="h-5 w-5" />
              {!helpSeen && (
                <span className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5 pointer-events-none">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
                </span>
              )}
            </button>
          </DialogTitle>
        </DialogHeader>
        <AnnotationHelpDialog open={helpOpen} onOpenChange={setHelpOpen} initialTab={helpAssets?.tutorialVideoUrl ? "video" : "tools"} assets={helpAssets} />

        {/* ── Video-Tutorial-Callout (einmalig, bis geschlossen/angesehen) ────── */}
        {!videoHintDismissed && !!helpAssets?.tutorialVideoUrl && (
          <div className="mx-4 mb-2 shrink-0 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2">
            <button
              type="button"
              onClick={() => {
                dismissVideoHint();
                markHelpSeen();
                setHelpOpen(true);
              }}
              className="flex items-center gap-3 flex-1 min-w-0 text-left group"
              data-testid="button-video-tutorial-hint"
            >
              <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground group-hover:scale-105 transition-transform">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 ml-0.5"><path d="M8 5v14l11-7z" /></svg>
                <span className="absolute inset-0 rounded-full animate-ping bg-primary opacity-30 pointer-events-none" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium truncate">
                  Neu: 90-Sekunden-Video-Tutorial ansehen
                </span>
                <span className="block text-xs text-muted-foreground truncate">
                  Alle Werkzeuge, Tastenkürzel und Tricks – kurz erklärt, mit Ton und Untertiteln.
                </span>
              </span>
            </button>
            <button
              type="button"
              title="Hinweis ausblenden"
              onClick={dismissVideoHint}
              className="shrink-0 h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              data-testid="button-dismiss-video-hint"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
        )}

        {/* ── Toolbar: Two-row contextual ribbon ─────────────────────────────── */}
        <div className="flex flex-col border-b bg-muted/20 shrink-0">

          {/* ── Row 1: Always-visible compact action bar ── */}
          <div className="flex items-stretch">

            {/* Werkzeuge */}
            <div className="flex items-center gap-0.5 px-2 py-1 border-r">
              {([
                { id: "select",  icon: <MousePointer className="h-4 w-4" />, title: "Auswählen / Verschieben [V]" },
                { id: "arrow",   icon: <ArrowRight   className="h-4 w-4" />, title: "Pfeil zeichnen [A]" },
                { id: "line",    icon: <Minus        className="h-4 w-4" />, title: "Linie zeichnen [L]" },
                { id: "circle",  icon: <Circle       className="h-4 w-4" />, title: "Kreis zeichnen [C]" },
                { id: "ellipse", icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><ellipse cx="12" cy="12" rx="10" ry="6" /></svg>, title: "Ellipse zeichnen [E]" },
                { id: "rect",    icon: <Square       className="h-4 w-4" />, title: "Rechteck zeichnen [R]" },
                { id: "text",    icon: <Type         className="h-4 w-4" />, title: "Text [T]" },
              ] as const).map(({ id, icon, title }) => (
                <button key={id} type="button" title={title} onClick={() => { setTool(id as Tool); setCropRect(null); }}
                  className={cn("h-8 w-8 flex items-center justify-center rounded transition-colors",
                    tool === id ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                  {icon}
                </button>
              ))}
              <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
              <button type="button" title="Bild zuschneiden [X]" onClick={() => { setTool("crop"); setCropRect(null); }}
                className={cn("h-8 w-8 flex items-center justify-center rounded transition-colors",
                  tool === "crop" ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                <Crop className="h-4 w-4" />
              </button>
              <div className="w-px h-6 bg-border mx-0.5 shrink-0" />
              <button type="button" title="Bild einfügen — auch per Strg+V oder Drag & Drop"
                onClick={() => fileInputRef.current?.click()}
                className="h-8 w-8 flex items-center justify-center rounded transition-colors hover:bg-muted">
                <ImagePlus className="h-4 w-4" />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  files.forEach((f, i) => insertImageFromBlob(f, i));
                  e.target.value = "";
                }} />
            </div>

            {/* Bearbeiten */}
            <div className="flex items-center gap-0.5 px-2 py-1 border-r">
              <Button type="button" variant="ghost" size="sm" title="Rückgängig [Ctrl+Z]" disabled={!canUndo} onClick={handleUndo} className="h-8 w-8 p-0">
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" title="Wiederholen [Ctrl+Y]" disabled={!canRedo} onClick={handleRedo} className="h-8 w-8 p-0">
                <Redo2 className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm"
                title={smartDuplOffset
                  ? `Annotation duplizieren [Ctrl+D] — gespeicherter Abstand: Δ${Math.round(smartDuplOffset.dx)} / ${Math.round(smartDuplOffset.dy)} px`
                  : "Annotation duplizieren [Ctrl+D]"}
                disabled={selectedIndices.length === 0} onClick={handleDuplicate} className="h-8 w-8 p-0">
                <Copy className="h-4 w-4" />
              </Button>
              <Button type="button" variant="ghost" size="sm" title="Ausgewählte Annotation löschen [Del]" disabled={selectedIndices.length === 0} onClick={handleDelete} className="h-8 w-8 p-0 text-destructive hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            {/* Farbe */}
            <div className="flex items-center gap-1 px-2 py-1 border-r">
              {COLORS.map((c) => (
                <button key={c} type="button" title={c}
                  onClick={() => { setColor(c); updateSelected({ color: c }); }}
                  style={{ background: c, borderColor: color === c ? "#3b82f6" : "#d1d5db" }}
                  className={cn("w-5 h-5 rounded-sm border-2 transition-transform shrink-0", color === c && "scale-125 ring-1 ring-blue-500")} />
              ))}
            </div>

            {/* Spacer */}
            <div className="flex-1 min-w-2" />

            {/* Zoom */}
            <div className="flex items-center gap-0.5 px-2 py-1 border-l">
              <button type="button" title="Verkleinern (Ctrl+−)" onClick={zoomOut} className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"><ZoomOut className="h-4 w-4" /></button>
              <button type="button" title="Zoom zurücksetzen (100 %)" onClick={() => applyZoom(1)} className="h-7 px-2 text-xs rounded hover:bg-muted transition-colors tabular-nums min-w-[3.5rem] text-center">{Math.round(zoom * 100)} %</button>
              <button type="button" title="Vergrößern (Ctrl+=)" onClick={zoomIn} className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors"><ZoomIn className="h-4 w-4" /></button>
              <button type="button" title="Einpassen (Ctrl+0)" onClick={fitZoom} className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors border-l ml-0.5 pl-1"><Maximize2 className="h-4 w-4" /></button>
            </div>

            {/* Leinwand erweitern */}
            <div className="flex items-center gap-1.5 px-2 py-1 border-l">
              <div className="flex items-center gap-0.5">
                {([
                  { dir: "top"    as const, icon: <ArrowUp    className="h-4 w-4" />, label: "oben"   },
                  { dir: "bottom" as const, icon: <ArrowDown  className="h-4 w-4" />, label: "unten"  },
                  { dir: "left"   as const, icon: <ArrowLeft  className="h-4 w-4" />, label: "links"  },
                  { dir: "right"  as const, icon: <ArrowRight className="h-4 w-4" />, label: "rechts" },
                ]).map(({ dir, icon, label }) => (
                  <button key={dir} type="button" title={`Weißen Rand ${label} hinzufügen (+${expandPx} px)`} onClick={() => addPadding(dir)} className="h-8 w-8 flex items-center justify-center rounded hover:bg-muted transition-colors">{icon}</button>
                ))}
              </div>
              <div className="flex items-center gap-0.5 border-l pl-1.5">
                <span className="text-[11px] text-muted-foreground select-none mr-0.5">Schritt:</span>
                {[100, 200, 400].map((preset) => (
                  <button key={preset} type="button" title={`Schrittweite ${preset} px`} onClick={() => setExpandPx(preset)}
                    className={cn("h-6 px-1.5 text-xs rounded transition-colors tabular-nums", expandPx === preset ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground border")}>
                    {preset}
                  </button>
                ))}
                <input type="number" min={50} max={2000} step={50} value={expandPx}
                  onChange={(e) => setExpandPx(Math.min(2000, Math.max(50, Number(e.target.value) || 50)))}
                  title="Eigene Schrittweite in Pixeln (50–2000)"
                  className="w-14 h-6 text-xs border rounded px-1.5 bg-background outline-none focus:ring-1 focus:ring-ring ml-0.5 tabular-nums" />
                <span className="text-[11px] text-muted-foreground select-none">px</span>
              </div>
              <button type="button" title="Leinwand auf Inhalt zuschneiden" onClick={trimCanvas} className="h-7 w-7 flex items-center justify-center rounded transition-colors border hover:bg-muted cursor-pointer">
                <Crop className="h-3.5 w-3.5" />
              </button>
            </div>

          </div>{/* end Row 1 */}

          {/* ── Crop confirmation bar — shown while crop tool is active ── */}
          {tool === "crop" && (
            <div className="flex items-center gap-2 px-3 py-1.5 border-t bg-amber-50 dark:bg-amber-950/30 text-sm">
              <Crop className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-amber-800 dark:text-amber-300 flex-1 min-w-0 truncate">
                {cropRect && Math.abs(cropRect.x2 - cropRect.x1) > 4 && Math.abs(cropRect.y2 - cropRect.y1) > 4
                  ? `${imageCropMode ? "Bild zuschneiden" : "Ausschnitt"}: ${Math.round(Math.abs(cropRect.x2 - cropRect.x1))} × ${Math.round(Math.abs(cropRect.y2 - cropRect.y1))} px — Anwenden oder Abbrechen`
                  : imageCropMode
                    ? "Zuschnittbereich im Bild aufziehen, dann bestätigen [Enter]"
                    : "Zuschneidbereich aufziehen, dann bestätigen [Enter]"}
              </span>
              <Button type="button" size="sm" className="h-7 shrink-0"
                disabled={!cropRect || Math.abs(cropRect.x2 - cropRect.x1) <= 4 || Math.abs(cropRect.y2 - cropRect.y1) <= 4}
                onClick={applyCrop}
                data-testid="button-apply-crop"
              >
                Anwenden [↵]
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 shrink-0"
                onClick={() => { setCropRect(null); setTool("select"); }}
                data-testid="button-cancel-crop"
              >
                Abbrechen [Esc]
              </Button>
            </div>
          )}

          {/* ── Row 2: Contextual property bar — shown when a tool is active or annotation selected ── */}
          {(tool !== "select" || selectedIndices.length > 0) && tool !== "crop" && (() => {
            const ann = selectedIndex != null ? annotations[selectedIndex] : null;
            const isImage = ann?.kind === "image";
            const isTextAnn = ann?.kind === "text";
            const textVisible = tool === "text" || isTextAnn;
            const FILL_KINDS = new Set(["circle", "ellipse", "rect"]);
            const fillApplicable = FILL_KINDS.has(tool) || selectedIndices.some(i => FILL_KINDS.has(annotations[i]?.kind));
            const applyImg = (patch: Partial<ImageAnnotation>) => updateSelected(patch as Record<string, unknown>);
            const shadowRgba = (() => {
              const hex = imgShadowColor.replace("#", "");
              const r = parseInt(hex.slice(0,2), 16), g = parseInt(hex.slice(2,4), 16), b = parseInt(hex.slice(4,6), 16);
              return `rgba(${r},${g},${b},${(imgShadowAlpha / 100).toFixed(2)})`;
            })();

            return (
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-t bg-background/50 flex-wrap min-h-[44px]">

                {/* ── Non-image: Format controls ── */}
                {!isImage && (<>

                  {/* Text bearbeiten — only when text annotation is selected */}
                  {isTextAnn && (
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs shrink-0"
                      title="Text der Annotation bearbeiten"
                      onClick={() => {
                        if (selectedIndex == null) return;
                        const a = annotations[selectedIndex] as TextAnnotation;
                        setEditingIndex(selectedIndex);
                        setTextInput({ x: a.x, y: a.y });
                        setTextValue(a.text);
                        setColor(a.color);
                        setFontSize(a.fontSize);
                        setTextBold(a.bold ?? false);
                        setTextItalic(a.italic ?? false);
                        setTextUnderline(a.underline ?? false);
                        setTextStrikethrough(a.strikethrough ?? false);
                      }}>
                      <Pencil className="h-3.5 w-3.5" /> Text bearbeiten
                    </Button>
                  )}

                  {/* Line width */}
                  <div className="flex items-center gap-1 border rounded px-2 h-7 bg-background text-xs shrink-0">
                    <span className="text-muted-foreground select-none">Linie</span>
                    <select value={lineWidth} onChange={(e) => { const w = Number(e.target.value); setLineWidth(w); updateSelected({ lineWidth: w }); }}
                      className="bg-transparent text-xs outline-none cursor-pointer" title="Linienstärke">
                      {[1, 2, 4, 6].map((w) => <option key={w} value={w}>{w} px</option>)}
                    </select>
                  </div>

                  {/* Font size — only for text */}
                  {textVisible && (() => {
                    const SIZES = [10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];
                    const applySize = (s: number) => { setFontSize(s); updateSelected({ fontSize: s }); };
                    const stepDown = () => { const idx = SIZES.indexOf(fontSize); applySize(idx > 0 ? SIZES[idx-1] : SIZES.findLast(s => s < fontSize) ?? SIZES[0]); };
                    const stepUp   = () => { const idx = SIZES.indexOf(fontSize); const last = SIZES[SIZES.length-1]; applySize(idx >= 0 ? (SIZES[idx+1] ?? last) : SIZES.find(s => s > fontSize) ?? last); };
                    return (
                      <div className="flex items-center gap-1 shrink-0">
                        <div className="flex items-center gap-0.5 border rounded h-7 px-1.5 bg-background text-xs">
                          <span className="text-muted-foreground select-none">Schrift</span>
                          <select value={fontSize} onChange={(e) => applySize(Number(e.target.value))} className="bg-transparent text-xs outline-none cursor-pointer" title="Schriftgröße">
                            {SIZES.map((s) => <option key={s} value={s}>{s} px</option>)}
                          </select>
                        </div>
                        <button type="button" title="Schriftgrad vergrößern" onClick={stepUp} disabled={fontSize >= 64} className="h-7 w-7 flex items-center justify-center border rounded bg-background hover:bg-muted disabled:opacity-30 transition-colors select-none relative">
                          <span className="font-bold leading-none" style={{ fontSize: 14 }}>A</span>
                          <svg width="7" height="6" viewBox="0 0 7 6" fill="currentColor" className="absolute bottom-1 right-1"><polygon points="3.5,0 7,6 0,6" /></svg>
                        </button>
                        <button type="button" title="Schriftgrad verkleinern" onClick={stepDown} disabled={fontSize <= 10} className="h-7 w-7 flex items-center justify-center border rounded bg-background hover:bg-muted disabled:opacity-30 transition-colors select-none relative">
                          <span className="font-bold leading-none" style={{ fontSize: 14 }}>A</span>
                          <svg width="7" height="6" viewBox="0 0 7 6" fill="currentColor" className="absolute bottom-1 right-1"><polygon points="0,0 7,0 3.5,6" /></svg>
                        </button>
                      </div>
                    );
                  })()}

                  {/* Text formatting B/I/U/S — only for text */}
                  {textVisible && (
                    <div className="flex items-center gap-0.5 border rounded px-1 h-7 bg-background shrink-0">
                      {([
                        { field: "bold"          as const, Icon: Bold,          active: textBold,          setter: setTextBold,          title: "Fett [Ctrl+B]"            },
                        { field: "italic"        as const, Icon: Italic,        active: textItalic,        setter: setTextItalic,        title: "Kursiv [Ctrl+I]"          },
                        { field: "underline"     as const, Icon: Underline,     active: textUnderline,     setter: setTextUnderline,     title: "Unterstrichen [Ctrl+U]"   },
                        { field: "strikethrough" as const, Icon: Strikethrough, active: textStrikethrough, setter: setTextStrikethrough, title: "Durchgestrichen [Ctrl+S]" },
                      ]).map(({ field, Icon, active, setter, title }) => (
                        <button key={field} type="button" title={title}
                          onClick={() => { setter(!active); if (selectedIndex != null && annotations[selectedIndex]?.kind === "text") updateSelected({ [field]: !active || undefined }); }}
                          className={cn("h-6 w-6 flex items-center justify-center rounded transition-colors", active ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Fill opacity — dimmed when not applicable */}
                  <div className={cn("flex items-center gap-1.5 border-2 rounded-md px-2 h-7 bg-background transition-opacity shrink-0",
                    fillApplicable ? "border-primary/40 shadow-sm" : "opacity-40 pointer-events-none border-border")} title="Füllung / Transparenz">
                    <button type="button" title={fillOpacity > 0 ? "Füllung deaktivieren" : "Füllung aktivieren"}
                      onClick={() => { const next = fillOpacity > 0 ? 0 : 100; setFillOpacity(next); if (selectedIndices.length > 0) updateSelected({ fillOpacity: next, fill: undefined }); }}
                      className={cn("h-5 w-5 flex items-center justify-center rounded transition-colors shrink-0", fillOpacity > 0 ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted")}>
                      <PaintBucket className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-xs text-muted-foreground select-none">Füllung</span>
                    <input type="range" min={1} max={100} step={1} value={fillOpacity || 1}
                      onChange={(e) => { const v = Number(e.target.value); setFillOpacity(v); if (selectedIndices.length > 0) updateSelected({ fillOpacity: v, fill: undefined }); }}
                      className={cn("w-16 h-1.5 accent-primary cursor-pointer", fillOpacity === 0 && "opacity-40")} />
                    <input type="number" min={1} max={100} value={fillOpacity || 1}
                      onChange={(e) => { const v = Math.min(100, Math.max(1, Number(e.target.value) || 1)); setFillOpacity(v); if (selectedIndices.length > 0) updateSelected({ fillOpacity: v, fill: undefined }); }}
                      onWheel={(e) => { e.preventDefault(); const v = Math.min(100, Math.max(1, fillOpacity + (e.deltaY < 0 ? 1 : -1))); setFillOpacity(v); if (selectedIndices.length > 0) updateSelected({ fillOpacity: v, fill: undefined }); }}
                      className={cn("w-10 text-xs text-right tabular-nums bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary rounded px-0.5 text-muted-foreground", fillOpacity === 0 && "opacity-40")} />
                    <span className="text-xs text-muted-foreground select-none -ml-1">%</span>
                  </div>

                </>)}

                {/* ── Image annotation: Bild-Stil controls ── */}
                {isImage && (<>

                  {/* Deckkraft */}
                  <SliderNum label="Deckkraft" min={10} max={100} value={imgOpacity} unit="%"
                    onChange={(v) => { setImgOpacity(v); applyImg({ opacity: v }); }} />

                  <div className="w-px h-5 bg-border shrink-0" />

                  {/* Helligkeit + Kontrast */}
                  <SliderNum label="☀" min={50} max={150} value={imgBrightness} unit="%"
                    onChange={(v) => { setImgBrightness(v); applyImg({ brightness: v }); }} />
                  <SliderNum label="◑" min={50} max={150} value={imgContrast} unit="%"
                    onChange={(v) => { setImgContrast(v); applyImg({ contrast: v }); }} />
                  {(imgBrightness !== 100 || imgContrast !== 100) && (
                    <button type="button" title="Helligkeit & Kontrast zurücksetzen"
                      onClick={() => { setImgBrightness(100); setImgContrast(100); applyImg({ brightness: 100, contrast: 100 }); }}
                      className="h-7 w-7 flex items-center justify-center rounded border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors shrink-0 text-base">↺</button>
                  )}

                  <div className="w-px h-5 bg-border shrink-0" />

                  {/* Spiegeln */}
                  <div className="flex items-center border rounded h-7 bg-background overflow-hidden shrink-0">
                    <button type="button" title="Horizontal spiegeln (↔)"
                      onClick={() => { const n = !imgFlipH; setImgFlipH(n); applyImg({ flipH: n }); }}
                      className={cn("h-7 px-2 text-sm transition-colors", imgFlipH ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>↔</button>
                    <button type="button" title="Vertikal spiegeln (↕)"
                      onClick={() => { const n = !imgFlipV; setImgFlipV(n); applyImg({ flipV: n }); }}
                      className={cn("h-7 px-2 text-sm transition-colors", imgFlipV ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>↕</button>
                  </div>

                  <div className="w-px h-5 bg-border shrink-0" />

                  {/* Eckenradius */}
                  <SliderNum label="⌐ Radius" min={0} max={80} step={2} value={imgBorderRadius}
                    onChange={(v) => { setImgBorderRadius(v); applyImg({ borderRadius: v }); }} />

                  {/* Rahmenstärke */}
                  <SliderNum label="Rahmen" min={0} max={20} value={imgBorderWidth}
                    onChange={(v) => { setImgBorderWidth(v); applyImg({ borderWidth: v }); }} />

                  {imgBorderWidth > 0 && (<>
                    <input type="color" value={imgBorderColor}
                      onChange={(e) => { setImgBorderColor(e.target.value); applyImg({ borderColor: e.target.value }); }}
                      className="h-7 w-7 rounded border cursor-pointer p-0.5 bg-background shrink-0" title="Rahmenfarbe" />
                    <div className="flex items-center border rounded h-7 bg-background overflow-hidden shrink-0">
                      {(["solid", "dashed", "dotted"] as const).map((s) => (
                        <button key={s} type="button"
                          title={s === "solid" ? "Durchgezogen" : s === "dashed" ? "Gestrichelt" : "Gepunktet"}
                          onClick={() => { setImgBorderStyle(s); applyImg({ borderStyle: s }); }}
                          className={cn("h-7 px-2 text-[10px] font-mono transition-colors", imgBorderStyle === s ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}>
                          {s === "solid" ? "—" : s === "dashed" ? "- -" : "···"}
                        </button>
                      ))}
                    </div>
                  </>)}

                  <div className="w-px h-5 bg-border shrink-0" />

                  {/* Schatten toggle */}
                  <button type="button" title={imgShadowOn ? "Schatten deaktivieren" : "Schatten aktivieren"}
                    onClick={() => {
                      const next = !imgShadowOn; setImgShadowOn(next);
                      applyImg({ shadowBlur: next ? imgShadowBlur : 0, shadowColor: next ? shadowRgba : undefined, shadowOffsetX: next ? imgShadowX : undefined, shadowOffsetY: next ? imgShadowY : undefined });
                    }}
                    className={cn("h-7 w-7 flex items-center justify-center rounded border shrink-0 transition-colors",
                      imgShadowOn ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted text-muted-foreground")}>
                    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                      <rect x="1" y="3" width="10" height="10" rx="1" opacity="0.3"/>
                      <rect x="0" y="2" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5"/>
                    </svg>
                  </button>

                  {imgShadowOn && (<>
                    <SliderNum label="Unschärfe" min={0} max={40} value={imgShadowBlur}
                      onChange={(v) => { setImgShadowBlur(v); applyImg({ shadowBlur: v, shadowColor: shadowRgba }); }} />
                    <div className="flex items-center gap-1 border rounded px-2 h-7 bg-background text-xs shrink-0" title="Schattenfarbe & Deckkraft">
                      <input type="color" value={imgShadowColor}
                        onChange={(e) => {
                          setImgShadowColor(e.target.value);
                          const hex = e.target.value.replace("#","");
                          const r = parseInt(hex.slice(0,2),16), g = parseInt(hex.slice(2,4),16), b = parseInt(hex.slice(4,6),16);
                          applyImg({ shadowColor: `rgba(${r},${g},${b},${(imgShadowAlpha/100).toFixed(2)})` });
                        }}
                        className="h-5 w-5 rounded border cursor-pointer p-0 bg-background shrink-0" title="Schattenfarbe" />
                      <span className="text-muted-foreground select-none shrink-0">α</span>
                      <input type="range" min={5} max={100} step={5} value={imgShadowAlpha}
                        onChange={(e) => { const a = Number(e.target.value); setImgShadowAlpha(a); applyImg({ shadowColor: shadowRgba }); }}
                        className="w-10 h-1.5 accent-primary cursor-pointer" />
                      <input type="number" min={5} max={100} step={5} value={imgShadowAlpha}
                        onChange={(e) => { const a = Math.min(100,Math.max(5,Number(e.target.value)||5)); setImgShadowAlpha(a); applyImg({ shadowColor: shadowRgba }); }}
                        onWheel={(e) => { e.preventDefault(); const a = Math.min(100,Math.max(5,imgShadowAlpha+(e.deltaY<0?5:-5))); setImgShadowAlpha(a); applyImg({ shadowColor: shadowRgba }); }}
                        className="w-8 text-xs text-right tabular-nums bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary rounded px-0.5 text-muted-foreground" />
                      <span className="text-muted-foreground select-none -ml-1">%</span>
                    </div>
                    <div className="flex items-center gap-1 border rounded px-2 h-7 bg-background text-xs shrink-0" title="Schattenversatz X / Y">
                      <span className="text-muted-foreground select-none shrink-0">X</span>
                      <input type="number" min={-40} max={40} step={1} value={imgShadowX}
                        onChange={(e) => { const v=Number(e.target.value); setImgShadowX(v); applyImg({ shadowOffsetX: v }); }}
                        onWheel={(e) => { e.preventDefault(); const v=Math.min(40,Math.max(-40,imgShadowX+(e.deltaY<0?1:-1))); setImgShadowX(v); applyImg({ shadowOffsetX: v }); }}
                        className="w-8 text-xs text-right tabular-nums bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary rounded px-0.5 text-muted-foreground" />
                      <span className="text-muted-foreground select-none shrink-0">Y</span>
                      <input type="number" min={-40} max={40} step={1} value={imgShadowY}
                        onChange={(e) => { const v=Number(e.target.value); setImgShadowY(v); applyImg({ shadowOffsetY: v }); }}
                        onWheel={(e) => { e.preventDefault(); const v=Math.min(40,Math.max(-40,imgShadowY+(e.deltaY<0?1:-1))); setImgShadowY(v); applyImg({ shadowOffsetY: v }); }}
                        className="w-8 text-xs text-right tabular-nums bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary rounded px-0.5 text-muted-foreground" />
                    </div>
                  </>)}

                </>)}

              </div>
            );
          })()}

        </div>{/* end toolbar */}

        {/* Canvas area */}
        <div
          ref={viewportRef}
          className="relative overflow-auto flex-1 min-h-0 bg-zinc-800 p-2"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
          onDrop={(e) => {
            e.preventDefault();
            const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
            if (imageFiles.length > 0) {
              imageFiles.forEach((f, i) => insertImageFromBlob(f, i));
              return;
            }
            // Also handle drag from browser (dragged image element)
            const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
            if (url && /^https?:\/\//.test(url)) {
              fetch(url).then(r => r.blob()).then(b => insertImageFromBlob(b, 0)).catch(() => {});
            }
          }}
        >
          {imgError && (
            <div className="flex items-center justify-center h-48 text-destructive text-sm">
              Bild konnte nicht geladen werden.
            </div>
          )}
          {!imgLoaded && !imgError && (
            <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
              Lädt…
            </div>
          )}
          {imgLoaded && (
            <div className="relative inline-block">
              <canvas
                ref={canvasRef}
                style={{
                  cursor,
                  display: "block",
                  backgroundColor: "white",
                  // Display at 1.5× natural size; the pixel resolution stays the
                  // same so getBoundingClientRect() returns the scaled dimensions
                  // and the overlay-positioning code works without changes.
                  width:  imgRef.current ? Math.round((imgRef.current.naturalWidth  + canvasOffsetX + canvasPaddingRight)  * 1.5 * zoom) : undefined,
                  height: imgRef.current ? Math.round((imgRef.current.naturalHeight + canvasOffsetY + canvasPaddingBottom) * 1.5 * zoom) : undefined,
                  imageRendering: "auto",
                }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                onDoubleClick={handleDoubleClick}
              />
              {/* Text input overlay */}
              {textInput && (() => {
                const canvas = canvasRef.current;
                if (!canvas) return null;
                const rect = canvas.getBoundingClientRect();
                const scaleX = rect.width / canvas.width;
                const scaleY = rect.height / canvas.height;
                const left = textInput.x * scaleX;
                const top  = textInput.y * scaleY;
                return (
                  <div
                    className="absolute flex items-start gap-1"
                    style={{ left, top }}
                  >
                    <textarea
                      ref={textInputRef}
                      value={textValue}
                      rows={3}
                      onChange={(e) => setTextValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmText(); }
                        if (e.key === "Escape") { setTextInput(null); setTextValue(""); setEditingIndex(null); }
                      }}
                      placeholder={"Text eingeben…\n(↵ Bestätigen, Shift+↵ Zeilenumbruch)"}
                      className="text-sm bg-white/90 dark:bg-zinc-900/90 border rounded px-2 py-1 resize outline-none leading-snug"
                      style={{
                        fontWeight:     textBold          ? "700"         : undefined,
                        fontStyle:      textItalic        ? "italic"      : undefined,
                        textDecoration: [
                          textUnderline     && "underline",
                          textStrikethrough && "line-through",
                        ].filter(Boolean).join(" ") || undefined,
                        minWidth: "10rem",
                        width: "12rem",
                        minHeight: "3rem",
                      }}
                    />
                    <Button
                      type="button" size="sm" className="h-7 px-2 text-xs"
                      onClick={confirmText}
                    >OK</Button>
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <DialogFooter className="px-4 py-3 border-t shrink-0">
          <span className="text-xs text-muted-foreground mr-auto self-center">
            {selectedIndices.length > 1
              ? `${selectedIndices.length} Objekte ausgewählt · Ziehen zum Verschieben · Strg+Ziehen zum Kopieren · Entf zum Löschen`
              : tool === "arrow"  ? "Klicken & ziehen um einen Pfeil zu zeichnen"
              : tool === "line"   ? "Klicken & ziehen um eine Linie zu zeichnen"
              : tool === "circle"  ? "Klicken & ziehen um einen Kreis zu zeichnen"
              : tool === "ellipse" ? "Klicken & ziehen um eine Ellipse zu zeichnen · Shift = Kreis"
              : tool === "rect"    ? "Klicken & ziehen um ein Rechteck zu zeichnen"
              : tool === "text"   ? "Klicken um ein Textetikett zu platzieren"
              : "Annotation anklicken · Shift+Klick für Mehrfachauswahl · Ziehen zum Verschieben · Strg+Ziehen zum Kopieren"}
          </span>
          <Button type="button" variant="outline" onClick={requestClose} disabled={saving}>
            Abbrechen
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving || !imgLoaded}>
            {saving ? "Speichert…" : "Fertig"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/** Returns the rotation handle position for an image annotation (above the top edge, rotated). */
function imageRotHandlePos(ann: ImageAnnotation): { hx: number; hy: number; lx: number; ly: number } {
  const rcx = ann.x + ann.width / 2, rcy = ann.y + ann.height / 2;
  const rot = ann.rotation ?? 0;
  const topPt    = rotatePoint(rcx, rcy - ann.height / 2,                     rcx, rcy, rot);
  const handlePt = rotatePoint(rcx, rcy - ann.height / 2 - ROTATION_HANDLE_DIST, rcx, rcy, rot);
  return { hx: handlePt.x, hy: handlePt.y, lx: topPt.x, ly: topPt.y };
}

/** Returns the rotation handle position for an ellipse or rect (above the top edge, rotated). */
function rotationHandlePos(ann: EllipseAnnotation | RectAnnotation): { hx: number; hy: number; lx: number; ly: number } {
  if (ann.kind === "ellipse") {
    const rot = ann.rotation ?? 0;
    // Top centre in local frame = (cx, cy - ry); rotation handle is ROTATION_HANDLE_DIST further "up"
    const topPt = rotatePoint(ann.cx, ann.cy - ann.ry, ann.cx, ann.cy, rot);
    const handlePt = rotatePoint(ann.cx, ann.cy - ann.ry - ROTATION_HANDLE_DIST, ann.cx, ann.cy, rot);
    return { hx: handlePt.x, hy: handlePt.y, lx: topPt.x, ly: topPt.y };
  } else {
    const rcx = ann.x + ann.w / 2, rcy = ann.y + ann.h / 2;
    const rot = ann.rotation ?? 0;
    const topPt = rotatePoint(rcx, rcy - ann.h / 2, rcx, rcy, rot);
    const handlePt = rotatePoint(rcx, rcy - ann.h / 2 - ROTATION_HANDLE_DIST, rcx, rcy, rot);
    return { hx: handlePt.x, hy: handlePt.y, lx: topPt.x, ly: topPt.y };
  }
}
