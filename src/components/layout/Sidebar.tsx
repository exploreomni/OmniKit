import { Link, useLocation } from 'react-router';
import {
  ArrowRightLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileSearch,
  FolderCog,
  GitBranch,
  GraduationCap,
  House,
  Link2,
  Menu,
  Presentation,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';
import { InstanceSwitcher } from '@/components/layout/InstanceSwitcher';
import { useConnection } from '@/hooks/useConnection';
import { useWalkthrough } from '@/hooks/useWalkthrough';

interface NavItem {
  to: string;
  icon: ReactNode;
  label: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const sections: NavSection[] = [
  {
    label: 'Content & dashboards',
    items: [
      { to: '/content/ai-studio', icon: <Sparkles size={16} />, label: 'AI Content Studio' },
      { to: '/dashboards/migrate', icon: <ArrowRightLeft size={16} />, label: 'Dashboard Migrator' },
      { to: '/dashboards/operations', icon: <FolderCog size={16} />, label: 'Dashboard Operations' },
      { to: '/dashboards/downloads', icon: <Download size={16} />, label: 'Dashboard Downloads' },
      { to: '/deck-builder', icon: <Presentation size={16} />, label: 'Deck Builder' },
    ],
  },
  {
    label: 'Models & semantics',
    items: [
      { to: '/models/migrate', icon: <GitBranch size={16} />, label: 'Model Migrator' },
      { to: '/models', icon: <Database size={16} />, label: 'Model & Topic Health' },
      { to: '/topics', icon: <BookOpen size={16} />, label: 'AI Semantic Studio' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/admin/fleet', icon: <Server size={16} />, label: 'Fleet & Readiness' },
      { to: '/admin/identity', icon: <Users size={16} />, label: 'Identity & Access' },
      { to: '/admin/content', icon: <FileSearch size={16} />, label: 'Content Operations' },
      { to: '/admin/developer', icon: <Link2 size={16} />, label: 'Embed & Developer Tools' },
    ],
  },
];

const homeItem: NavItem = { to: '/', icon: <House size={16} />, label: 'Home' };
const historyItem: NavItem = { to: '/history', icon: <Clock size={16} />, label: 'History' };
const privacyItem: NavItem = { to: '/data-privacy', icon: <ShieldCheck size={16} />, label: 'Data & Privacy' };
const collapsedRailItems = [homeItem, ...sections.flatMap((section) => section.items), historyItem, privacyItem];

function routeMatches(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/';
  return pathname === to || pathname.startsWith(`${to}/`);
}

function navItemClassName(active: boolean): string {
  return `group flex min-h-9 w-full items-center gap-2.5 rounded-[5px] border-l-[3px] px-3 py-2 text-[13px] leading-5 tracking-normal transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-500 focus-visible:ring-offset-1 ${
    active
      ? 'border-l-omni-500 bg-omni-50 font-semibold text-omni-900'
      : 'border-l-transparent font-medium text-content-secondary hover:bg-surface-secondary hover:text-omni-900'
  }`;
}

function SidebarLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={navItemClassName(active)}
    >
      <span
        className={`shrink-0 transition-colors ${active ? 'text-omni-600' : 'text-content-tertiary group-hover:text-omni-700'}`}
        aria-hidden="true"
      >
        {item.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </Link>
  );
}

function CollapsedRailLink({
  item,
  active,
  inert,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  inert: boolean;
  onNavigate: () => void;
}) {
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!active || inert) return;
    linkRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, inert]);

  return (
    <Link
      ref={linkRef}
      to={item.to}
      onClick={onNavigate}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      tabIndex={inert ? -1 : undefined}
      title={item.label}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-400 focus-visible:ring-offset-2 focus-visible:ring-offset-omni-900 [&_svg]:h-[18px] [&_svg]:w-[18px] ${
        active
          ? 'bg-white/15 text-white'
          : 'text-white/65 hover:bg-white/10 hover:text-white'
      }`}
    >
      <span aria-hidden="true">{item.icon}</span>
      {active && (
        <span
          className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-omni-400"
          aria-hidden="true"
        />
      )}
    </Link>
  );
}

function SidebarSection({
  section,
  expandOnConnect,
  onNavigate,
}: {
  section: NavSection;
  expandOnConnect: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const sectionId = useId();
  const activeItem = section.items
    .filter((item) => routeMatches(location.pathname, item.to))
    .sort((left, right) => right.to.length - left.to.length)[0];
  const isActive = Boolean(activeItem);
  const [expanded, setExpanded] = useState(() => expandOnConnect || isActive);

  useEffect(() => {
    if (expandOnConnect) setExpanded(true);
  }, [expandOnConnect]);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={sectionId}
        className={`flex min-h-8 w-full items-center justify-between rounded-[4px] px-3 py-1.5 text-left text-[11px] font-semibold leading-4 tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-500 ${
          isActive ? 'text-omni-700' : 'text-content-tertiary hover:bg-surface-secondary hover:text-omni-900'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? 'bg-omni-500' : 'bg-border-strong'}`}
            aria-hidden="true"
          />
          <span className="truncate">{section.label}</span>
        </span>
        <span className="shrink-0" aria-hidden="true">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {expanded && (
        <div id={sectionId} className="space-y-0.5 px-1 pb-1 pt-0.5">
          {section.items.map((item) => (
            <SidebarLink
              key={item.to}
              item={item}
              active={activeItem?.to === item.to}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface SidebarContentProps {
  hasUpdate: boolean;
  host: string;
  isConnected: boolean;
  onNavigate?: () => void;
  onOpenGuide: () => void;
}

function SidebarContent({
  hasUpdate,
  host,
  isConnected,
  onNavigate,
  onOpenGuide,
}: SidebarContentProps) {
  const location = useLocation();
  const homeActive = routeMatches(location.pathname, '/');

  return (
    <>
      <div className="flex min-h-[68px] items-center border-b border-white/10 bg-omni-900 px-5 py-4">
        <OmniKitLogo variant="light" size="md" />
      </div>

      <div className="border-b border-border px-3 py-3">
        <Link
          to="/"
          onClick={onNavigate}
          aria-current={homeActive ? 'page' : undefined}
          className={navItemClassName(homeActive)}
        >
          <House
            size={16}
            className={`shrink-0 ${homeActive ? 'text-omni-600' : 'text-content-tertiary'}`}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 leading-4">
              <span>Home</span>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-border-strong'}`}
                aria-hidden="true"
              />
            </span>
            {isConnected && host && (
              <span className="mt-0.5 block truncate text-[10px] font-normal leading-4 text-content-tertiary">
                {host}
              </span>
            )}
          </span>
        </Link>
      </div>

      <InstanceSwitcher />

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-3" aria-label="Main sections">
        {sections.map((section) => (
          <SidebarSection
            key={section.label}
            section={section}
            expandOnConnect={isConnected}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <p className="mb-1 px-3 text-[11px] font-semibold leading-4 tracking-normal text-content-tertiary">
          Help & activity
        </p>
        <button
          type="button"
          onClick={onOpenGuide}
          className={`${navItemClassName(false)} mb-0.5 text-left`}
        >
          <GraduationCap size={16} className="shrink-0 text-content-tertiary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">Guide</span>
          {hasUpdate && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-omni-700">
              <span className="h-1.5 w-1.5 rounded-full bg-omni-500" aria-hidden="true" />
              New
            </span>
          )}
        </button>
        <div className="space-y-0.5">
          <SidebarLink
            item={historyItem}
            active={routeMatches(location.pathname, historyItem.to)}
            onNavigate={onNavigate}
          />
          <SidebarLink
            item={privacyItem}
            active={routeMatches(location.pathname, privacyItem.to)}
            onNavigate={onNavigate}
          />
        </div>
      </div>

      <div
        className="flex min-h-11 items-center gap-2.5 border-t border-border bg-surface-secondary px-5 py-2.5"
        role="status"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-border-strong'}`}
          aria-hidden="true"
        />
        <span className={`truncate text-[11px] font-medium ${isConnected ? 'text-emerald-700' : 'text-content-secondary'}`}>
          {isConnected ? 'Omni instance connected' : 'No Omni instance connected'}
        </span>
      </div>
    </>
  );
}

