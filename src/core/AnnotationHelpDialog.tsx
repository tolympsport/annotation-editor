/**
 * AnnotationHelpDialog
 *
 * Ein Hilfe-Overlay für den Bild-Annotations-Dialog.
 * Enthält 8 Tabs: Video-Tutorial, Modulo-CAD-Screenshot, Werkzeuge,
 * Bild-Stil, Auswahl & Bearbeiten, Tastenkürzel, Zoom & Navigation, Leinwand.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import {
  ArrowRight,
  Circle,
  Square,
  Type,
  MousePointer,
  Trash2,
  Undo2,
  Redo2,
  Minus,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Crop,
  Copy,
  Move,
  Camera,
  Sun,
  Contrast,
  FlipHorizontal,
  FlipVertical,
  BoxSelect,
  Layers,
} from "lucide-react";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 rounded bg-muted border border-border text-[11px] font-mono font-medium leading-none min-w-[1.5rem]">
      {children}
    </kbd>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: React.ReactNode[] }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-1.5 pr-4 text-sm text-muted-foreground">{label}</td>
      <td className="py-1.5">
        <div className="flex items-center gap-1 flex-wrap">
          {keys.map((k, i) => (
            <span key={i}>{k}</span>
          ))}
        </div>
      </td>
    </tr>
  );
}

function InfoCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex h-7 w-7 items-center justify-center rounded bg-background border shrink-0 mt-0.5">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium mb-0.5">{title}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export type HelpTab = "video" | "modulo" | "tools" | "imgstyle" | "select" | "shortcuts" | "zoom" | "canvas";

/** Configurable/optional help assets. Tabs without an asset URL are hidden. */
export interface AnnotationHelpAssets {
  /** URL of the tutorial video (e.g. "/annotation-tutorial.mp4"). Omit to hide the video tab. */
  tutorialVideoUrl?: string;
  /** URL of the Modulo-CAD screenshot. Omit to hide the Modulo-CAD tab. */
  moduloScreenshotUrl?: string;
}

interface AnnotationHelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tab, der beim Öffnen aktiv sein soll (Standard: "video"). */
  initialTab?: HelpTab;
  /** Optionale Hilfe-Assets; ohne URL wird der jeweilige Tab ausgeblendet. */
  assets?: AnnotationHelpAssets;
}

const EllipseIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <ellipse cx="12" cy="12" rx="10" ry="6" />
  </svg>
);

const ShadowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <rect x="3" y="3" width="14" height="14" rx="2" />
    <rect x="7" y="7" width="14" height="14" rx="2" className="opacity-30" fill="currentColor" stroke="none" />
  </svg>
);

const SpacingIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <rect x="2" y="8" width="6" height="8" rx="1" />
    <rect x="16" y="8" width="6" height="8" rx="1" />
    <line x1="8" y1="12" x2="16" y2="12" />
    <line x1="8" y1="9" x2="8" y2="15" />
    <line x1="16" y1="9" x2="16" y2="15" />
  </svg>
);

const TOOLS = [
  {
    icon: <MousePointer className="h-4 w-4" />,
    name: "Auswählen",
    shortcut: "V",
    desc: "Annotationen auswählen, verschieben oder in der Größe ändern.",
  },
  {
    icon: <ArrowRight className="h-4 w-4" />,
    name: "Pfeil",
    shortcut: "A",
    desc: "Pfeil von Punkt A zu Punkt B ziehen.",
  },
  {
    icon: <Minus className="h-4 w-4" />,
    name: "Linie",
    shortcut: "L",
    desc: "Gerade Linie zeichnen.",
  },
  {
    icon: <Circle className="h-4 w-4" />,
    name: "Kreis",
    shortcut: "C",
    desc: "Perfekten Kreis aufziehen.",
  },
  {
    icon: <EllipseIcon />,
    name: "Ellipse",
    shortcut: "E",
    desc: "Ellipse mit beliebigem Seitenverhältnis aufziehen.",
  },
  {
    icon: <Square className="h-4 w-4" />,
    name: "Rechteck",
    shortcut: "R",
    desc: "Rechteck aufziehen.",
  },
  {
    icon: <Type className="h-4 w-4" />,
    name: "Text",
    shortcut: "T",
    desc: "Klicken, Text eingeben und mit Enter bestätigen.",
  },
] as const;

