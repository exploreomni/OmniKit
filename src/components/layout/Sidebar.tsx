import { NavLink, useLocation } from 'react-router-dom';
import {
  ArrowRightLeft,
  FolderInput,
  Trash2,
  Users,
  Shield,
  Database,
  BookOpen,
  Link2,
  Clock,
  ShieldCheck,
  Plug,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Presentation,
  Cable,
  Calendar,
  Tag,
  FileUp,
} from 'lucide-react';
import { useState } from 'react';
import { useConnection } from '@/contexts/ConnectionContext';

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
    label: 'AI & Dashboards',
    items: [
      { to: '/dashboards/migrate', icon: <ArrowRightLeft size={15} />, label: 'Migrate' },
      { to: '/dashboards/bulk-move', icon: <FolderInput size={15} />, label: 'Bulk Move' },
      { to: '/dashboards/bulk-copy', icon: <Copy size={15} />, label: 'Bulk Copy' },
      { to: '/dashboards/bulk-delete', icon: <Trash2 size={15} />, label: 'Bulk Delete' },
      { to: '/dashboards/downloads', icon: <Download size={15} />, label: 'Downloads' },
      { to: '/deck-builder', icon: <Presentation size={15} />, label: 'Deck Builder' },
    ],
  },
  {
    label: 'Data Platform',
    items: [
      { to: '/connections', icon: <Cable size={15} />, label: 'Connections' },
      { to: '/uploads', icon: <FileUp size={15} />, label: 'Uploads' },
      { to: '/models', icon: <Database size={15} />, label: 'Models' },
      { to: '/topics', icon: <BookOpen size={15} />, label: 'Topics' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/labels', icon: <Tag size={15} />, label: 'Labels' },
      { to: '/schedules', icon: <Calendar size={15} />, label: 'Schedules' },
      { to: '/users', icon: <Users size={15} />, label: 'Users' },
      { to: '/groups', icon: <Shield size={15} />, label: 'Groups' },
      { to: '/embeds', icon: <Link2 size={15} />, label: 'Embed URLs' },
    ],
  },
];

