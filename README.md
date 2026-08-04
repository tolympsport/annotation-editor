# @tolymp/annotation-editor

Eigenständiges React-Paket mit zwei Entry-Points:

1. **`@tolymp/annotation-editor`** — der reine `ImageAnnotationDialog`: Bild rein, `onSave(blob, annotations, canvasOffsets)` raus. Keine TipTap-Abhängigkeiten.
2. **`@tolymp/annotation-editor/tiptap`** — `RichTextEditor` inkl. `ResizableImage`-Node mit Annotations-Persistenz als `data-*`-Attribute und `onImageUpload`-Callback.

Das Paket hat keine Abhängigkeiten zu shadcn/ui, zur Tailwind-Konfiguration einer Host-App, zu Auth oder Backend-Routen. Alle App-spezifischen Belange (Upload, Benachrichtigungen, Hilfe-Assets) laufen über Callbacks/Props.

## Veröffentlichung in ein eigenes GitHub-Repo

Das Paket lebt im Workspace-Monorepo unter `packages/annotation-editor/`. Um es als GitHub-Dependency nutzbar zu machen, wird der Ordner (inkl. Historie) per `git subtree split` in ein eigenes Repo übertragen und die Version aus `package.json` getaggt:

```bash
# Einmalig: leeres Repo github.com/tolympsport/annotation-editor anlegen (ohne README)
# Dann im Root des Workspace-Repos:
./packages/annotation-editor/scripts/publish-to-github.sh
# oder mit anderer Remote-URL:
./packages/annotation-editor/scripts/publish-to-github.sh https://github.com/tolympsport/annotation-editor.git
```

Das Script pusht den Split-Branch als `main`, taggt `v<version>` und pusht den Tag. `dist/` wird **nicht** committet — beim Install aus Git baut das `prepare`-Script das Paket automatisch (Vite-Build, `d.ts`, `styles.css`).

Neues Release: Version in `package.json` erhöhen, committen, Script erneut ausführen.

Verifikation nach dem Publish:

```bash
mkdir -p /tmp/ae-verify && cd /tmp/ae-verify && npm init -y
npm install "github:tolympsport/annotation-editor#v1.0.0"
ls node_modules/@tolymp/annotation-editor/dist   # index.js, tiptap.js, *.d.ts, styles.css
```

## Installation

Als GitHub-Dependency (nach Veröffentlichung in ein eigenes Repo):

```jsonc
// package.json der Host-App
"dependencies": {
  "@tolymp/annotation-editor": "github:tolympsport/annotation-editor#v1.0.0"
}
```

