import { z } from 'zod';

/** Bumped only if the on-disk shape ever needs a breaking migration; parsing always fills in
 *  whatever a stored document is missing (see `userPrefsSchema`'s `.default(...)`s below), so an
 *  older document from before a field existed just reads back with that field's default. */
export const PREFS_VERSION = 1;

export const themeValues = ['light', 'dark', 'system'] as const;
export const defaultRangeValues = ['hour', 'day', 'week', 'month', 'year'] as const;
export const thumbnailRefreshSecondsValues = [30, 60, 120, 300] as const;
export const densityValues = ['comfortable', 'compact'] as const;

export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 600;

export const SUMMARY_LAYOUT_MAX_ENTRIES = 24;
export const SUMMARY_LAYOUT_ID_MAX_LENGTH = 32;

export const GUEST_LIST_COLUMNS_MAX_ENTRIES = 16;
export const GUEST_LIST_COLUMN_ID_MAX_LENGTH = 32;

/**
 * A saved Summary-tab panel order for one guest type. The server has no notion of *which* panel
 * ids are valid (that's `apps/web/src/pages/vm/summaryLayout.ts`'s `SUMMARY_PANELS` registry, a
 * client-only concept that can grow/shrink across releases without a server migration) -- it only
 * validates the generic shape ("an array of short, unique strings") and stores whatever the
 * client sends after running it through `normaliseOrder`. An id this server version has never
 * heard of (an older client, a panel a later release retired) round-trips harmlessly and is
 * dropped on read by `normaliseOrder`, never rejected here.
 */
const summaryLayoutIds = z
  .array(z.string().min(1).max(SUMMARY_LAYOUT_ID_MAX_LENGTH))
  .max(SUMMARY_LAYOUT_MAX_ENTRIES)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'summaryLayout ids must be unique' });

const summaryLayoutSchema = z.object({
  qemu: summaryLayoutIds.optional(),
  lxc: summaryLayoutIds.optional(),
});

/**
 * Saved column visibility for the Guests page's table (T25). Same generic, unvalidated-against-
 * a-registry shape as `summaryLayoutSchema` above -- the server has no notion of which column
 * ids are valid (that's `apps/web/src/pages/guests/guestList.ts`'s `GUEST_COLUMNS`, client-only
 * and free to grow/shrink across releases); it only checks "an array of short, unique strings,
 * at most 16 entries" and stores whatever the client sends. `columns: undefined`/omitted means
 * "no saved selection" (the client then shows every column); `{}` (no `columns` key) is how a
 * client clears back to that state -- same round-trip `summaryLayout: {}` gives `qemu`/`lxc`.
 */
const guestListColumnIds = z
  .array(z.string().min(1).max(GUEST_LIST_COLUMN_ID_MAX_LENGTH))
  .max(GUEST_LIST_COLUMNS_MAX_ENTRIES)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'guestList.columns ids must be unique' });

const guestListSchema = z.object({
  columns: guestListColumnIds.optional(),
});

/**
 * Field validators with NO `.default()` -- the base every field schema in this module is built
 * from. `userPrefsPatchSchema` below is `z.object(fields).partial()`; if it were instead
 * `userPrefsSchema.partial()` (defaults already attached), zod still applies each field's
 * `.default()` to a key a `PATCH` body simply omits (a default only short-circuits *missing*
 * input, which is exactly what "omitted from a partial body" looks like) -- so `{ density:
 * 'compact' }` would parse back out as `{ theme: 'system', density: 'compact' }`, silently
 * resetting `theme` to its default on every unrelated field's `PATCH`. Building the patch schema
 * from default-less fields keeps an omitted key *actually* absent from `.data`, so `merge()`
 * (store.ts) only ever overwrites the fields the caller sent.
 */
const fields = {
  version: z.literal(PREFS_VERSION),
  theme: z.enum(themeValues),
  defaultRange: z.enum(defaultRangeValues),
  consoleThumbnails: z.boolean(),
  thumbnailRefreshSeconds: z.union(thumbnailRefreshSecondsValues.map((value) => z.literal(value))),
  railWidth: z.number().int().min(RAIL_WIDTH_MIN).max(RAIL_WIDTH_MAX),
  density: z.enum(densityValues),
  summaryLayout: summaryLayoutSchema,
  guestList: guestListSchema,
};

/**
 * One user's preferences. Unknown keys are silently dropped (zod's default "strip" object
 * mode -- deliberate, not an oversight: an older client's stray field, or a field a rolled-back
 * server version no longer knows, should never fail validation) and every field but `railWidth`
 * and `summaryLayout` defaults when absent, so `userPrefsSchema.parse(anythingOrEmpty)` always
 * yields a complete, valid document -- this is what makes "merge the stored document over
 * defaults" (the GET contract) and "an older on-disk document missing a newer field" both just
 * fall out of one `safeParse` call, with no separate defaulting step. `railWidth` has no default
 * (`undefined` means "use the client's own built-in default", not a stored `200`-`600` value);
 * `summaryLayout` has no default either (`undefined`/missing means "no custom order saved for
 * either guest type", not `{}` -- both read back the same via `normaliseOrder`, but `merge()`
 * (store.ts) only overwrites `summaryLayout` at all when a `PATCH` body actually names it).
 */
export const userPrefsSchema = z.object({
  version: fields.version.default(PREFS_VERSION),
  theme: fields.theme.default('system'),
  defaultRange: fields.defaultRange.default('hour'),
  consoleThumbnails: fields.consoleThumbnails.default(true),
  thumbnailRefreshSeconds: fields.thumbnailRefreshSeconds.default(60),
  railWidth: fields.railWidth.optional(),
  density: fields.density.default('comfortable'),
  summaryLayout: fields.summaryLayout.optional(),
  guestList: fields.guestList.optional(),
});

export type UserPrefs = z.infer<typeof userPrefsSchema>;

/** Same fields, all genuinely optional (see `fields`' doc comment above for why this is built
 *  from the default-less base rather than `userPrefsSchema.partial()`) -- for `PATCH` bodies. */
export const userPrefsPatchSchema = z.object(fields).partial();
export type UserPrefsPatch = z.infer<typeof userPrefsPatchSchema>;

/** What every `/api/prefs` response actually sends: the document plus whether writes are
 *  accepted for this identity (always `false` outside token mode). */
export type PrefsResponse = UserPrefs & { readOnly: boolean };

/** The all-defaults document -- what a brand new user (no file on disk yet) reads back, and
 *  what token mode's read-only response is built from. */
export const PREFS_DEFAULTS: UserPrefs = userPrefsSchema.parse({});