function SidebarSection({ section }: { section: NavSection }) {
  const location = useLocation();
  const isActive = section.items.some((item) => location.pathname.startsWith(item.to));
  const [expanded, setExpanded] = useState(isActive);

  return (
    <div className="mb-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] transition-all duration-150"
        style={{ color: isActive ? '#C8186A' : 'rgba(155,48,101,0.5)' }}
      >
        <span className="flex items-center gap-2">
          {isActive && (
            <span
              className="w-1 h-3 rounded-full flex-shrink-0"
              style={{ background: '#E02C80' }}
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
                    : 'hover:bg-pink-50'
                }`
              }
              style={({ isActive }) =>
                isActive
                  ? {
                      background: 'linear-gradient(135deg, rgba(255,71,148,0.16) 0%, rgba(200,24,106,0.10) 100%)',
                      color: '#C8186A',
                      boxShadow: 'inset 0 1px 0 rgba(255,71,148,0.12)',
                      borderColor: '#E02C80',
                    }
                  : { color: '#7A2E52' }
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
  const host = connection.baseUrl ? connection.baseUrl.replace(/https?:\/\//, '').replace(/\/$/, '') : '';

  return (
    <aside
      className="w-56 flex flex-col flex-shrink-0 h-screen sticky top-0 overflow-hidden"
      aria-label="Main navigation"
      style={{
        background: 'linear-gradient(180deg, #FFFFFF 0%, #FFF5F9 100%)',
        borderRight: '1px solid rgba(255,71,148,0.15)',
      }}
    >
      <div
        className="px-4 py-4"
        style={{ borderBottom: '1px solid rgba(255,71,148,0.12)' }}
      >
        <div className="flex items-center gap-2.5">
          <img
            src="/omni-logo.webp"
            alt="Omni"
            className="h-6 w-auto object-contain"
          />
          <div className="h-4 w-px flex-shrink-0" style={{ background: 'rgba(200,24,106,0.2)' }} />
          <span className="font-semibold text-sm tracking-tight" style={{ color: '#1A0818' }}>OmniKit</span>
        </div>
      </div>

      <div
        className="px-2 py-2"
        style={{ borderBottom: '1px solid rgba(255,71,148,0.12)' }}
      >
        <NavLink
          to="/connect"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
              isActive
                ? 'font-semibold border-l-2'
                : 'hover:bg-pink-50'
            }`
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'linear-gradient(135deg, rgba(255,71,148,0.16) 0%, rgba(200,24,106,0.10) 100%)',
                  color: '#C8186A',
                  boxShadow: 'inset 0 1px 0 rgba(255,71,148,0.12)',
                  borderColor: '#E02C80',
                }
              : { color: '#9B3065' }
          }
        >
          <Plug size={15} className="flex-shrink-0 opacity-80" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 leading-none">
              <span>Connect</span>
              {isConnected ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"
                  style={{ boxShadow: '0 0 6px rgba(52, 211, 153, 0.8)' }}
                />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'rgba(200,24,106,0.2)' }} />
              )}
            </div>
            {isConnected && host && (
              <div className="text-[10px] truncate mt-0.5 leading-none" style={{ color: '#C8186A', opacity: 0.7 }}>{host}</div>
            )}
          </div>
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 space-y-2" aria-label="Main sections">
        {sections.map((section) => (
          <SidebarSection key={section.label} section={section} />
        ))}
      </nav>

      <div
        className="px-2 py-2"
        style={{ borderTop: '1px solid rgba(255,71,148,0.12)' }}
      >
        <div className="px-3 mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'rgba(155,48,101,0.5)' }}>Activity</span>
        </div>
        <NavLink
          to="/history"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
              isActive
                ? 'font-semibold border-l-2'
                : 'hover:bg-pink-50'
            }`
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'linear-gradient(135deg, rgba(255,71,148,0.16) 0%, rgba(200,24,106,0.10) 100%)',
                  color: '#C8186A',
                  boxShadow: 'inset 0 1px 0 rgba(255,71,148,0.12)',
                  borderColor: '#E02C80',
                }
              : { color: '#7A2E52' }
          }
        >
          <Clock size={15} className="flex-shrink-0 opacity-80" />
          History
        </NavLink>
        <NavLink
          to="/data-privacy"
          className={({ isActive }) =>
            `flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-[13px] transition-all duration-150 ${
              isActive ? 'font-semibold border-l-2' : 'hover:bg-pink-50'
            }`
          }
          style={({ isActive }) =>
            isActive
              ? {
                  background: 'linear-gradient(135deg, rgba(255,71,148,0.16) 0%, rgba(200,24,106,0.10) 100%)',
                  color: '#C8186A',
                  boxShadow: 'inset 0 1px 0 rgba(255,71,148,0.12)',
                  borderColor: '#E02C80',
                }
              : { color: '#7A2E52' }
          }
        >
          <ShieldCheck size={15} className="flex-shrink-0 opacity-80" />
          Data & Privacy
        </NavLink>
      </div>

      <div
        className="px-4 py-3 flex items-center gap-2.5"
        style={{ borderTop: '1px solid rgba(255,71,148,0.12)' }}
      >
        <span
          className="w-2 h-2 rounded-full flex-shrink-0 transition-all duration-300"
          style={
            isConnected
              ? { background: '#34d399', boxShadow: '0 0 6px rgba(52,211,153,0.7)' }
              : { background: 'rgba(200,24,106,0.3)' }
          }
        />
        <span className="text-[10px] truncate font-medium" style={{ color: isConnected ? 'rgba(16,110,62,0.75)' : 'rgba(155,48,101,0.55)' }}>
          {isConnected ? 'Connected & ready' : 'Not connected'}
        </span>
      </div>
    </aside>
  );
}