Peer-Dependencies: `react`, `react-dom` (immer) sowie — **nur** wenn der `/tiptap`-Entry genutzt wird — `@tiptap/react`, `@tiptap/core`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/extension-underline`, `@tiptap/extension-placeholder`, `@tiptap/extension-text-align` (jeweils v3).

### Styling

Zwei Möglichkeiten:

- **Host ohne Tailwind** (z. B. Modulo-CAD): das mitgelieferte Stylesheet importieren. Es enthält alle benötigten Utility-Klassen plus Default-Design-Tokens mit niedriger Spezifität (`:where(:root)`), die eine Host-App per eigener `--primary`, `--background`, … CSS-Variablen überschreiben kann:

  ```ts
  import "@tolymp/annotation-editor/styles.css";
  ```

- **Host mit Tailwind v3 + shadcn-Tokens**: Paket-Quellen in den `content`-Glob der Host-Tailwind-Config aufnehmen (kein CSS-Import nötig):

  ```js
  content: [..., "./node_modules/@tolymp/annotation-editor/dist/**/*.js"]
  ```

### Host-App-Integration: Radix Dedupe (wichtig!)

Das Paket bringt eigene `@radix-ui/*`-Abhängigkeiten mit. Wenn die Host-App ebenfalls Radix verwendet, entstehen im Production-Bundle **zwei separate Radix-Kopien** — mit der Folge, dass jede Kopie ihren eigenen `DismissableLayer`-Stack verwaltet. Das führt dazu, dass ein `Escape`-Tastendruck **beide** Dialoge (den `ImageAnnotationDialog` und den umgebenden Host-Dialog) gleichzeitig schließt.

**Lösung:** In der `vite.config.ts` der Host-App alle gemeinsam genutzten Radix-Pakete deduplizieren:

```ts
// vite.config.ts der Host-App
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@radix-ui/react-dialog",
      "@radix-ui/react-popover",
      // … alle weiteren @radix-ui/*-Pakete, die Host und Paket gemeinsam nutzen
    ],
  },
});
```

Ohne diesen Eintrag funktioniert ESC im Development-Build korrekt (Vite dedupliziert dort beim Pre-Bundling automatisch), bricht aber im **Production-Build** ab.

---

## Entry-Point 1: `ImageAnnotationDialog`

```tsx
import {
  ImageAnnotationDialog,
  type Annotation,
  type CanvasOffsets,
} from "@tolymp/annotation-editor";

<ImageAnnotationDialog
  open={open}
  imageUrl={screenshotUrl}                 // Basis-Bild (unannotiert)
  initialAnnotations={savedAnnotations}    // Annotation[] | null — für nachträgliches Editieren
  initialCanvasOffsets={savedOffsets}      // CanvasOffsets | null — Leinwand-Erweiterung wiederherstellen
  onSave={async (blob, annotations, canvasOffsets) => {
    // blob: fertig gerendertes PNG; annotations + canvasOffsets: persistieren,
    // damit später nicht-destruktiv weiterbearbeitet werden kann.
  }}
  onClose={() => setOpen(false)}
  helpAssets={{                            // optional — ohne URL wird der jeweilige Hilfe-Tab ausgeblendet
    tutorialVideoUrl: "/annotation-tutorial.mp4",
    moduloScreenshotUrl: "/modulo-cad-screenshot.png",
  }}
/>
```

Funktionen: Pfeile, Linien, Kreise, Ellipsen, Rechtecke, Text (mit Formatierung), eingefügte Bilder (Stil-Parameter, Spiegeln, Helligkeit/Kontrast), Auswahl/Verschieben/Duplizieren mit Snapping, Undo/Redo, Zoom & Pan, Crop (Pointer-Capture-basiert – Rahmen hält exakt bis zum Bildrand), Leinwand-Erweiterung.

### Tastaturkürzel

| Taste | Verhalten |
|-------|-----------|
| `Escape` (1×) | Aktives Zeichenwerkzeug wird deaktiviert, Auswahl-Modus wird aktiv |
| `Escape` (2×) | Aktuell gewählte Annotation wird abgewählt |
| `Escape` (3×) | Dialog wird geschlossen (entspricht „Abbrechen" / `onClose`) |

## Entry-Point 2: `RichTextEditor` (TipTap)

```tsx
import RichTextEditor, {
  type RichTextEditorRef,
} from "@tolymp/annotation-editor/tiptap";

const ref = useRef<RichTextEditorRef>(null);

<RichTextEditor
  ref={ref}
  value={html}
  onChange={(html) => setHtml(html)}
  disabled={false}
  placeholder="Text eingeben …"
  onImageUpload={async (file) => {
    // App-spezifisch: Datei hochladen und finale URL zurückgeben.
    const url = await uploadToMyBackend(file);
    return url;
  }}
  onNotify={(n) => myToast(n)}             // optional: Fehler-/Statusmeldungen (z. B. Upload fehlgeschlagen)
  annotationHelpAssets={{ tutorialVideoUrl: "/annotation-tutorial.mp4" }} // optional
/>
```

Bilder im Editor sind resizable (8 Griffe) und per Doppelklick / „✏ Annotieren“-Button annotierbar. Die Annotationen werden **nicht-destruktiv** persistiert: das `<img>` erhält `data-annotations` (JSON-Array `Annotation[]`), `data-original-src` (unannotierte Basis) und `data-canvas-offset-*`/`data-canvas-padding-*`-Attribute; das angezeigte `src` ist das flach gerenderte PNG aus `onImageUpload`.

## Annotations-Datenformat (versioniert)

```ts
import {
  ANNOTATION_SCHEMA_VERSION,   // aktuell: 1
  createAnnotationDocument,    // Annotation[] → { schemaVersion, annotations, canvasOffsets? }
  parseAnnotationDocument,     // akzeptiert Bare-Array (v1-Wire-Format) UND Envelope
  type Annotation,
  type AnnotationDocument,
} from "@tolymp/annotation-editor";
```

- Das historische (und weiterhin von `data-annotations` genutzte) Wire-Format ist ein nacktes `Annotation[]`-Array — das entspricht Schema-Version 1.
- Für neue Integrationen wird der `AnnotationDocument`-Envelope mit explizitem `schemaVersion` empfohlen; `parseAnnotationDocument` liest beide Formen.
- Kompatibilitätsregeln (siehe `src/core/schema.ts`): neue optionale Felder innerhalb einer Version erlaubt; Semantikänderungen erfordern Versionssprung; Legacy-Felder (z. B. `fill` vs. `fillOpacity`) bleiben lesbar.

### Schatten-Eigenschaften (Circle, Ellipse, Rect)

`CircleAnnotation`, `EllipseAnnotation` und `RectAnnotation` unterstützen optionale Schatten-Felder:

| Feld | Typ | Beschreibung |
|------|-----|--------------|
| `shadowBlur` | `number` | Weichzeichnungsradius in px (0 = kein Schatten) |
| `shadowColor` | `string` | CSS-Farbe inkl. Alpha, z. B. `"rgba(0,0,0,0.5)"` |
| `shadowOffsetX` | `number` | Horizontaler Versatz in px |
| `shadowOffsetY` | `number` | Vertikaler Versatz in px |

Alle vier Felder sind optional; fehlen sie, wird kein Schatten gerendert. `ImageAnnotation` unterstützt dieselben Felder bereits seit v1.

## Integrationsbeispiel Modulo-CAD

```tsx
import { ImageAnnotationDialog, parseAnnotationDocument } from "@tolymp/annotation-editor";
import "@tolymp/annotation-editor/styles.css";

function ScreenshotAnnotator({ shot }: { shot: CadScreenshot }) {
  const saved = parseAnnotationDocument(shot.annotationsJson);
  return (
    <ImageAnnotationDialog
      open
      imageUrl={shot.pngUrl}
      initialAnnotations={saved?.annotations ?? null}
      initialCanvasOffsets={saved?.canvasOffsets ?? null}
      onSave={async (blob, annotations, canvasOffsets) => {
        await cadApi.saveAnnotatedScreenshot(shot.id, blob, { annotations, canvasOffsets });
      }}
      onClose={() => cadUi.closeAnnotator()}
    />
  );
}
```

## Entwicklung im TOLYMP-Workspace

Die TOLYMP-App bindet das Paket direkt aus dem Quellcode ein (eine Code-Quelle, kein Build nötig): `vite.config.ts` und `tsconfig.json` aliassen `@tolymp/annotation-editor[/tiptap]` auf `packages/annotation-editor/src/*`, und die Host-Tailwind-Config scannt `packages/annotation-editor/src`.

Paket-Build (für Veröffentlichung):

```bash
cd packages/annotation-editor
npm run build   # dist/index.js, dist/tiptap.js, *.d.ts, dist/styles.css
```
