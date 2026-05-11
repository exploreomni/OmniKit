import type { BrandConfig, LayoutKit, SlideLayout, SlideRole } from './types';
import { DEFAULT_BRAND, NEUTRAL_BRAND, EXECUTIVE_BRAND } from './types';

const STORAGE_KEY = 'omnikit.deck.templates.v1';
const DEFAULT_SELECTION_KEY = 'omnikit.deck.templates.default';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

export function defaultLayoutsForBrand(brand: BrandConfig): SlideLayout[] {
  return [
    {
      id: 'title',
      role: 'title',
      name: 'Title slide',
      backgroundColor: brand.backgroundColor,
      headerBarColor: brand.primaryColor,
      headerBarHeight: 0.35,
      titleBox: {
        x: 0.6, y: 2.4, w: SLIDE_W - 1.2, h: 1.4,
        fontSize: 44, color: brand.titleColor, bold: true,
      },
      bodyBox: { x: 0.6, y: 3.9, w: SLIDE_W - 1.2, h: 0.5 },
      logoBox: { x: 0.6, y: 0.7, w: 1.4, h: 0.7 },
      footerBox: { x: 0.6, y: SLIDE_H - 0.5, w: SLIDE_W - 1.2, h: 0.3, fontSize: 10, color: '888888' },
    },
    {
      id: 'content',
      role: 'content',
      name: 'Content slide',
      backgroundColor: brand.backgroundColor,
      headerBarColor: brand.primaryColor,
      headerBarHeight: 0.18,
      titleBox: {
        x: 0.5, y: 0.3, w: SLIDE_W - 1, h: 0.7,
        fontSize: 24, color: brand.titleColor, bold: true,
      },
      bodyBox: { x: 0.5, y: 1.1, w: 8.6, h: 5.6 },
      footerBox: { x: 0.5, y: SLIDE_H - 0.4, w: SLIDE_W - 1.5, h: 0.3, fontSize: 9, color: '888888' },
      insightPanel: true,
    },
    {
      id: 'section',
      role: 'section',
      name: 'Section header',
      backgroundColor: brand.primaryColor,
      titleBox: {
        x: 0.8, y: 3.0, w: SLIDE_W - 1.6, h: 1.5,
        fontSize: 40, color: 'FFFFFF', bold: true,
      },
      bodyBox: { x: 0.8, y: 4.5, w: SLIDE_W - 1.6, h: 0.6 },
      footerBox: { x: 0.8, y: SLIDE_H - 0.4, w: SLIDE_W - 1.6, h: 0.3, fontSize: 9, color: 'E5E7EB' },
    },
    {
      id: 'closing',
      role: 'closing',
      name: 'Closing slide',
      backgroundColor: brand.backgroundColor,
      headerBarColor: brand.accentColor,
      headerBarHeight: 0.35,
      titleBox: {
        x: 0.6, y: 2.8, w: SLIDE_W - 1.2, h: 1.2,
        fontSize: 40, color: brand.titleColor, bold: true,
      },
      bodyBox: { x: 0.6, y: 4.2, w: SLIDE_W - 1.2, h: 0.8 },
      footerBox: { x: 0.6, y: SLIDE_H - 0.5, w: SLIDE_W - 1.2, h: 0.3, fontSize: 10, color: '888888' },
    },
    {
      id: 'appendix',
      role: 'appendix',
      name: 'Appendix',
      backgroundColor: brand.backgroundColor,
      headerBarColor: brand.primaryColor,
      headerBarHeight: 0.18,
      titleBox: {
        x: 0.5, y: 0.4, w: SLIDE_W - 1, h: 0.6,
        fontSize: 22, color: brand.titleColor, bold: true,
      },
      bodyBox: { x: 0.6, y: 1.2, w: SLIDE_W - 1.2, h: SLIDE_H - 1.6 },
    },
  ];
}

export function makeLayoutKit(id: string, name: string, brand: BrandConfig, source: LayoutKit['source'] = 'builtin'): LayoutKit {
  return {
    id,
    name,
    source,
    brand,
    layouts: defaultLayoutsForBrand(brand),
    importedAt: Date.now(),
  };
}

const BUILTIN_IDS = new Set(['builtin-omnikit', 'builtin-neutral', 'builtin-executive']);

export function getBuiltinTemplates(): LayoutKit[] {
  return [
    makeLayoutKit('builtin-omnikit', 'OmniKit Default', DEFAULT_BRAND),
    makeLayoutKit('builtin-neutral', 'Neutral Corporate', NEUTRAL_BRAND),
    makeLayoutKit('builtin-executive', 'Executive Mono', EXECUTIVE_BRAND),
  ];
}