function useDesktopNavigation() {
  const [isDesktop, setIsDesktop] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(min-width: 1024px)').matches
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const mediaQuery = window.matchMedia('(min-width: 1024px)');
    const updateViewport = () => setIsDesktop(mediaQuery.matches);

    updateViewport();
    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  return isDesktop;
}

export function Sidebar() {
  const location = useLocation();
  const { connection, isConnected } = useConnection();
  const { openWalkthrough, hasUpdate } = useWalkthrough();
  const isDesktop = useDesktopNavigation();
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const host = connection.baseUrl ? connection.baseUrl.replace(/https?:\/\//, '').replace(/\/$/, '') : '';

  const closeMobileNavigation = useCallback(() => {
    setIsMobileNavigationOpen(false);
    menuButtonRef.current?.focus();
  }, []);

  const dismissMobileNavigation = useCallback(() => {
    setIsMobileNavigationOpen(false);
  }, []);

  const navigateFromMobileNavigation = useCallback(() => {
    setIsMobileNavigationOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus();
    });
  }, []);

  useEffect(() => {
    if (!isMobileNavigationOpen) return undefined;

    const drawer = drawerRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const frame = window.requestAnimationFrame(() => {
      drawer?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileNavigation();
        return;
      }

      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [closeMobileNavigation, isMobileNavigationOpen]);

  useEffect(() => {
    if (isDesktop && isMobileNavigationOpen) setIsMobileNavigationOpen(false);
  }, [isDesktop, isMobileNavigationOpen]);

  const openGuide = () => openWalkthrough('manual');

  if (isDesktop) {
    return (
      <aside
        className="sticky top-0 flex h-screen w-64 flex-shrink-0 flex-col overflow-hidden border-r border-border bg-surface-primary"
        aria-label="Main navigation"
      >
        <SidebarContent
          hasUpdate={hasUpdate}
          host={host}
          isConnected={isConnected}
          onOpenGuide={openGuide}
        />
      </aside>
    );
  }

  const openMobileGuide = () => {
    dismissMobileNavigation();
    openGuide();
  };

  const activeCollapsedRailItem = collapsedRailItems
    .filter((item) => routeMatches(location.pathname, item.to))
    .sort((left, right) => right.to.length - left.to.length)[0];

  return (
    <>
      <aside
        className="relative z-[60] flex h-screen w-12 flex-shrink-0 flex-col items-center overflow-hidden border-r border-white/10 bg-omni-900 py-3"
        aria-label="Collapsed navigation"
      >
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => {
            if (isMobileNavigationOpen) {
              closeMobileNavigation();
            } else {
              setIsMobileNavigationOpen(true);
            }
          }}
          aria-label={isMobileNavigationOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={isMobileNavigationOpen}
          aria-controls="mobile-navigation-drawer"
          aria-haspopup="dialog"
          className="flex h-10 w-10 items-center justify-center rounded-[6px] text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-400 focus-visible:ring-offset-2 focus-visible:ring-offset-omni-900"
          title={isMobileNavigationOpen ? 'Close navigation' : 'Open navigation'}
        >
          {isMobileNavigationOpen ? <X size={20} /> : <Menu size={20} />}
        </button>

        <nav
          className={`mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto px-0.5 py-1 ${isMobileNavigationOpen ? 'pointer-events-none' : ''}`}
          aria-label="Collapsed navigation shortcuts"
          aria-hidden={isMobileNavigationOpen}
        >
          <CollapsedRailLink
            item={homeItem}
            active={activeCollapsedRailItem?.to === homeItem.to}
            inert={isMobileNavigationOpen}
            onNavigate={navigateFromMobileNavigation}
          />

          {sections.map((section) => (
            <div
              key={section.label}
              className="flex w-full flex-col items-center gap-1 border-t border-white/10 pt-1"
              role="group"
              aria-label={section.label}
            >
              {section.items.map((item) => (
                <CollapsedRailLink
                  key={item.to}
                  item={item}
                  active={activeCollapsedRailItem?.to === item.to}
                  inert={isMobileNavigationOpen}
                  onNavigate={navigateFromMobileNavigation}
                />
              ))}
            </div>
          ))}

          <div
            className="flex w-full flex-col items-center gap-1 border-t border-white/10 pt-1"
            role="group"
            aria-label="Help and activity"
          >
            <button
              type="button"
              onClick={openMobileGuide}
              aria-label="Guide"
              tabIndex={isMobileNavigationOpen ? -1 : undefined}
              title="Guide"
              className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] text-white/65 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-omni-400 focus-visible:ring-offset-2 focus-visible:ring-offset-omni-900"
            >
              <GraduationCap size={18} aria-hidden="true" />
              {hasUpdate && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-omni-400" aria-hidden="true" />
              )}
            </button>
            <CollapsedRailLink
              item={historyItem}
              active={activeCollapsedRailItem?.to === historyItem.to}
              inert={isMobileNavigationOpen}
              onNavigate={navigateFromMobileNavigation}
            />
            <CollapsedRailLink
              item={privacyItem}
              active={activeCollapsedRailItem?.to === privacyItem.to}
              inert={isMobileNavigationOpen}
              onNavigate={navigateFromMobileNavigation}
            />
          </div>
        </nav>

        <div
          className="mt-2 flex h-10 w-10 shrink-0 items-center justify-center border-t border-white/10"
          role="status"
          aria-live="polite"
          title={isConnected ? 'Omni instance connected' : 'No Omni instance connected'}
        >
          <span className={`h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-white/40'}`} aria-hidden="true" />
          <span className="sr-only">{isConnected ? 'Omni instance connected' : 'No Omni instance connected'}</span>
        </div>
      </aside>

      {isMobileNavigationOpen && (
        <div
          className="fixed inset-0 z-40 bg-omni-900/25"
          aria-hidden="true"
          onClick={closeMobileNavigation}
        />
      )}

      <aside
        ref={drawerRef}
        id="mobile-navigation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Omni Kit navigation"
        aria-hidden={!isMobileNavigationOpen}
        tabIndex={-1}
        className={`${isMobileNavigationOpen ? 'flex' : 'hidden'} fixed inset-y-0 left-12 z-50 w-64 max-w-[calc(100vw-3rem)] flex-col overflow-hidden border-r border-border bg-surface-primary shadow-dropdown`}
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('a[href]')) {
            navigateFromMobileNavigation();
          }
        }}
      >
        <SidebarContent
          hasUpdate={hasUpdate}
          host={host}
          isConnected={isConnected}
          onOpenGuide={openMobileGuide}
        />
      </aside>
    </>
  );
}
