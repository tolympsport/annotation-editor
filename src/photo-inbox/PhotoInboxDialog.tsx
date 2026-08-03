import { useState, useEffect, useCallback, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Camera, Loader2, QrCode, Trash2, CheckCircle2, ImagePlus,
  Pencil, Check, X, Users, User,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import type { PhotoInboxItemDto } from "./types";

// ---------------------------------------------------------------------------
// Minimal inline Switch (no @radix-ui/react-switch dep needed)
// ---------------------------------------------------------------------------
function Switch({ checked, onCheckedChange, id, "data-testid": testId }: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  "data-testid"?: string;
}) {
  return (
    <button
      role="switch"
      id={id}
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-primary" : "bg-input",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prefix a potentially-relative URL with the API base. */
function resolveUrl(apiBaseUrl: string, url: string): string {
  if (!apiBaseUrl || url.startsWith("http://") || url.startsWith("https://")) return url;
  return apiBaseUrl.replace(/\/$/, "") + url;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PhotoInboxDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen photo. `item.url` is already absolute when
   *  `apiBaseUrl` is provided. */
  onInsert: (item: PhotoInboxItemDto) => void;
  /**
   * Base URL of the photo-inbox API server, e.g. "https://docs.tolymp.de".
   * Leave empty (default) when the dialog is served from the same origin.
   */
  apiBaseUrl?: string;
  /**
   * Bearer token for cross-origin auth (`Authorization: Bearer <token>`).
   * Required when `apiBaseUrl` points to a different origin.
   * Also send `userEmail` so the server can identify the current user.
   */
  authToken?: string;
  /**
   * E-mail of the currently logged-in user in the consuming app.
   * Sent as `X-User-Email` header when `authToken` is set.
   */
  userEmail?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PhotoInboxDialog({
  open,
  onClose,
  onInsert,
  apiBaseUrl = "",
  authToken,
  userEmail,
}: PhotoInboxDialogProps) {
  const [items, setItems] = useState<PhotoInboxItemDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showUsed, setShowUsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set());
  const [pendingNote, setPendingNote] = useState(false);

  // Build fetch init with auth headers.
  const buildInit = useCallback((extra?: RequestInit): RequestInit => {
    const headers: Record<string, string> = {
      ...(extra?.headers as Record<string, string> ?? {}),
    };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
      if (userEmail) headers["X-User-Email"] = userEmail;
    }
    return { credentials: "include", ...extra, headers };
  }, [authToken, userEmail]);

  const base = apiBaseUrl.replace(/\/$/, "");

  // -------------------------------------------------------------------------
  // Data fetching (plain fetch + polling)
  // -------------------------------------------------------------------------
  const loadItems = useCallback(async () => {
    const path = showAll ? "/api/photo-inbox/all" : "/api/photo-inbox";
    try {
      setIsLoading(true);
      const res = await fetch(base + path, buildInit());
      if (!res.ok) return;
      const data: PhotoInboxItemDto[] = await res.json();
      setItems(data);
    } catch {
      // silently ignore network errors during polling
    } finally {
      setIsLoading(false);
    }
  }, [base, buildInit, showAll]);

  // Initial load + polling while open
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!open) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    void loadItems();
    intervalRef.current = setInterval(() => void loadItems(), 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [open, loadItems]);

  // Reload when showAll changes
  useEffect(() => {
    if (open) void loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // Transient toast
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 3000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const visible = showUsed ? items : items.filter((i) => !i.used_at);

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------
  async function markUsed(id: string) {
    await fetch(`${base}/api/photo-inbox/${id}/used`, buildInit({ method: "PATCH" }));
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, used_at: new Date().toISOString() } : i));
  }

  async function deletePhoto(id: string) {
    setPendingDelete((s) => new Set(s).add(id));
    try {
      const res = await fetch(`${base}/api/photo-inbox/${id}`, buildInit({ method: "DELETE" }));
      if (!res.ok && res.status !== 404) {
        setToastMsg("Löschen fehlgeschlagen");
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      setToastMsg("Löschen fehlgeschlagen");
    } finally {
      setPendingDelete((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  async function saveNote(id: string) {
    setPendingNote(true);
    try {
      const res = await fetch(`${base}/api/photo-inbox/${id}/note`, buildInit({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDraft.trim() }),
      }));
      if (!res.ok) { setToastMsg("Notiz speichern fehlgeschlagen"); return; }
      setItems((prev) => prev.map((i) => i.id === id ? { ...i, note: noteDraft.trim() || null } : i));
      setEditingId(null);
    } catch {
      setToastMsg("Notiz speichern fehlgeschlagen");
    } finally {
      setPendingNote(false);
    }
  }

  async function showQr() {
    setQrLoading(true);
    try {
      const res = await fetch(`${base}/api/photo-inbox/login-token`, buildInit({ method: "POST" }));
      if (!res.ok) throw new Error("QR-Code konnte nicht erzeugt werden");
      const data = await res.json();
      setQrUrl(data.url as string);
    } catch (e: any) {
      setToastMsg(e?.message || "QR-Code konnte nicht erzeugt werden");
    } finally {
      setQrLoading(false);
    }
  }

  function handlePick(item: PhotoInboxItemDto) {
    const resolved: PhotoInboxItemDto = {
      ...item,
      url: resolveUrl(apiBaseUrl, item.url),
    };
    onInsert(resolved);
    if (!showAll || item.is_own !== false) {
      void markUsed(item.id);
    }
    onClose();
  }

  function startEdit(item: PhotoInboxItemDto) {
    setEditingId(item.id);
    setNoteDraft(item.note || "");
  }

  function ownerLabel(item: PhotoInboxItemDto): string {
    const name = item.owner_name ?? item.owner_username ?? "";
    return name.split(" ")[0] ?? name;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setQrUrl(null); onClose(); } }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="w-5 h-5" /> Foto-Inbox
          </DialogTitle>
          <DialogDescription>
            Am Handy aufgenommene Fotos — Klick fügt das Foto in den Editor ein. Neue Fotos erscheinen automatisch.
          </DialogDescription>
        </DialogHeader>

        {toastMsg && (
          <div className="rounded-md bg-destructive/10 text-destructive text-sm px-3 py-2">
            {toastMsg}
          </div>
        )}

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="show-used" checked={showUsed} onCheckedChange={setShowUsed} data-testid="switch-show-used" />
              <label htmlFor="show-used" className="text-sm text-muted-foreground cursor-pointer">
                Verwendete anzeigen
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="show-all"
                checked={showAll}
                onCheckedChange={(v) => { setShowAll(v); setEditingId(null); }}
                data-testid="switch-show-all"
              />
              <label htmlFor="show-all" className="text-sm text-muted-foreground flex items-center gap-1 cursor-pointer">
                {showAll
                  ? <><Users className="w-3.5 h-3.5" /> Alle Benutzer</>
                  : <><User className="w-3.5 h-3.5" /> Nur meine</>}
              </label>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={showQr} disabled={qrLoading} data-testid="button-show-qr">
            {qrLoading
              ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              : <QrCode className="w-4 h-4 mr-1.5" />}
            Handy koppeln
          </Button>
        </div>

        {qrUrl && (
          <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-center gap-5">
            <div className="bg-white p-2 rounded-md shrink-0">
              <QRCodeSVG value={qrUrl} size={140} />
            </div>
            <div className="text-sm space-y-1.5">
              <p className="font-medium">Mit der Handy-Kamera scannen</p>
              <p className="text-muted-foreground">
                Der Code meldet dein Handy automatisch an und öffnet die Aufnahme-Seite.
                Er ist 5 Minuten gültig und einmal verwendbar — danach bleibt dein Handy 180 Tage angemeldet.
              </p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {isLoading && items.length === 0 ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <ImagePlus className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">
                Keine {showUsed ? "" : "neuen "}Fotos {showAll ? "von allen Benutzern" : "in der Inbox"}.<br />
                {!showAll && <>Über „Handy koppeln" kannst du sofort loslegen.</>}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 py-1">
              {visible.map((item) => {
                const isOwn = !showAll || item.is_own !== false;
                const imgSrc = resolveUrl(apiBaseUrl, item.url);
                return (
                  <div key={item.id} className="relative group rounded-lg overflow-hidden border border-border aspect-square">
                    <button
                      className="w-full h-full block"
                      onClick={() => handlePick(item)}
                      title={item.note || "In Editor einfügen"}
                      data-testid={`button-insert-photo-${item.id}`}
                    >
                      <img
                        src={imgSrc}
                        alt={item.note || ""}
                        loading="lazy"
                        className={cn(
                          "w-full h-full object-cover transition-transform group-hover:scale-105",
                          item.used_at && "opacity-50",
                        )}
                      />
                    </button>
                    {item.used_at && (
                      <CheckCircle2 className="absolute top-1 left-1 w-4 h-4 text-green-500 bg-background rounded-full pointer-events-none" />
                    )}

                    {/* Owner badge */}
                    {showAll && (
                      <div className={cn(
                        "absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight pointer-events-none",
                        isOwn ? "bg-primary/80 text-primary-foreground" : "bg-black/65 text-white",
                      )}>
                        {isOwn ? "Ich" : ownerLabel(item)}
                      </div>
                    )}

                    {/* Delete — own photos only */}
                    {isOwn && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void deletePhoto(item.id); }}
                        disabled={pendingDelete.has(item.id)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-background/80 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Foto löschen"
                        data-testid={`button-delete-inbox-photo-${item.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {/* Note editing — own photos only */}
                    {isOwn && (editingId === item.id ? (
                      <div className="absolute bottom-0 inset-x-0 bg-black/80 p-1 flex items-center gap-1">
                        <Input
                          autoFocus
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void saveNote(item.id); }
                            if (e.key === "Escape") { e.preventDefault(); setEditingId(null); }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Notiz…"
                          className="h-6 text-[11px] px-1.5 bg-white/90 text-black"
                          data-testid={`input-note-${item.id}`}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); void saveNote(item.id); }}
                          disabled={pendingNote}
                          className="p-0.5 text-green-400 shrink-0"
                          aria-label="Notiz speichern"
                          data-testid={`button-save-note-${item.id}`}
                        >
                          {pendingNote ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingId(null); }}
                          className="p-0.5 text-white/70 shrink-0"
                          aria-label="Abbrechen"
                          data-testid={`button-cancel-note-${item.id}`}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : item.note ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); startEdit(item); }}
                        className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1.5 py-0.5 flex items-center gap-1 text-left"
                        aria-label="Notiz bearbeiten"
                        data-testid={`button-edit-note-${item.id}`}
                      >
                        <span className="truncate flex-1">{item.note}</span>
                        <Pencil className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); startEdit(item); }}
                        className="absolute bottom-1 right-1 p-1 rounded-full bg-background/80 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                        aria-label="Notiz hinzufügen"
                        data-testid={`button-add-note-${item.id}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    ))}

                    {/* Read-only note for other users */}
                    {!isOwn && item.note && (
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1.5 py-0.5 pointer-events-none truncate">
                        {item.note}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