export function isBuiltin(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

function loadUserTemplates(): LayoutKit[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const kits = parsed.filter(isValidKit);
    const migrated = migrateStaleBrandColors(kits);
    if (migrated.changed) saveUserTemplates(migrated.kits);
    return migrated.kits;
  } catch {
    return [];
  }
}

function migrateStaleBrandColors(kits: LayoutKit[]): { kits: LayoutKit[]; changed: boolean } {
  let changed = false;
  const normalize = (v?: string) => (v || '').replace(/^#/, '').toUpperCase();
  const out = kits.map((kit) => {
    if (kit.source !== 'pptx' || !kit.brand) return kit;
    const b = kit.brand;
    const isStalePink = normalize(b.tableHeaderColor) === 'C8186A';
    const isStaleZebra = normalize(b.tableZebraColor) === 'F8F1F5';
    const isStaleFooter = b.footerText === 'Generated with OmniKit';
    if (!isStalePink && !isStaleZebra && !isStaleFooter) return kit;
    changed = true;
    return {
      ...kit,
      brand: {
        ...b,
        tableHeaderColor: isStalePink ? b.primaryColor : b.tableHeaderColor,
        tableZebraColor: isStaleZebra ? 'F3F4F6' : b.tableZebraColor,
        footerText: isStaleFooter ? '' : b.footerText,
      },
    };
  });
  return { kits: out, changed };
}

function saveUserTemplates(kits: LayoutKit[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(kits));
}

function isValidKit(v: unknown): v is LayoutKit {
  if (!v || typeof v !== 'object') return false;
  const k = v as Partial<LayoutKit>;
  return typeof k.id === 'string' && typeof k.name === 'string' && !!k.brand && Array.isArray(k.layouts);
}

export function listTemplates(): LayoutKit[] {
  return [...getBuiltinTemplates(), ...loadUserTemplates()];
}

export function getTemplate(id: string): LayoutKit | null {
  return listTemplates().find((k) => k.id === id) || null;
}

export function saveTemplate(kit: LayoutKit): LayoutKit {
  if (isBuiltin(kit.id)) {
    kit = { ...kit, id: `user-${Date.now()}`, source: kit.source === 'builtin' ? 'json' : kit.source };
  }
  const existing = loadUserTemplates();
  const idx = existing.findIndex((k) => k.id === kit.id);
  const next = kit.id && idx >= 0 ? [...existing] : [...existing];
  if (idx >= 0) next[idx] = kit;
  else next.push(kit);
  saveUserTemplates(next);
  return kit;
}

export function deleteTemplate(id: string): void {
  if (isBuiltin(id)) return;
  saveUserTemplates(loadUserTemplates().filter((k) => k.id !== id));
  if (getDefaultTemplateId() === id) setDefaultTemplateId(null);
}

export function getDefaultTemplateId(): string {
  if (typeof window === 'undefined') return 'builtin-omnikit';
  return window.localStorage.getItem(DEFAULT_SELECTION_KEY) || 'builtin-omnikit';
}

export function setDefaultTemplateId(id: string | null): void {
  if (typeof window === 'undefined') return;
  if (id) window.localStorage.setItem(DEFAULT_SELECTION_KEY, id);
  else window.localStorage.removeItem(DEFAULT_SELECTION_KEY);
}

export function resolveKitOrDefault(kitOrBrand: LayoutKit | BrandConfig | undefined): LayoutKit {
  if (!kitOrBrand) return getBuiltinTemplates()[0];
  if ('layouts' in kitOrBrand && Array.isArray(kitOrBrand.layouts)) return kitOrBrand;
  const brand = kitOrBrand as BrandConfig;
  return makeLayoutKit(`inline-${Date.now()}`, brand.name || 'Custom theme', brand, 'json');
}

export function layoutForRole(kit: LayoutKit, role: SlideRole): SlideLayout {
  return (
    kit.layouts.find((l) => l.role === role) ||
    kit.layouts.find((l) => l.role === 'content') ||
    defaultLayoutsForBrand(kit.brand)[1]
  );
}

export function estimateStorageUse(): { bytes: number; percentOfQuota: number } {
  if (typeof window === 'undefined') return { bytes: 0, percentOfQuota: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY) || '';
    return { bytes: raw.length * 2, percentOfQuota: Math.min(1, (raw.length * 2) / (5 * 1024 * 1024)) };
  } catch {
    return { bytes: 0, percentOfQuota: 0 };
  }
}
