import { NavLink, useLocation } from 'react-router-dom';
import {
  ArrowRightLeft,
  FolderCog,
  Users,
  Database,
  BookOpen,
  Link2,
  Clock,
  ShieldCheck,
  Plug,
  ChevronDown,
  ChevronRight,
  Download,
  Presentation,
  Sparkles,
  Cable,
  Calendar,
  Tag,
  FileUp,
  FileSearch,
  GraduationCap,
  Server,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useWalkthrough } from '@/hooks/useWalkthrough';
import { OmniKitLogo } from '@/components/brand/OmniKitLogo';

interface NavSection {
  label: string;
  items: Array<{
    to: string;
    icon: React.ReactNode;
    label: string;
  }>;
}

const sections: NavSection[] = [
  {
    label: 'Dashboard AI & Delivery',
    items: [
      { to: '/dashboards/ai-studio', icon: <Sparkles size={15} />, label: 'AI Dashboard Studio' },
      { to: '/dashboards/migrate', icon: <ArrowRightLeft size={15} />, label: 'Model Migrator' },
      { to: '/dashboards/operations', icon: <FolderCog size={15} />, label: 'Dashboard Operations' },
      { to: '/dashboards/downloads', icon: <Download size={15} />, label: 'Dashboard Downloads' },
      { to: '/deck-builder', icon: <Presentation size={15} />, label: 'Deck Builder' },
    ],
  },
  {
    label: 'Data & AI Readiness',
    items: [
      { to: '/instances', icon: <Server size={15} />, label: 'Instance Manager' },
      { to: '/connections', icon: <Cable size={15} />, label: 'Connection Health' },
      { to: '/uploads', icon: <FileUp size={15} />, label: 'Upload Governance' },
      { to: '/models', icon: <Database size={15} />, label: 'Model & Topic Health' },
      { to: '/content-health', icon: <FileSearch size={15} />, label: 'Content Health' },
      { to: '/topics', icon: <BookOpen size={15} />, label: 'AI Semantic Studio' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/labels', icon: <Tag size={15} />, label: 'Labels' },
      { to: '/schedules', icon: <Calendar size={15} />, label: 'Schedules' },
      { to: '/users', icon: <Users size={15} />, label: 'User Management' },
      { to: '/embeds', icon: <Link2 size={15} />, label: 'Embed URLs' },
    ],
  },
];

function SidebarSection({ section, expandOnConnect }: { section: NavSection; expandOnConnect: boolean }) {
  const location = useLocation();
  const isActive = section.items.some((item) => location.pathname.startsWith(item.to));
  const [expanded, setExpanded] = useState(() => expandOnConnect || isActive);

  useEffect(() => {
    if (expandOnConnect) setExpanded(true);
  }, [expandOnConnect]);

  useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
            className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-all duration-150"
        style={{ color: isActive ? '#C83B70' : '#697080' }}
      >
        <span className="flex items-center gap-2">
          {isActive && (
            <span
              className="w-1 h-3 rounded-full flex-shrink-0"
              style={{ background: '#C83B70' }}
            />
          )}
          {section.label}
        </span>
        <span className="opacity-70 flex-shrink-0">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
      </button>
      {expanded && (
        <div className="space-y-px px-2 pb-1">
          {section.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 group ${
                  isActive
                    ? 'font-semibold border-l-2'
                    : 'hover:bg-surface-secondary'
                }`
              }
              style={({ isActive }) =>
                isActive
	                  ? {
	                      background: '#F8F9FD',
	                      color: '#C83B70',
	                      boxShadow: 'none',
	                      borderColor: '#C83B70',
	                    }
	                  : { color: '#404754' }
              }
            >
              <span className="flex-shrink-0 opacity-80">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { connection, isConnected } = useConnection();
  const { openWalkthrough, hasUpdate } = useWalkthrough();
  const host = connection.baseUrl ? connection.baseUrl.replace(/https?:\/\//, '').replace(/\/$/, '') : '';

  return (
    <aside
      className="w-56 flex flex-col flex-shrink-0 h-screen sticky top-0 overflow-hidden"
      aria-label="Main navigation"
      style={{
        background: '#FFFFFF',
        borderRight: '1px solid rgba(217,222,232,0.95)',
      }}
    >
      <div
        className="px-4 py-4 flex justify-center"
        style={{ borderBottom: '1px solid rgba(217,222,232,0.95)' }}
      >
        <OmniKitLogo size="lg" />
      </div>

      <div
        className="px-2 py-2"
        style={{ borderBottom: '1px solid rgba(217,222,232,0.95)' }}
      >
        <NavLink
          to="/connect"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
              isActive
                ? 'font-semibold border-l-2'
	                : 'hover:bg-surface-secondary'
            }`
          }
          style={({ isActive }) =>
            isActive
	              ? {
	                  background: '#F8F9FD',
	                  color: '#C83B70',
	                  boxShadow: 'none',
	                  borderColor: '#C83B70',
	                }
	              : { color: '#404754' }
          }
        >
          <Plug size={15} className="flex-shrink-0 opacity-80" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 leading-none">
              <span>Connect</span>
              {isConnected ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"
	                  style={{ boxShadow: 'none' }}
                />
              ) : (
	                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-border-strong" />
              )}
            </div>
            {isConnected && host && (
	              <div className="text-[10px] truncate mt-0.5 leading-none" style={{ color: '#697080' }}>{host}</div>
            )}
          </div>
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 space-y-2" aria-label="Main sections">
        {sections.map((section) => (
          <SidebarSection key={section.label} section={section} expandOnConnect={isConnected} />
        ))}
      </nav>

      <div
        className="px-2 py-2"
        style={{ borderTop: '1px solid rgba(217,222,232,0.95)' }}
      >
        <div className="px-3 mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: '#697080' }}>Activity</span>
        </div>
        <button
          type="button"
          onClick={() => openWalkthrough('manual')}
          className="mb-1 flex w-full items-center gap-2.5 rounded-[6px] px-3 py-2 text-left text-[13px] transition-all duration-150 hover:bg-surface-secondary"
          style={{ color: '#404754' }}
        >
          <GraduationCap size={15} className="flex-shrink-0 opacity-80" />
          <span className="flex-1">Guide</span>
          {hasUpdate && (
            <span className="rounded-chip bg-omni-600 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
              New
            </span>
          )}
        </button>
        <NavLink
          to="/history"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
              isActive
                ? 'font-semibold border-l-2'
	                : 'hover:bg-surface-secondary'
            }`
          }
          style={({ isActive }) =>
            isActive
	              ? {
	                  background: '#F8F9FD',
	                  color: '#C83B70',
	                  boxShadow: 'none',
	                  borderColor: '#C83B70',
	                }
	              : { color: '#404754' }
          }
        >
          <Clock size={15} className="flex-shrink-0 opacity-80" />
          History
        </NavLink>
        <NavLink
          to="/data-privacy"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
	            isActive ? 'font-semibold border-l-2' : 'hover:bg-surface-secondary'
            }`
          }
          style={({ isActive }) =>
            isActive
	              ? {
	                  background: '#F8F9FD',
	                  color: '#C83B70',
	                  boxShadow: 'none',
	                  borderColor: '#C83B70',
	                }
	              : { color: '#404754' }
          }
        >
          <ShieldCheck size={15} className="flex-shrink-0 opacity-80" />
          Data & Privacy
        </NavLink>
      </div>

      <div
        className="px-4 py-3 flex items-center gap-2.5"
        style={{ borderTop: '1px solid rgba(217,222,232,0.95)' }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0 transition-all duration-300"
          style={
            isConnected
              ? { background: '#34d399', boxShadow: 'none' }
              : { background: '#C7CEDB' }
          }
        />
        <span className="text-[10px] truncate font-medium" style={{ color: isConnected ? '#047857' : '#697080' }}>
          {isConnected ? 'Connected & ready' : 'Not connected'}
        </span>
      </div>
    </aside>
  );
}
