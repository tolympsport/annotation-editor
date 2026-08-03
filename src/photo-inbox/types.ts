/** DTO for a single photo inbox item as returned by the API. */
export interface PhotoInboxItemDto {
  id: string;
  /** Relative proxy URL (e.g. /api/montagehinweise/image-proxy?blob=…).
   *  When using cross-origin (apiBaseUrl set), prefix with apiBaseUrl before use. */
  url: string;
  note: string | null;
  created_at: Date | string | null;
  used_at: Date | string | null;
  /** Only present in the /all endpoint. */
  owner_name?: string | null;
  owner_username?: string | null;
  /** Only present in the /all endpoint. true = this user's own photo. */
  is_own?: boolean;
}