const ALL_TABS: { value: HelpTab; label: string }[] = [
  { value: "video",     label: "Video" },
  { value: "modulo",    label: "Screenshot aus Modulo-CAD" },
  { value: "tools",     label: "Werkzeuge" },
  { value: "imgstyle",  label: "Bild-Stil" },
  { value: "select",    label: "Auswahl & Bearbeiten" },
  { value: "shortcuts", label: "Tastenkürzel" },
  { value: "zoom",      label: "Zoom & Navigation" },
  { value: "canvas",    label: "Leinwand" },
];

export function AnnotationHelpDialog({ open, onOpenChange, initialTab = "video", assets }: AnnotationHelpDialogProps) {
  const visibleTabs = ALL_TABS.filter((t) => {
    if (t.value === "video")  return !!assets?.tutorialVideoUrl;
    if (t.value === "modulo") return !!assets?.moduloScreenshotUrl;
    return true;
  });
  const fallbackTab: HelpTab = visibleTabs[0]?.value ?? "tools";
  const resolvedInitial = visibleTabs.some((t) => t.value === initialTab) ? initialTab : fallbackTab;
  const [tab, setTab] = useState<HelpTab>(resolvedInitial);

  // Beim (erneuten) Öffnen den gewünschten Start-Tab aktivieren
  useEffect(() => {
    if (open) setTab(resolvedInitial);
  }, [open, resolvedInitial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[700px] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Hilfe – Bild annotieren</DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as HelpTab)} className="flex flex-col flex-1 overflow-hidden min-h-0">
          <TabsList className="shrink-0 flex-nowrap h-auto gap-0.5 justify-start bg-muted/50 rounded-lg px-1 py-1 border overflow-x-auto">
            {visibleTabs.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="text-sm rounded-md px-3 py-1.5 font-medium text-muted-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-y-auto pt-4">

            {/* ── Tab 0: Video-Tutorial ────────────────────────────────────── */}
            {assets?.tutorialVideoUrl && (
            <TabsContent value="video" className="mt-0 px-1 space-y-3">
              <p className="text-sm text-muted-foreground">
                Alle Funktionen in 90 Sekunden — mit deutscher Sprecherstimme und Untertiteln.
              </p>
              <div className="rounded-lg border overflow-hidden bg-black">
                <video
                  src={assets.tutorialVideoUrl}
                  controls
                  preload="metadata"
                  className="w-full h-auto"
                >
                  Dein Browser unterstützt keine Videowiedergabe.
                </video>
              </div>
            </TabsContent>
            )}

            {/* ── Tab 1: Modulo-CAD ────────────────────────────────────────── */}
            {assets?.moduloScreenshotUrl && (
            <TabsContent value="modulo" className="mt-0 px-1 space-y-4">
              <p className="text-sm text-muted-foreground">
                In <strong>Modulo-CAD</strong> gibt es einen <strong>Kamera-Button</strong> in der
                Toolbar, über den Screenshots der aktuellen Ansicht erstellt werden können.
              </p>

              <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Camera className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground" />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Kamera-Button → Dropdown</p>
                    <p className="text-sm text-muted-foreground">
                      Ein Klick auf den Kamera-Button öffnet ein Dropdown mit vier Optionen:
                    </p>
                    <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-1">
                      <li>Weißer Hintergrund – In Zwischenablage kopieren</li>
                      <li>Weißer Hintergrund – Als PNG speichern</li>
                      <li>Transparenter Hintergrund – In Zwischenablage kopieren</li>
                      <li>Transparenter Hintergrund – Als PNG speichern</li>
                    </ul>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Fadenkreuz-Modus (Ausschnitt)</p>
                    <p className="text-sm text-muted-foreground">
                      Nach der Auswahl einer Option verwandelt sich der Mauszeiger in ein Fadenkreuz:
                    </p>
                    <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5 ml-1">
                      <li>
                        <strong>Aufziehen:</strong> Klicken und Bereich aufziehen → nur der ausgewählte Ausschnitt wird aufgenommen.
                      </li>
                      <li>
                        <strong>Einzel-Klick:</strong> Klick ohne Aufziehen → gesamte Ansicht wird aufgenommen.
                      </li>
                      <li>
                        <strong>Abbrechen:</strong> <Kbd>Esc</Kbd> bricht den Modus ab.
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  Screenshot des Kamera-Dropdowns
                </p>
                <div className="rounded-lg border overflow-hidden bg-muted/20">
                  <img
                    src={assets.moduloScreenshotUrl}
                    alt="Kamera-Dropdown in Modulo-CAD"
                    className="max-w-full h-auto"
                  />
                </div>
              </div>
            </TabsContent>
            )}

            {/* ── Tab 2: Werkzeuge ─────────────────────────────────────────── */}
            <TabsContent value="tools" className="mt-0 px-1 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {TOOLS.map((tool) => (
                  <div
                    key={tool.shortcut}
                    className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded bg-background border shrink-0">
                      {tool.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium">{tool.name}</span>
                        <Kbd>{tool.shortcut}</Kbd>
                      </div>
                      <p className="text-xs text-muted-foreground">{tool.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-1 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground text-sm">Füllfarbe (Kreis, Ellipse, Rechteck)</p>
                <p>
                  Über den <strong>Füllung</strong>-Schalter in der Toolbar kann eine Farbfüllung aktiviert
                  und ihre Deckkraft per Schieberegler eingestellt werden.
                </p>
              </div>

              <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground text-sm">Bilder einfügen</p>
                <p>
                  Bilder können per <strong>Drag &amp; Drop</strong> direkt auf die Leinwand gezogen oder
                  über den <strong>Bild-Button</strong> in der Toolbar ausgewählt werden. Es können
                  mehrere Dateien gleichzeitig ausgewählt werden — sie werden automatisch versetzt
                  nebeneinander platziert.
                </p>
              </div>
            </TabsContent>

            {/* ── Tab 3: Bild-Stil (NEU) ───────────────────────────────────── */}
            <TabsContent value="imgstyle" className="mt-0 px-1 space-y-3">
              <p className="text-sm text-muted-foreground">
                Wenn ein <strong>Bild-Objekt</strong> ausgewählt ist, erscheint in der Toolbar eine
                zweite Zeile mit Bildstil-Parametern. Alle Werte sind auch per Mausrad auf dem
                jeweiligen Zahlenfeld einstellbar.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <InfoCard icon={<Layers className="h-4 w-4" />} title="Deckkraft">
                  Gesamttransparenz des Bildes (0–100 %). Nützlich um Bilder als Overlay oder
                  Wasserzeichen einzusetzen.
                </InfoCard>

                <InfoCard icon={<Sun className="h-4 w-4" />} title="Helligkeit &amp; Kontrast">
                  Helligkeit und Kontrast separat von 50 % bis 150 % anpassen — z. B. um zu dunkle
                  Screenshots aufzuhellen.
                </InfoCard>

                <InfoCard icon={<FlipHorizontal className="h-4 w-4" />} title="Spiegeln">
                  Das Bild horizontal (↔) oder vertikal (↕) spiegeln. Beide Optionen können
                  gleichzeitig aktiv sein.
                </InfoCard>

                <InfoCard icon={<BoxSelect className="h-4 w-4" />} title="Rahmen">
                  Rahmenbreite, -farbe, -stil (durchgehend / gestrichelt / gepunktet) und
                  Eckenradius (abgerundete Ecken) einstellen.
                </InfoCard>

                <InfoCard icon={<ShadowIcon />} title="Schatten">
                  Schatten aktivieren und anpassen: Unschärfe (Blur), Farbe, Deckkraft sowie
                  horizontaler (X) und vertikaler Versatz (Y). Der Schatten erscheint außerhalb
                  des Bildrandes und respektiert den eingestellten Eckenradius.
                </InfoCard>

                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
                  <p className="text-sm font-medium">Einstellungen werden gespeichert</p>
                  <p className="text-xs text-muted-foreground">
                    Alle Stilwerte (Deckkraft, Helligkeit, Schatten, Rahmen usw.) werden automatisch
                    im Browser gespeichert. Beim nächsten Öffnen des Dialogs sind sie vorausgefüllt —
                    auch nach einem Seiten-Reload. Das gilt ebenso für Farbe, Linienstärke und
                    Schriftgröße bei anderen Annotationstypen.
                  </p>
                </div>
              </div>
            </TabsContent>

            {/* ── Tab 4: Auswahl & Bearbeiten ──────────────────────────────── */}
            <TabsContent value="select" className="mt-0 px-1 space-y-2">
              <InfoCard icon={<MousePointer className="h-4 w-4" />} title="Auswählen">
                Mit dem Auswahl-Werkzeug (V) auf eine Annotation klicken. Mehrere Annotationen:
                Shift+Klick oder Auswahlrahmen aufziehen.
              </InfoCard>

              <InfoCard icon={<Move className="h-4 w-4" />} title="Verschieben">
                Ausgewählte Annotation(en) per Drag &amp; Drop verschieben. Mit{" "}
                <Kbd>Shift</Kbd> wird die Bewegung auf eine Achse (horizontal oder vertikal) beschränkt.
                Mit <Kbd>Alt</Kbd> wird Snapping deaktiviert (freie Positionierung).
              </InfoCard>

              <InfoCard icon={<Copy className="h-4 w-4" />} title="Kopieren via Ctrl+Drag">
                Annotation(en) auswählen, dann <Kbd>Ctrl</Kbd> gedrückt halten und ziehen — es
                entsteht eine Kopie an der Zielposition. Der dabei verwendete Abstand wird als
                Standardabstand für das nächste <Kbd>Ctrl</Kbd>+<Kbd>D</Kbd> übernommen.
              </InfoCard>

              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-background border shrink-0 mt-0.5">
                  <Copy className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium mb-0.5">Duplizieren mit gleichem Abstand (PowerPoint-Stil)</p>
                  <p className="text-xs text-muted-foreground">
                    <Kbd>Ctrl</Kbd>+<Kbd>D</Kbd> dupliziert alle ausgewählten Annotationen.
                    Wenn du die frisch duplizierte Kopie anschließend an eine neue Position ziehst,
                    merkt sich das System diesen Abstand (Δx / Δy). Das nächste{" "}
                    <Kbd>Ctrl</Kbd>+<Kbd>D</Kbd> platziert die Kopie mit exakt demselben Abstand —
                    beliebig oft wiederholbar. Der Tooltip des Duplizieren-Buttons zeigt den aktuell
                    gespeicherten Abstand. Das Muster wird zurückgesetzt, sobald eine andere Annotation
                    verschoben oder <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> gedrückt wird.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
                <div className="flex h-7 w-7 items-center justify-center rounded bg-background border shrink-0 mt-0.5">
                  <SpacingIcon />
                </div>
                <div>
                  <p className="text-sm font-medium mb-0.5">Abstandsmarkierungen beim Ziehen</p>
                  <p className="text-xs text-muted-foreground">
                    Wenn beim Verschieben der Abstand zwischen dem gezogenen Objekt und einem Nachbarn
                    dem Abstand zwischen zwei anderen Objekten entspricht, erscheinen{" "}
                    <span className="font-medium" style={{ color: "#e91e63" }}>magentafarbene Klammern</span>{" "}
                    (ähnlich wie in Figma). Das Objekt rastet automatisch auf den gleichen Abstand ein.
                    Blaue gestrichelte Linien zeigen zusätzlich Ausrichtungen an Kanten und Mittelpunkten.
                    Mit <Kbd>Alt</Kbd> werden beide Snap-Hilfen deaktiviert.
                  </p>
                </div>
              </div>

              <InfoCard icon={<Trash2 className="h-4 w-4" />} title="Löschen">
                Ausgewählte Annotation(en) mit <Kbd>Del</Kbd> oder <Kbd>Backspace</Kbd> löschen.
              </InfoCard>

              <InfoCard icon={<Undo2 className="h-4 w-4" />} title="Rückgängig / Wiederholen">
                <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd> macht den letzten Schritt rückgängig.{" "}
                <Kbd>Ctrl</Kbd>+<Kbd>Y</Kbd> oder <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd> wiederholt ihn.
              </InfoCard>

              <InfoCard icon={<ArrowRight className="h-3 w-3 rotate-45" />} title="Feinpositionierung">
                Ausgewählte Annotation(en) mit den Pfeiltasten um 1 px verschieben. Mit{" "}
                <Kbd>Shift</Kbd>+Pfeiltaste in 10-px-Schritten.
              </InfoCard>
            </TabsContent>

            {/* ── Tab 5: Tastenkürzel ──────────────────────────────────────── */}
            <TabsContent value="shortcuts" className="mt-0 px-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">Werkzeuge</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <ShortcutRow label="Auswählen" keys={[<Kbd>V</Kbd>]} />
                      <ShortcutRow label="Pfeil" keys={[<Kbd>A</Kbd>]} />
                      <ShortcutRow label="Linie" keys={[<Kbd>L</Kbd>]} />
                      <ShortcutRow label="Kreis" keys={[<Kbd>C</Kbd>]} />
                      <ShortcutRow label="Ellipse" keys={[<Kbd>E</Kbd>]} />
                      <ShortcutRow label="Rechteck" keys={[<Kbd>R</Kbd>]} />
                      <ShortcutRow label="Text" keys={[<Kbd>T</Kbd>]} />
                    </tbody>
                  </table>

                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2 mt-4">Bearbeiten</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <ShortcutRow label="Löschen" keys={[<Kbd>Del</Kbd>, <span className="text-muted-foreground text-xs">/</span>, <Kbd>Backspace</Kbd>]} />
                      <ShortcutRow label="Duplizieren" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>D</Kbd>]} />
                      <ShortcutRow label="Rückgängig" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>Z</Kbd>]} />
                      <ShortcutRow label="Wiederholen" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>Y</Kbd>]} />
                      <ShortcutRow label="Abbrechen" keys={[<Kbd>Esc</Kbd>]} />
                      <ShortcutRow label="Achse einrasten" keys={[<Kbd>Shift</Kbd>, <span className="text-muted-foreground text-xs">+ Drag</span>]} />
                      <ShortcutRow label="Snapping aus" keys={[<Kbd>Alt</Kbd>, <span className="text-muted-foreground text-xs">+ Drag</span>]} />
                      <ShortcutRow label="Kopieren via Drag" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground text-xs">+ Drag</span>]} />
                    </tbody>
                  </table>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2">Textformatierung</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <ShortcutRow label="Fett" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>B</Kbd>]} />
                      <ShortcutRow label="Kursiv" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>I</Kbd>]} />
                      <ShortcutRow label="Unterstrichen" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>U</Kbd>]} />
                      <ShortcutRow label="Durchgestrichen" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>S</Kbd>]} />
                    </tbody>
                  </table>

                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2 mt-4">Zoom</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <ShortcutRow label="Vergrößern" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>=</Kbd>]}/>
                      <ShortcutRow label="Verkleinern" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>−</Kbd>]} />
                      <ShortcutRow label="Einpassen" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>0</Kbd>]} />
                      <ShortcutRow label="Zoom scrollen" keys={[<Kbd>Ctrl</Kbd>, <span className="text-muted-foreground">+</span>, <span className="text-xs text-muted-foreground">Scroll</span>]} />
                    </tbody>
                  </table>

                  <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-2 mt-4">Navigation</p>
                  <table className="w-full text-sm">
                    <tbody>
                      <ShortcutRow label="Pan-Modus" keys={[<Kbd>Leertaste</Kbd>, <span className="text-muted-foreground text-xs">halten</span>]} />
                      <ShortcutRow label="Feinpositionierung" keys={[<Kbd>↑↓←→</Kbd>]} />
                      <ShortcutRow label="10-px-Schritte" keys={[<Kbd>Shift</Kbd>, <span className="text-muted-foreground">+</span>, <Kbd>↑↓←→</Kbd>]} />
                    </tbody>
                  </table>
                </div>
              </div>
            </TabsContent>

            {/* ── Tab 6: Zoom & Navigation ─────────────────────────────────── */}
            <TabsContent value="zoom" className="mt-0 px-1 space-y-3">
              <InfoCard icon={<ZoomIn className="h-4 w-4" />} title="Vergrößern / Verkleinern">
                Über die Toolbar-Buttons <ZoomIn className="inline h-3.5 w-3.5" /> / <ZoomOut className="inline h-3.5 w-3.5" /> oder per{" "}
                <Kbd>Ctrl</Kbd>+Scroll-Rad zoomen. Der Zoom zentriert sich auf die Mausposition.
              </InfoCard>

              <InfoCard icon={<Maximize2 className="h-4 w-4" />} title="Einpassen">
                <Kbd>Ctrl</Kbd>+<Kbd>0</Kbd> oder der Einpassen-Button setzt den Zoom so, dass das gesamte Bild sichtbar ist.
              </InfoCard>

              <InfoCard icon={<Move className="h-4 w-4" />} title="Pan (Verschieben der Ansicht)">
                <Kbd>Leertaste</Kbd> gedrückt halten, dann den Canvas per Drag verschieben.
                Außerhalb der Leinwand kann auch ohne Leertaste gepannt werden.
              </InfoCard>
            </TabsContent>

            {/* ── Tab 7: Leinwand ──────────────────────────────────────────── */}
            <TabsContent value="canvas" className="mt-0 px-1 space-y-3">
              <InfoCard
                icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>}
                title="Rand hinzufügen"
              >
                Über den Rand-Button in der Toolbar kann ein weißer Rand um das Bild hinzugefügt werden.
                Nützlich, um mehr Platz für Annotationen am Bildrand zu schaffen.
              </InfoCard>

              <InfoCard icon={<Crop className="h-4 w-4" />} title="Crop (Zuschneiden)">
                Den Crop-Button aktivieren, dann den gewünschten Ausschnitt aufziehen.
                Der Bereich außerhalb der Auswahl wird entfernt.
              </InfoCard>

              <InfoCard icon={<Maximize2 className="h-4 w-4" />} title="Zurücksetzen">
                Der Zurücksetzen-Button stellt das Original-Bild ohne Zuschnitte oder Randänderungen
                wieder her. Annotationen bleiben erhalten, soweit sie noch auf der Leinwand liegen.
              </InfoCard>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1">
                <p className="text-sm font-medium">Beispiel-Workflow</p>
                <ol className="text-xs text-muted-foreground list-decimal list-inside space-y-1">
                  <li>Screenshot aus Modulo-CAD erstellen (Kamera-Button → Dropdown).</li>
                  <li>Im Annotations-Dialog: Rand hinzufügen, falls nötig (mehr Platz).</li>
                  <li>Pfeile, Kreise oder Texte auf die relevanten Stellen setzen.</li>
                  <li>Bei Bedarf zuschneiden (Crop), um den Fokus zu schärfen.</li>
                  <li>„Fertig" klicken → das Bild wird mit Annotationen gespeichert.</li>
                </ol>
              </div>
            </TabsContent>

          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
